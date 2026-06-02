import type { Telegraf } from "telegraf";
import { Markup, message } from "telegraf/filters";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { extractAllPrUrls, parsePrInfo } from "../utils/url-parser.js";
import type { PrQueue } from "../queue/pr-queue.js";
import type { AWSBrowser } from "../aws/browser.js";
import type { PrInfo } from "../types.js";
import type { PRAnalysis } from "../types/ai.types.js";
import { isAuthorized, sendApprovalRequest, sendToTopic } from "./helpers.js";
import { analyzePR } from "../ai/pr-analyzer.js";

const APPROVE_WORDS = ["si", "sí", "autorizar"];
const REJECT_WORDS = ["no", "denegar"];

/** Registra los handlers de botones inline y mensajes de texto */
export function registerHandlers(bot: Telegraf, queue: PrQueue, awsBrowser?: AWSBrowser): void {
  // ── Botones inline ──
  bot.action(/^approve:(\d+)$/, async (ctx) => {
    const prNumber = ctx.match[1];
    const username = ctx.from?.username;

    if (!isAuthorized(username)) {
      await ctx.answerCbQuery("⛔ No estás autorizado para aprobar PRs.");
      return;
    }

    const item = queue.approve(prNumber, username ?? "unknown");
    if (item) {
      await ctx.answerCbQuery(`✅ PR #${prNumber} aprobado`);
      const original = ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.text : "";
      await ctx.editMessageText(
        original + `\n\n✅ *Aprobado por @${username}*`,
        { parse_mode: "Markdown" },
      );
      if (queue.currentItem) {
        await sendToTopic(bot.telegram,
          ctx.callbackQuery.message?.chat.id ?? config.telegram.chatId,
          `📋 PR #${prNumber} aprobado, en cola (procesando PR #${queue.currentItem.prNumber})`,
        );
      }
    } else {
      await ctx.answerCbQuery(`⚠️ PR #${prNumber} ya no está esperando aprobación.`);
    }
  });

  bot.action(/^reject:(\d+)$/, async (ctx) => {
    const prNumber = ctx.match[1];
    const username = ctx.from?.username;

    if (!isAuthorized(username)) {
      await ctx.answerCbQuery("⛔ No estás autorizado para rechazar PRs.");
      return;
    }

    const item = queue.reject(prNumber, username ?? "unknown");
    if (item) {
      await ctx.answerCbQuery(`🚫 PR #${prNumber} rechazado`);
      const original = ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.text : "";
      await ctx.editMessageText(
        original + `\n\n🚫 *Rechazado por @${username}*`,
        { parse_mode: "Markdown" },
      );
    } else {
      await ctx.answerCbQuery(`⚠️ PR #${prNumber} ya no está esperando aprobación.`);
    }
  });

  // ── Mensajes de texto (detección de URLs y comandos por texto) ──
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text.trim();
    const chatType = ctx.chat.type;

    if (chatType === "private") return;
    if (config.telegram.topicId && ctx.message.message_thread_id !== config.telegram.topicId) return;

    // 1. Respuesta de aprobación/rechazo por texto
    const textLower = text.toLowerCase();
    const prNumberMatch = textLower.match(/#?(\d{4,})/);
    const commandPart = textLower.replace(/#?\d+/g, "").trim();
    const firstWord = commandPart.split(/\s+/)[0];
    const isApprove = APPROVE_WORDS.includes(firstWord);
    const isReject = REJECT_WORDS.includes(firstWord);
    const isExactCommand = commandPart === firstWord;

    if ((isApprove || isReject) && isExactCommand) {
      if (!isAuthorized(ctx.from?.username)) {
        await sendToTopic(bot.telegram, ctx.chat.id,
          `⛔ @${ctx.from?.username ?? "usuario"} no autorizado.`);
        return;
      }

      const awaiting = queue.awaitingApproval;
      if (awaiting.length === 0) return;

      let targetPrNumber: string | null = null;
      if (prNumberMatch) {
        targetPrNumber = prNumberMatch[1];
      } else if (awaiting.length === 1) {
        targetPrNumber = awaiting[0].prNumber;
      } else {
        const list = awaiting.map((p) => `  • PR #${p.prNumber} (${p.repo})`).join("\n");
        await sendToTopic(bot.telegram, ctx.chat.id,
          `⚠️ Hay ${awaiting.length} PRs pendientes:\n${list}\n\nEspecifica: *si #NUMERO*`);
        return;
      }

      const username = ctx.from?.username ?? "unknown";
      if (isApprove) {
        const item = queue.approve(targetPrNumber, username);
        if (!item) {
          await sendToTopic(bot.telegram, ctx.chat.id, `⚠️ PR #${targetPrNumber} no está pendiente.`);
        }
      } else {
        const item = queue.reject(targetPrNumber, username);
        if (item) {
          await sendToTopic(bot.telegram, ctx.chat.id,
            `🚫 PR #${targetPrNumber} *rechazado* por @${username}`);
        }
      }
      return;
    }

    // 2. Detectar URLs de PR
    const prUrls = extractAllPrUrls(text);
    if (prUrls.length === 0) return;

    const parsed: PrInfo[] = [];
    for (const url of prUrls) {
      const info = parsePrInfo(url);
      if (info) parsed.push(info);
    }
    if (parsed.length === 0) return;

    logger.info(`${parsed.length} PR(s) detectados en mensaje`);

    const added: PrInfo[] = [];
    const duplicates: PrInfo[] = [];

    for (const prInfo of parsed) {
      const wasAdded = queue.enqueue({
        url: prInfo.url, repo: prInfo.repo, prNumber: prInfo.prNumber, chatId: ctx.chat.id, requestedBy: ctx.from?.username,
      });
      if (wasAdded) added.push(prInfo);
      else duplicates.push(prInfo);
    }

    for (const prInfo of added) {
      await sendApprovalWithAnalysis(bot, ctx.chat.id, prInfo, awsBrowser);
    }

    if (duplicates.length > 0) {
      await sendToTopic(bot.telegram, ctx.chat.id,
        `ℹ️ Ya en cola: ${duplicates.map((p) => `PR #${p.prNumber}`).join(", ")}`);
    }
  });
}

/**
 * Envía mensaje de aprobación con análisis de IA.
 * 1. Si IA habilitada: envía mensaje temporal → analiza → edita con resultado
 * 2. Si IA deshabilitada o falla: envía el mensaje estándar de aprobación
 */
async function sendApprovalWithAnalysis(
  bot: Telegraf,
  chatId: number | string,
  prInfo: PrInfo,
  awsBrowser?: AWSBrowser,
): Promise<void> {
  // Si IA no está habilitada o no hay browser, enviar mensaje estándar
  if (!config.ai.enabled || !awsBrowser) {
    await sendApprovalRequest(bot.telegram, chatId, prInfo);
    return;
  }

  // Enviar mensaje temporal
  let tempMessage: { message_id: number } | undefined;
  try {
    tempMessage = await bot.telegram.sendMessage(
      chatId,
      `⏳ *Analizando PR #${prInfo.prNumber}...*\n📦 Repo: \`${prInfo.repo}\``,
      {
        parse_mode: "Markdown",
        message_thread_id: config.telegram.topicId,
      },
    );
  } catch (e: unknown) {
    logger.warn(`[AI] Error enviando mensaje temporal: ${e}`);
    await sendApprovalRequest(bot.telegram, chatId, prInfo);
    return;
  }

  // Intentar análisis con IA
  let analysis: PRAnalysis | null = null;
  try {
    await awsBrowser.ensureStarted();
    const page = awsBrowser.getPage();
    if (page) {
      analysis = await analyzePR(page, prInfo.url);
    }
  } catch (e: unknown) {
    logger.warn(`[AI] Error en análisis, usando fallback: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Editar mensaje con resultado
  const messageText = analysis
    ? formatEnrichedMessage(prInfo, analysis)
    : formatStandardMessage(prInfo);

  try {
    await bot.telegram.editMessageText(
      chatId,
      tempMessage.message_id,
      undefined,
      messageText,
      {
        parse_mode: "Markdown",
        ...({ message_thread_id: config.telegram.topicId } as Record<string, unknown>),
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Aprobar", callback_data: `approve:${prInfo.prNumber}` },
            { text: "❌ Rechazar", callback_data: `reject:${prInfo.prNumber}` },
          ]],
        },
      },
    );
  } catch (e: unknown) {
    logger.warn(`[AI] Error editando mensaje, enviando nuevo: ${e}`);
    await sendApprovalRequest(bot.telegram, chatId, prInfo);
  }
}

/** Formatea el mensaje enriquecido con análisis de IA */
function formatEnrichedMessage(prInfo: PrInfo, analysis: PRAnalysis): string {
  let msg = `🔍 *PR detectado*\n\`${prInfo.repo}\` → PR #${prInfo.prNumber}\n\n`;

  msg += `📋 *Resumen IA:*\n${analysis.summary}\n\n`;

  if (analysis.changes.length > 0) {
    msg += `📁 *Cambios principales:*\n`;
    for (const change of analysis.changes) {
      msg += `• ${change}\n`;
    }
    msg += "\n";
  }

  if (analysis.risks.length > 0) {
    msg += `⚠️ *Riesgos detectados:*\n`;
    for (const risk of analysis.risks) {
      msg += `• ${risk}\n`;
    }
    msg += "\n";
  }

  msg += `⁉ ¿Aprobar este PR?`;
  return msg;
}

/** Formatea el mensaje estándar (sin IA) */
function formatStandardMessage(prInfo: PrInfo): string {
  return (
    `🔔 *Solicitud de aprobación*\n\n` +
    `📦 Repo: \`${prInfo.repo}\`\n` +
    `🔢 PR #: \`${prInfo.prNumber}\`\n\n` +
    `Antes de Aprobar se recomienda validar:\n` +
    `▸ Ramas del PR (init-dev, dev-qa, qa-master)\n` +
    `▸ Quien manda el PR\n` +
    `▸ Cambios incluidos\n\n` +
    `⁉ ¿Aprobar este PR?`
  );
}

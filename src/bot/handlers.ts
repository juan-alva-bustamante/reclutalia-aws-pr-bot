import type { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { extractAllPrUrls, parsePrInfo } from "../utils/url-parser.js";
import type { PrQueue } from "../queue/pr-queue.js";
import type { AWSBrowser } from "../aws/browser.js";
import type { PrInfo } from "../types.js";
import type { PRAnalysis } from "../types/ai.types.js";
import { isAuthorized, sendApprovalRequest, sendToTopic, escapeTelegramMarkdown } from "./helpers.js";

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
    const queued: PrInfo[] = [];
    const duplicates: PrInfo[] = [];

    const isBusy = awsBrowser?.isBusy() ?? false;

    for (const prInfo of parsed) {
      const wasAdded = queue.enqueue({
        url: prInfo.url, repo: prInfo.repo, prNumber: prInfo.prNumber, chatId: ctx.chat.id, requestedBy: ctx.from?.username,
      }, isBusy);
      if (wasAdded) {
        if (isBusy) queued.push(prInfo);
        else added.push(prInfo);
      } else {
        duplicates.push(prInfo);
      }
    }

    // PRs que pueden analizarse ahora (browser libre)
    for (const prInfo of added) {
      // Fire-and-forget: NO await para no bloquear el handler de Telegraf.
      // Si bloqueamos aquí, el MFA por DM nunca se procesa (deadlock de polling).
      sendApprovalWithAnalysis(bot, ctx.chat.id, prInfo, queue, awsBrowser).catch((e: unknown) => {
        logger.error(`[AI] Error no manejado en análisis de PR #${prInfo.prNumber}: ${e}`);
      });
    }

    // PRs encolados porque el browser está ocupado — solo mensaje informativo
    if (queued.length > 0) {
      const currentPr = queue.currentItem;
      const queuedList = queued.map((p) => `• PR #${p.prNumber} (\`${p.repo}\`)`).join("\n");
      await sendToTopic(bot.telegram, ctx.chat.id,
        `📋 *PR(s) detectado(s) y encolado(s):*\n${queuedList}\n\n` +
        `⏳ Procesando PR #${currentPr?.prNumber ?? "?"} — se analizarán cuando termine.`,
      );
    }

    if (duplicates.length > 0) {
      await sendToTopic(bot.telegram, ctx.chat.id,
        `ℹ️ Ya en cola: ${duplicates.map((p) => `PR #${p.prNumber}`).join(", ")}`);
    }
  });
}

/**
 * Envía mensaje de aprobación con análisis de IA.
 * Flujo:
 * 1. Envía mensaje temporal "⏳ Obteniendo resumen IA..."
 * 2. Emite evento WS para el widget
 * 3. Login si necesario → scrape → Ollama
 * 4. Borra mensaje temporal
 * 5. Envía mensaje de aprobación (con resumen IA, solo archivos, o estándar)
 *
 * Si IA deshabilitada o login falla: envía directo el mensaje estándar con botones.
 */
async function sendApprovalWithAnalysis(
  bot: Telegraf,
  chatId: number | string,
  prInfo: PrInfo,
  queue: PrQueue,
  awsBrowser?: AWSBrowser,
): Promise<void> {
  // Si IA no está habilitada o no hay browser, enviar mensaje estándar directo
  if (!config.ai.enabled || !awsBrowser) {
    await sendApprovalRequest(bot.telegram, chatId, prInfo);
    return;
  }

  // 1. Mensaje temporal
  let tempMessage: { message_id: number } | undefined;
  try {
    tempMessage = await bot.telegram.sendMessage(
      chatId,
      `⏳ *Obteniendo resumen IA para PR #${prInfo.prNumber}...*\n📦 Repo: \`${prInfo.repo}\``,
      {
        parse_mode: "Markdown",
        message_thread_id: config.telegram.topicId,
      },
    );
  } catch (e: unknown) {
    logger.warn(`[AI] Error enviando mensaje temporal: ${e}`);
  }

  // 2. Emitir evento WS para el widget
  const { prEmitter } = await import("../ws/pr-emitter.js");
  prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_login", "in_progress");

  // 3. Intentar análisis
  let analysis: PRAnalysis | null = null;
  let filesChanged: string[] = [];

  try {
    // Marcar browser como ocupado durante el scraping IA
    awsBrowser.setBusy(true);

    // Login si necesario
    await awsBrowser.ensureStarted();
    const page = awsBrowser.getPage();

    if (!page) {
      prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_login", "error", "No se pudo obtener página");
      throw new Error("No se pudo obtener página del browser");
    }

    // Verificar sesión / login
    const { isLoggedIn, login, saveSession } = await import("../aws/auth.js");
    if (!(await isLoggedIn(page))) {
      logger.info("[AI] Sesión no activa, haciendo login para scraping...");
      const loginOk = await login(page, awsBrowser.onMfaRequired);
      if (!loginOk) {
        prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_login", "error", "Login falló");
        throw new Error("Login falló para scraping de diff");
      }
      const ctx = awsBrowser.getContext();
      if (ctx) await saveSession(ctx);
    }
    prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_login", "done");

    // Scraping del diff
    prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_scraping", "in_progress");
    const { scrapeDiff } = await import("../ai/diff-scraper.js");
    const diffResult = await scrapeDiff(page, prInfo.url);
    filesChanged = diffResult.filesChanged;
    prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_scraping", "done");

    // Análisis con Ollama (solo si hay contenido)
    if (diffResult.content && diffResult.content.trim().length > 0) {
      prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_analyzing", "in_progress");
      const { buildPRAnalysisPrompt } = await import("../ai/prompt-builder.js");
      const { callOllama } = await import("../ai/llm-client.js");
      const { parseLLMResponse } = await import("../ai/response-parser.js");

      const prompt = buildPRAnalysisPrompt(diffResult.content, filesChanged);
      const rawResponse = await callOllama(prompt, config.ai.ollama);
      analysis = parseLLMResponse(rawResponse);
      prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_analyzing", "done");
    } else {
      logger.warn("[AI] Diff vacío, solo se mostrarán archivos");
    }

  } catch (e: unknown) {
    logger.warn(`[AI] Error en análisis: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // Liberar el browser para que otros PRs o el merge puedan usarlo
    awsBrowser.setBusy(false);
  }

  // 4. Borrar mensaje temporal
  if (tempMessage) {
    try {
      await bot.telegram.deleteMessage(chatId, tempMessage.message_id);
    } catch (e: unknown) {
      logger.warn(`[AI] No se pudo borrar mensaje temporal: ${e}`);
    }
  }

  // 5. Emitir resultado al widget
  prEmitter.aiResult(
    prInfo.prNumber,
    prInfo.repo,
    analysis !== null,
    analysis?.summary,
    filesChanged,
  );

  // 5.1 Guardar resumen IA en la cola (para la bitácora)
  if (analysis?.summary) {
    logger.info(`[AI] 📝 Resumen: ${analysis.summary}`);
    if (analysis.changes.length > 0) logger.info(`[AI] 📁 Cambios: ${analysis.changes.join(", ")}`);
    if (analysis.risks.length > 0) logger.info(`[AI] ⚠️ Riesgos: ${analysis.risks.join(", ")}`);
    queue.setAiSummary(prInfo.prNumber, analysis.summary);
  }

  // 6. Enviar mensaje de aprobación con el contenido que se tenga
  const messageText = analysis
    ? formatEnrichedMessage(prInfo, analysis)
    : filesChanged.length > 0
      ? formatFilesOnlyMessage(prInfo, filesChanged)
      : formatStandardMessage(prInfo);

  try {
    await bot.telegram.sendMessage(
      chatId,
      messageText,
      {
        parse_mode: "Markdown",
        message_thread_id: config.telegram.topicId,
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Aprobar", callback_data: `approve:${prInfo.prNumber}` },
            { text: "❌ Rechazar", callback_data: `reject:${prInfo.prNumber}` },
          ]],
        },
      },
    );
  } catch (e: unknown) {
    logger.warn(`[AI] Error enviando mensaje enriquecido con Markdown: ${e}`);
    // Reintentar sin Markdown
    try {
      await bot.telegram.sendMessage(
        chatId,
        messageText.replace(/[*`_\\]/g, ""),
        {
          message_thread_id: config.telegram.topicId,
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Aprobar", callback_data: `approve:${prInfo.prNumber}` },
              { text: "❌ Rechazar", callback_data: `reject:${prInfo.prNumber}` },
            ]],
          },
        },
      );
    } catch (e2: unknown) {
      logger.warn(`[AI] Error enviando sin formato, usando fallback estándar: ${e2}`);
      await sendApprovalRequest(bot.telegram, chatId, prInfo);
    }
  }
}

/** Formatea el mensaje enriquecido con análisis de IA */
function formatEnrichedMessage(prInfo: PrInfo, analysis: PRAnalysis): string {
  let msg = `🔍 *PR detectado*\n\`${prInfo.repo}\` → PR #${prInfo.prNumber}\n\n`;

  msg += `📋 *Resumen IA:*\n${escapeTelegramMarkdown(analysis.summary)}\n\n`;

  if (analysis.changes.length > 0) {
    msg += `📁 *Cambios principales:*\n`;
    for (const change of analysis.changes) {
      msg += `• ${escapeTelegramMarkdown(change)}\n`;
    }
    msg += "\n";
  }

  if (analysis.risks.length > 0) {
    msg += `⚠️ *Riesgos detectados:*\n`;
    for (const risk of analysis.risks) {
      msg += `• ${escapeTelegramMarkdown(risk)}\n`;
    }
    msg += "\n";
  }

  msg += `⁉ ¿Aprobar este PR?`;
  return msg;
}

/** Formatea mensaje con solo los archivos modificados (fallback cuando IA falla) */
function formatFilesOnlyMessage(prInfo: PrInfo, files: string[]): string {
  let msg = `🔍 *PR detectado*\n\`${prInfo.repo}\` → PR #${prInfo.prNumber}\n\n`;

  msg += `📁 *Archivos modificados (${files.length}):*\n`;
  // Limitar a 15 archivos para no saturar el mensaje
  const displayFiles = files.slice(0, 15);
  for (const file of displayFiles) {
    msg += `• \`${file}\`\n`;
  }
  if (files.length > 15) {
    msg += `• _...y ${files.length - 15} más_\n`;
  }
  msg += "\n";

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

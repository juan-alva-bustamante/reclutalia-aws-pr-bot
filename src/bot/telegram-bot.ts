import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { extractAllPrUrls, parsePrInfo } from "../utils/url-parser.js";
import { PrQueue } from "../queue/pr-queue.js";
import { logPrResult, getRecentLogs } from "../queue/pr-log.js";
import type { AWSBrowser } from "../aws/browser.js";
import type { PrInfo, QueueItem } from "../types.js";

const APPROVE_WORDS = ["si", "sí", "autorizar"];
const REJECT_WORDS = ["no", "denegar"];

async function sendToTopic(
  telegram: Telegraf["telegram"],
  chatId: number | string,
  text: string,
  parseMode: "Markdown" | "MarkdownV2" = "Markdown",
): Promise<void> {
  await telegram.sendMessage(chatId, text, {
    parse_mode: parseMode,
    message_thread_id: config.telegram.topicId,
  });
}

function isAuthorized(username: string | undefined): boolean {
  if (!username) return false;
  return config.telegram.authorizedUsers.some(
    (u) => u === username.toLowerCase(),
  );
}

async function sendApprovalRequest(
  telegram: Telegraf["telegram"],
  chatId: number | string,
  prInfo: PrInfo,
): Promise<void> {
  await telegram.sendMessage(
    chatId,
    `🔔 *Solicitud de aprobación*\n\n` +
      `📦 Repo: \`${prInfo.repo}\`\n` +
      `🔢 PR #: \`${prInfo.prNumber}\`\n\n` +
      `Antes de Aprobar se recomienda validar:\n` +
      `▸ Ramas del PR (init-dev, dev-qa, qa-master)\n` +
      `▸ Quien manda el PR\n` +
      `▸ Cambios incluidos\n\n` +
      `⁉ ¿Aprobar este PR?`,
    {
      parse_mode: "Markdown",
      message_thread_id: config.telegram.topicId,
      ...Markup.inlineKeyboard([
        Markup.button.callback("✅ Aprobar", `approve:${prInfo.prNumber}`),
        Markup.button.callback("❌ Rechazar", `reject:${prInfo.prNumber}`),
      ]),
    },
  );
}

export function createBot(awsBrowser: AWSBrowser): Telegraf {
  const bot = new Telegraf(config.telegram.token);
  const queue = new PrQueue();

  // ── Procesador: solo 2 mensajes (procesando + resultado) ──
  queue.setProcessor(async (item: QueueItem) => {
    const prInfo: PrInfo = { repo: item.repo, prNumber: item.prNumber, url: item.url };
    const startedAt = new Date().toISOString();
    const approver = item.approvedBy?.toLowerCase();
    const authorInfo = approver ? config.userProfiles[approver] : undefined;

    // Mensaje 2: Procesando
    await sendToTopic(bot.telegram, item.chatId,
      `⏳ *Procesando PR #${prInfo.prNumber}*\n` +
        `📦 Repo: \`${prInfo.repo}\`\n` +
        `👤 Aprobado por: @${item.approvedBy ?? "unknown"}` +
        (authorInfo ? ` (${authorInfo.name})` : ""),
    );

    const result = await awsBrowser.fullPrFlow(item.url, authorInfo);
    const finishedAt = new Date().toISOString();

    logPrResult({
      prNumber: prInfo.prNumber, repo: prInfo.repo, url: item.url,
      status: result.success ? "success" : "error",
      steps: result.steps, error: result.error,
      startedAt, finishedAt,
      approvedBy: item.approvedBy,
      authorName: authorInfo?.name, authorEmail: authorInfo?.email,
    });

    logger.info("[Bot] Cerrando browser después de procesar PR");
    await awsBrowser.close();

    // Mensaje 3: Resultado
    if (result.success) {
      await sendToTopic(bot.telegram, item.chatId,
        `✅ *PR #${prInfo.prNumber} mergeado exitosamente*\n` +
          `📦 Repo: \`${prInfo.repo}\`\n` +
          `👤 Por: @${item.approvedBy ?? "unknown"}`,
      );
      await bot.telegram.sendMessage(config.telegram.ownerUserId,
        `✅ PR #${prInfo.prNumber} del repo \`${prInfo.repo}\` mergeado por @${item.approvedBy ?? "unknown"}.`,
        { parse_mode: "Markdown" },
      );
    } else {
      await sendToTopic(bot.telegram, item.chatId,
        `❌ *Error en PR #${prInfo.prNumber}*\n` +
          `📦 Repo: \`${prInfo.repo}\`\n` +
          `*Error:* \`${result.error}\`\n\n` +
          `⚠️ Revisa manualmente: ${item.url}`,
      );
      throw new Error(result.error);
    }

    // Solo si hay más PRs aprobados en cola
    if (queue.pendingCount > 0) {
      await sendToTopic(bot.telegram, item.chatId,
        `📋 ${queue.pendingCount} PR(s) en cola, procesando siguiente...`,
      );
    }
  });

  // ── Botones inline: solo editan el mensaje original, no envían nuevo ──
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
      // Si hay otro PR procesándose, notificar que este queda en cola
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

  // ── Comandos ──
  bot.command("status", async (ctx) => {
    await ctx.reply(
      `🤖 *Bot de PR Autorización*\n\n✅ Activo\n\n*Cola:*\n${queue.getSummary()}\n\n` +
        `/status /queue /log /pr <url>`,
      { parse_mode: "Markdown", message_thread_id: config.telegram.topicId },
    );
  });

  bot.command("queue", async (ctx) => {
    await ctx.reply(`📋 *Cola de PRs*\n\n${queue.getSummary()}`, {
      parse_mode: "Markdown", message_thread_id: config.telegram.topicId,
    });
  });

  bot.command("log", async (ctx) => {
    await ctx.reply(`📒 *Bitácora (últimos 5)*\n\n\`\`\`\n${getRecentLogs(5)}\n\`\`\``, {
      parse_mode: "Markdown", message_thread_id: config.telegram.topicId,
    });
  });

  bot.command("pr", async (ctx) => {
    if (!isAuthorized(ctx.from?.username)) {
      await ctx.reply("⛔ No tienes permisos."); return;
    }
    const url = ctx.message.text.split(" ")[1];
    if (!url) { await ctx.reply("Uso: /pr <url>"); return; }
    const prInfo = parsePrInfo(url);
    if (!prInfo) { await ctx.reply("❌ URL no válida."); return; }

    const added = queue.enqueue({ url: prInfo.url, repo: prInfo.repo, prNumber: prInfo.prNumber, chatId: ctx.chat.id });
    if (added) {
      await sendApprovalRequest(bot.telegram, ctx.chat.id, prInfo);
    } else {
      await ctx.reply(`ℹ️ PR #${prInfo.prNumber} ya está en cola.`);
    }
  });

  // ── Listener de mensajes (texto) ──
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
        // No envía mensaje extra — el procesador ya envía "Procesando"
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
        url: prInfo.url, repo: prInfo.repo, prNumber: prInfo.prNumber, chatId: ctx.chat.id,
      });
      if (wasAdded) added.push(prInfo);
      else duplicates.push(prInfo);
    }

    for (const prInfo of added) {
      await sendApprovalRequest(bot.telegram, ctx.chat.id, prInfo);
    }

    if (duplicates.length > 0) {
      await sendToTopic(bot.telegram, ctx.chat.id,
        `ℹ️ Ya en cola: ${duplicates.map((p) => `PR #${p.prNumber}`).join(", ")}`);
    }
  });

  return bot;
}

import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { extractAllPrUrls, parsePrInfo } from "../utils/url-parser.js";
import { PrQueue } from "../queue/pr-queue.js";
import { logPrResult, getRecentLogs } from "../queue/pr-log.js";
import type { AWSBrowser } from "../aws/browser.js";
import type { PrInfo, QueueItem } from "../types.js";

/** Helper to send a message to the configured topic (if any) */
async function sendToTopic(
  telegram: Telegraf["telegram"],
  chatId: number | string,
  text: string,
  parseMode?: "Markdown" | "MarkdownV2",
): Promise<void> {
  await telegram.sendMessage(chatId, text, {
    parse_mode: parseMode,
    message_thread_id: config.telegram.topicId,
  });
}

export function createBot(awsBrowser: AWSBrowser): Telegraf {
  const bot = new Telegraf(config.telegram.token);
  const queue = new PrQueue();

  // Configurar el procesador de la cola
  queue.setProcessor(async (item: QueueItem) => {
    const prInfo: PrInfo = {
      repo: item.repo,
      prNumber: item.prNumber,
      url: item.url,
    };
    const startedAt = new Date().toISOString();

    await sendToTopic(
      bot.telegram,
      item.chatId,
      `▶️ *Procesando PR \\#${prInfo.prNumber}*\n` +
        `📦 Repo: \`${prInfo.repo}\`\n\n` +
        `⏳ Iniciando proceso de autorización\\.\\.\\.`,
      "MarkdownV2",
    );

    const result = await awsBrowser.fullPrFlow(item.url);
    const finishedAt = new Date().toISOString();

    // Registrar en bitácora
    logPrResult({
      prNumber: prInfo.prNumber,
      repo: prInfo.repo,
      url: item.url,
      status: result.success ? "success" : "error",
      steps: result.steps,
      error: result.error,
      startedAt,
      finishedAt,
    });

    // Cerrar browser al terminar este PR
    logger.info("[Bot] Cerrando browser después de procesar PR");
    await awsBrowser.close();

    if (result.success) {
      const stepsText = result.steps.join("\n");
      await sendToTopic(
        bot.telegram,
        item.chatId,
        `✅ *PR procesado exitosamente*\n\n` +
          `📦 Repo: \`${prInfo.repo}\`\n` +
          `🔢 PR #: \`${prInfo.prNumber}\`\n\n` +
          `*Pasos completados:*\n${stepsText}`,
        "Markdown",
      );
      await bot.telegram.sendMessage(
        config.telegram.ownerUserId,
        `✅ PR #${prInfo.prNumber} del repo \`${prInfo.repo}\` fue mergeado exitosamente.`,
        { parse_mode: "Markdown" },
      );
    } else {
      const stepsText = result.steps.length
        ? result.steps.join("\n")
        : "Ninguno";
      await sendToTopic(
        bot.telegram,
        item.chatId,
        `❌ *Error procesando PR*\n\n` +
          `📦 Repo: \`${prInfo.repo}\`\n` +
          `🔢 PR #: \`${prInfo.prNumber}\`\n\n` +
          `*Pasos completados:*\n${stepsText}\n\n` +
          `*Error:* \`${result.error}\`\n\n` +
          `⚠️ Revisa el PR manualmente: ${item.url}`,
        "Markdown",
      );
      throw new Error(result.error);
    }

    // Notificar cuántos quedan en cola
    const remaining = queue.pendingCount;
    if (remaining > 0) {
      await sendToTopic(
        bot.telegram,
        item.chatId,
        `📋 *${remaining} PR(s) restantes en cola*\n` +
          `⏳ Procesando el siguiente...`,
        "Markdown",
      );
    }
  });

  // /status — incluye estado de la cola
  bot.command("status", async (ctx) => {
    const queueSummary = queue.getSummary();
    await ctx.reply(
      `🤖 *Bot de PR Autorización*\n\n` +
        `✅ Activo y escuchando\n` +
        `📡 Monitoreando URLs de CodeCommit\n\n` +
        `*Cola de PRs:*\n${queueSummary}\n\n` +
        `Comandos:\n` +
        `/status \\- Ver estado y cola\n` +
        `/queue \\- Ver cola de PRs\n` +
        `/log \\- Ver bitácora de PRs\n` +
        `/pr <url> \\- Procesar PR manualmente`,
      { parse_mode: "MarkdownV2", message_thread_id: config.telegram.topicId },
    );
  });

  // /queue — ver cola
  bot.command("queue", async (ctx) => {
    const summary = queue.getSummary();
    await ctx.reply(`📋 *Cola de PRs*\n\n${summary}`, {
      parse_mode: "Markdown",
      message_thread_id: config.telegram.topicId,
    });
  });

  // /log — ver bitácora de PRs recientes
  bot.command("log", async (ctx) => {
    const logs = getRecentLogs(5);
    await ctx.reply(`📒 *Bitácora de PRs (últimos 5)*\n\n\`\`\`\n${logs}\n\`\`\``, {
      parse_mode: "Markdown",
      message_thread_id: config.telegram.topicId,
    });
  });

  // /pr <url> — procesar PR manualmente (solo owner)
  bot.command("pr", async (ctx) => {
    if (ctx.from?.id !== config.telegram.ownerUserId) {
      await ctx.reply("⛔ No tienes permisos para usar este comando.");
      return;
    }

    const url = ctx.message.text.split(" ")[1];
    if (!url) {
      await ctx.reply("Uso: /pr <url_del_pr>");
      return;
    }

    const prInfo = parsePrInfo(url);
    if (!prInfo) {
      await ctx.reply("❌ URL de PR no válida.");
      return;
    }

    const added = queue.enqueue({
      url: prInfo.url,
      repo: prInfo.repo,
      prNumber: prInfo.prNumber,
      chatId: ctx.chat.id,
    });

    if (added) {
      const current = queue.currentItem;
      if (current) {
        await sendToTopic(bot.telegram, ctx.chat.id,
          `📥 PR #${prInfo.prNumber} agregado a la cola (posición ${queue.pendingCount})\n` +
            `▶️ Actualmente procesando: PR #${current.prNumber}`,
        );
      } else {
        await sendToTopic(bot.telegram, ctx.chat.id,
          `📥 PR #${prInfo.prNumber} recibido, procesando...`,
        );
      }
    } else {
      await ctx.reply(`ℹ️ PR #${prInfo.prNumber} ya está en cola.`);
    }
  });

  // Escuchar mensajes de canales/grupos con URLs de PR
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    const chatType = ctx.chat.type;

    if (chatType === "private") return;

    if (
      config.telegram.topicId &&
      ctx.message.message_thread_id !== config.telegram.topicId
    ) {
      return;
    }

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
        url: prInfo.url,
        repo: prInfo.repo,
        prNumber: prInfo.prNumber,
        chatId: ctx.chat.id,
      });
      if (wasAdded) added.push(prInfo);
      else duplicates.push(prInfo);
    }

    if (added.length > 0) {
      const current = queue.currentItem;
      const prList = added
        .map((p) => `  • PR \\#${p.prNumber} \\(${p.repo}\\)`)
        .join("\n");

      let msg = `🔍 *${added.length} PR\\(s\\) detectados*\n\n${prList}\n\n`;

      if (current && current.prNumber !== added[0].prNumber) {
        msg +=
          `▶️ Actualmente procesando: PR \\#${current.prNumber}\n` +
          `📋 Total en cola: ${queue.pendingCount}`;
      } else {
        msg += `⏳ Iniciando proceso de autorización\\.\\.\\.`;
      }

      await sendToTopic(bot.telegram, ctx.chat.id, msg, "MarkdownV2");
    }

    if (duplicates.length > 0) {
      const dupList = duplicates.map((p) => `PR #${p.prNumber}`).join(", ");
      await sendToTopic(bot.telegram, ctx.chat.id, `ℹ️ Ya en cola: ${dupList}`);
    }
  });

  return bot;
}

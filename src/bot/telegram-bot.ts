import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { extractPrUrl, parsePrInfo } from "../utils/url-parser.js";
import type { AWSBrowser } from "../aws/browser.js";
import type { PrInfo } from "../types.js";

/** Helper to send a message to the configured topic (if any) */
async function sendToTopic(
  ctx: Context,
  chatId: number | string,
  text: string,
  parseMode?: "Markdown" | "MarkdownV2",
): Promise<void> {
  await ctx.telegram.sendMessage(chatId, text, {
    parse_mode: parseMode,
    message_thread_id: config.telegram.topicId,
  });
}

export function createBot(awsBrowser: AWSBrowser): Telegraf {
  const bot = new Telegraf(config.telegram.token);

  // /status
  bot.command("status", async (ctx) => {
    await ctx.reply(
      "🤖 *Bot de PR Autorización*\n\n" +
        "✅ Activo y escuchando\n" +
        "📡 Monitoreando URLs de CodeCommit\n\n" +
        "Comandos:\n" +
        "/status \\- Ver estado\n" +
        "/pr <url> \\- Procesar PR manualmente",
      { parse_mode: "MarkdownV2", message_thread_id: config.telegram.topicId },
    );
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

    await sendToTopic(
      ctx,
      ctx.chat.id,
      `⏳ Procesando PR #${prInfo.prNumber} manualmente...`,
    );
    runPrFlow(ctx, awsBrowser, url, prInfo);
  });

  // Escuchar mensajes de canales/grupos con URLs de PR
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    const chatType = ctx.chat.type;

    // Solo procesar mensajes de grupos/canales/supergrupos
    if (chatType === "private") return;

    // Si hay topicId configurado, solo procesar mensajes de ese topic
    if (
      config.telegram.topicId &&
      ctx.message.message_thread_id !== config.telegram.topicId
    ) {
      return;
    }

    const prUrl = extractPrUrl(text);
    if (!prUrl) return;

    const prInfo = parsePrInfo(prUrl);
    if (!prInfo) return;

    logger.info(`PR detectado: ${JSON.stringify(prInfo)}`);

    await sendToTopic(
      ctx,
      ctx.chat.id,
      `🔍 *PR detectado automáticamente*\n\n` +
        `📦 Repo: \`${prInfo.repo}\`\n` +
        `🔢 PR \\#: \`${prInfo.prNumber}\`\n\n` +
        `⏳ Iniciando proceso de autorización\\.\\.\\.`,
      "MarkdownV2",
    );

    runPrFlow(ctx, awsBrowser, prUrl, prInfo);
  });

  return bot;
}

/** Ejecuta el flujo de PR en background y notifica resultado */
function runPrFlow(
  ctx: Context,
  awsBrowser: AWSBrowser,
  prUrl: string,
  prInfo: PrInfo,
): void {
  // Fire-and-forget — no bloquea el handler de Telegram
  void (async () => {
    try {
      const result = await awsBrowser.fullPrFlow(prUrl);
      const chatId = ctx.chat!.id;

      if (result.success) {
        const stepsText = result.steps.join("\n");
        await sendToTopic(
          ctx,
          chatId,
          `✅ *PR procesado exitosamente*\n\n` +
            `📦 Repo: \`${prInfo.repo}\`\n` +
            `🔢 PR #: \`${prInfo.prNumber}\`\n\n` +
            `*Pasos completados:*\n${stepsText}`,
          "Markdown",
        );
        // Notificar al owner por DM
        await ctx.telegram.sendMessage(
          config.telegram.ownerUserId,
          `✅ PR #${prInfo.prNumber} del repo \`${prInfo.repo}\` fue mergeado exitosamente.`,
          { parse_mode: "Markdown" },
        );
      } else {
        const stepsText = result.steps.length
          ? result.steps.join("\n")
          : "Ninguno";
        await sendToTopic(
          ctx,
          chatId,
          `❌ *Error procesando PR*\n\n` +
            `📦 Repo: \`${prInfo.repo}\`\n` +
            `🔢 PR #: \`${prInfo.prNumber}\`\n\n` +
            `*Pasos completados:*\n${stepsText}\n\n` +
            `*Error:* \`${result.error}\`\n\n` +
            `⚠️ Revisa el PR manualmente: ${prUrl}`,
          "Markdown",
        );
      }
    } catch (e) {
      logger.error(`Error en runPrFlow: ${e}`);
    }
  })();
}

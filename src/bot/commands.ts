import type { Telegraf } from "telegraf";
import { config } from "../config.js";
import { parsePrInfo } from "../utils/url-parser.js";
import { getRecentLogs } from "../history/pr-log.js";
import type { PrQueue } from "../queue/pr-queue.js";
import { isAuthorized, sendApprovalRequest } from "./helpers.js";

/** Registra los comandos del bot: /status, /queue, /log, /pr */
export function registerCommands(bot: Telegraf, queue: PrQueue): void {
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
      await ctx.reply("⛔ No tienes permisos.");
      return;
    }
    const url = ctx.message.text.split(" ")[1];
    if (!url) {
      await ctx.reply("Uso: /pr <url>");
      return;
    }
    const prInfo = parsePrInfo(url);
    if (!prInfo) {
      await ctx.reply("❌ URL no válida.");
      return;
    }

    const added = queue.enqueue({
      url: prInfo.url,
      repo: prInfo.repo,
      prNumber: prInfo.prNumber,
      chatId: ctx.chat.id,
      requestedBy: ctx.from?.username,
    });
    if (added) {
      await sendApprovalRequest(bot.telegram, ctx.chat.id, prInfo);
    } else {
      await ctx.reply(`ℹ️ PR #${prInfo.prNumber} ya está en cola.`);
    }
  });
}

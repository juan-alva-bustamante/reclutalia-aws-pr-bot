import type { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { extractAllPrUrls, parsePrInfo } from "../utils/url-parser.js";
import type { PrQueue } from "../queue/pr-queue.js";
import type { PrInfo } from "../types.js";
import { isAuthorized, sendApprovalRequest, sendToTopic } from "./helpers.js";

const APPROVE_WORDS = ["si", "sí", "autorizar"];
const REJECT_WORDS = ["no", "denegar"];

/** Registra los handlers de botones inline y mensajes de texto */
export function registerHandlers(bot: Telegraf, queue: PrQueue): void {
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
      await sendApprovalRequest(bot.telegram, ctx.chat.id, prInfo);
    }

    if (duplicates.length > 0) {
      await sendToTopic(bot.telegram, ctx.chat.id,
        `ℹ️ Ya en cola: ${duplicates.map((p) => `PR #${p.prNumber}`).join(", ")}`);
    }
  });
}

import { Telegraf } from "telegraf";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { PrQueue } from "../queue/pr-queue.js";
import { logPrResult } from "../history/pr-log.js";
import type { AWSBrowser } from "../aws/browser.js";
import type { PrInfo, QueueItem } from "../types.js";
import { sendToTopic } from "./helpers.js";
import { setupMfaHandler } from "./mfa-handler.js";
import { registerCommands } from "./commands.js";
import { registerHandlers } from "./handlers.js";

export function createBot(awsBrowser: AWSBrowser): Telegraf {
  const bot = new Telegraf(config.telegram.token);
  const queue = new PrQueue();

  // 1. MFA handler (debe ir primero para interceptar DMs del owner)
  setupMfaHandler(bot, awsBrowser);

  // 2. Procesador de la cola
  queue.setProcessor(async (item: QueueItem) => {
    const prInfo: PrInfo = { repo: item.repo, prNumber: item.prNumber, url: item.url };
    const startedAt = new Date().toISOString();
    const approver = item.approvedBy?.toLowerCase();
    const authorInfo = approver ? config.userProfiles[approver] : undefined;
    const approverDisplay = (item.approvedBy ?? "unknown").replace(/_/g, "\\_");
    const authorDisplay = authorInfo ? ` (${authorInfo.name})` : "";

    await sendToTopic(bot.telegram, item.chatId,
      `⏳ *Procesando PR #${prInfo.prNumber}*\n` +
        `📦 Repo: \`${prInfo.repo}\`\n` +
        `👤 Aprobado por: @${approverDisplay}${authorDisplay}`,
    );

    const result = await awsBrowser.fullPrFlow(item.url, authorInfo, prInfo.prNumber);
    const finishedAt = new Date().toISOString();

    logPrResult({
      prNumber: prInfo.prNumber, repo: prInfo.repo, url: item.url,
      status: result.success ? "success" : "error",
      steps: result.steps, error: result.error,
      startedAt, finishedAt,
      requestedBy: item.requestedBy,
      approvedBy: item.approvedBy,
      authorName: authorInfo?.name, authorEmail: authorInfo?.email,
    });

    logger.info("[Bot] Cerrando browser después de procesar PR");
    await awsBrowser.close();

    if (result.success) {
      await sendToTopic(bot.telegram, item.chatId,
        `✅ *PR #${prInfo.prNumber} mergeado exitosamente*\n` +
          `📦 Repo: \`${prInfo.repo}\`\n` +
          `👤 Por: @${approverDisplay}`,
      );
    } else {
      await sendToTopic(bot.telegram, item.chatId,
        `❌ *Error en PR #${prInfo.prNumber}*\n` +
          `📦 Repo: \`${prInfo.repo}\`\n` +
          `*Error:* \`${result.error}\`\n\n` +
          `⚠️ Revisa manualmente: ${item.url}`,
      );
      await bot.telegram.sendMessage(config.telegram.ownerUserId,
        `❌ Error en PR #${prInfo.prNumber} (${prInfo.repo})\n\n` +
          `Error: ${result.error}\n` +
          `Pasos completados: ${result.steps.length > 0 ? result.steps.join(", ") : "Ninguno"}\n\n` +
          `${item.url}`,
      ).catch((e: unknown) => logger.warn(`[Bot] Error enviando DM de error al owner: ${e}`));
      throw new Error(result.error);
    }

    if (queue.pendingCount > 0) {
      await sendToTopic(bot.telegram, item.chatId,
        `📋 ${queue.pendingCount} PR(s) en cola, procesando siguiente...`,
      );
    }
  });

  // 3. Comandos (/status, /queue, /log, /pr)
  registerCommands(bot, queue);

  // 4. Handlers (botones inline + mensajes de texto)
  registerHandlers(bot, queue, awsBrowser);

  return bot;
}

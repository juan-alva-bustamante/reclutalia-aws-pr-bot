import type { Telegraf } from "telegraf";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { PrInfo } from "../types.js";

/** Envía mensaje al topic configurado. Si falla el formato Markdown, reintenta sin formato */
export async function sendToTopic(
  telegram: Telegraf["telegram"],
  chatId: number | string,
  text: string,
  parseMode: "Markdown" | "MarkdownV2" | undefined = "Markdown",
): Promise<void> {
  try {
    await telegram.sendMessage(chatId, text, {
      parse_mode: parseMode,
      message_thread_id: config.telegram.topicId,
    });
  } catch (e: unknown) {
    logger.warn(`[Bot] Error enviando mensaje con Markdown, reintentando sin formato: ${e}`);
    try {
      await telegram.sendMessage(chatId, text.replace(/[*`_]/g, ""), {
        message_thread_id: config.telegram.topicId,
      });
    } catch (e2: unknown) {
      logger.error(`[Bot] Error enviando mensaje sin formato: ${e2}`);
    }
  }
}

/**
 * Escapa caracteres que rompen el Markdown v1 de Telegram en texto generado por IA.
 * Solo escapar dentro de texto libre (no en formato que nosotros controlamos).
 */
export function escapeTelegramMarkdown(text: string): string {
  // En Markdown v1, los caracteres problemáticos dentro de texto libre son: _ * ` [
  // No escapar si ya están en un par válido (como *bold* o `code`)
  // Escapar _ y [ que son los más comunes en respuestas de LLMs
  return text
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

/** Verifica si un username de Telegram está autorizado */
export function isAuthorized(username: string | undefined): boolean {
  if (!username) return false;
  return config.telegram.authorizedUsers.some(
    (u) => u === username.toLowerCase(),
  );
}

/** Texto del mensaje estándar de aprobación (sin IA) — usado en todos los flujos de aprobación */
export function buildStandardApprovalText(prInfo: PrInfo): string {
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

/** Teclado inline con los botones Aprobar/Rechazar para un PR */
export function approvalKeyboard(prNumber: string): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: [[
      { text: "✅ Aprobar", callback_data: `approve:${prNumber}` },
      { text: "❌ Rechazar", callback_data: `reject:${prNumber}` },
    ]],
  };
}

/** Envía la solicitud de aprobación con botones inline */
export async function sendApprovalRequest(
  telegram: Telegraf["telegram"],
  chatId: number | string,
  prInfo: PrInfo,
): Promise<void> {
  await telegram.sendMessage(chatId, buildStandardApprovalText(prInfo), {
    parse_mode: "Markdown",
    message_thread_id: config.telegram.topicId,
    reply_markup: approvalKeyboard(prInfo.prNumber),
  });
}

/**
 * Avisa a un usuario que no está autorizado. Intenta primero por DM (igual de
 * discreto que el toast que reciben los clicks de botón no autorizados); si el
 * usuario nunca inició un chat privado con el bot, el DM falla y se avisa en el
 * grupo como respaldo para no dejarlo sin feedback.
 */
export async function notifyUnauthorized(
  telegram: Telegraf["telegram"],
  userId: number | undefined,
  username: string | undefined,
  chatId: number | string,
  action: "aprobar" | "rechazar",
): Promise<void> {
  const text = `⛔ No estás autorizado para ${action} PRs.`;
  if (userId) {
    try {
      await telegram.sendMessage(userId, text);
      return;
    } catch {
      /* el usuario nunca escribió al bot en privado — cae al aviso en grupo */
    }
  }
  await sendToTopic(telegram, chatId, `⛔ @${username ?? "usuario"} no autorizado.`);
}

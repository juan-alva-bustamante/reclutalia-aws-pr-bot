import type { Telegraf } from "telegraf";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AWSBrowser } from "../aws/browser.js";
import type { PrInfo } from "../types.js";
import type { QueueItem } from "../types/queue.types.js";
import type { PrQueue } from "../queue/pr-queue.js";
import { prEmitter } from "../ws/pr-emitter.js";
import { sendToTopic, sendApprovalRequest, escapeTelegramMarkdown } from "./helpers.js";
import type { PRAnalysis } from "../types/ai.types.js";

/**
 * Ejecuta el análisis IA de un PR encolado y envía el mensaje de aprobación con botones.
 * Se usa cuando un PR estaba en `queued` y ahora es su turno (el browser está libre).
 *
 * Flujo:
 * 1. Login si necesario
 * 2. Scraping del diff
 * 3. Análisis con Ollama
 * 4. Enviar mensaje de aprobación con resumen IA (o estándar si falla)
 *
 * No lanza excepciones — si la IA falla, envía mensaje estándar con botones.
 */
export async function analyzeAndRequestApproval(
  bot: Telegraf,
  awsBrowser: AWSBrowser,
  item: QueueItem,
  prInfo: PrInfo,
  queue: PrQueue,
): Promise<void> {
  // Si IA no está habilitada, enviar mensaje estándar con botones
  if (!config.ai.enabled) {
    await sendApprovalRequest(bot.telegram, item.chatId, prInfo);
    return;
  }

  logger.info(`[AI] 🔄 Análisis IA para PR #${prInfo.prNumber} (desde cola)`);

  // Mensaje temporal
  let tempMessage: { message_id: number } | undefined;
  try {
    tempMessage = await bot.telegram.sendMessage(
      item.chatId,
      `⏳ *Obteniendo resumen IA para PR #${prInfo.prNumber}...*\n📦 Repo: \`${prInfo.repo}\``,
      { parse_mode: "Markdown", message_thread_id: config.telegram.topicId },
    );
  } catch (e: unknown) {
    logger.warn(`[AI] Error enviando mensaje temporal: ${e}`);
  }

  prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_login", "in_progress");

  let analysis: PRAnalysis | null = null;
  let filesChanged: string[] = [];

  try {
    awsBrowser.setBusy(true);
    await awsBrowser.ensureStarted();
    const page = awsBrowser.getPage();

    if (!page) {
      prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_login", "error", "No se pudo obtener página");
      throw new Error("No se pudo obtener página del browser");
    }

    // Login si necesario
    const { isLoggedIn, login, saveSession } = await import("../aws/auth.js");
    if (!(await isLoggedIn(page))) {
      logger.info("[AI] Sesión no activa, haciendo login para análisis...");
      const loginOk = await login(page, awsBrowser.onMfaRequired);
      if (!loginOk) {
        prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_login", "error", "Login falló");
        throw new Error("Login falló para análisis de diff");
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

    // Análisis con Ollama
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
    logger.warn(`[AI] Error en análisis desde cola: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    awsBrowser.setBusy(false);
  }

  // Borrar mensaje temporal
  if (tempMessage) {
    try {
      await bot.telegram.deleteMessage(item.chatId, tempMessage.message_id);
    } catch (e: unknown) {
      logger.warn(`[AI] No se pudo borrar mensaje temporal: ${e}`);
    }
  }

  // Emitir resultado al widget
  prEmitter.aiResult(prInfo.prNumber, prInfo.repo, analysis !== null, analysis?.summary, filesChanged);

  // Guardar resumen IA en la cola
  if (analysis?.summary) {
    logger.info(`[AI] 📝 Resumen: ${analysis.summary}`);
    if (analysis.changes.length > 0) logger.info(`[AI] 📁 Cambios: ${analysis.changes.join(", ")}`);
    if (analysis.risks.length > 0) logger.info(`[AI] ⚠️ Riesgos: ${analysis.risks.join(", ")}`);
    queue.setAiSummary(prInfo.prNumber, analysis.summary);
  }

  // Enviar mensaje de aprobación con botones
  const messageText = analysis
    ? formatEnrichedMessage(prInfo, analysis)
    : filesChanged.length > 0
      ? formatFilesOnlyMessage(prInfo, filesChanged)
      : formatStandardMessage(prInfo);

  try {
    await bot.telegram.sendMessage(
      item.chatId,
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
        item.chatId,
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
      await sendApprovalRequest(bot.telegram, item.chatId, prInfo);
    }
  }
}

/** Formatea el mensaje enriquecido con análisis de IA */
function formatEnrichedMessage(prInfo: PrInfo, analysis: PRAnalysis): string {
  let msg = `🔍 *PR detectado*\n\`${prInfo.repo}\` → PR #${prInfo.prNumber}\n\n`;
  msg += `📋 *Resumen IA:*\n${escapeTelegramMarkdown(analysis.summary)}\n\n`;
  if (analysis.changes.length > 0) {
    msg += `📁 *Cambios principales:*\n`;
    for (const change of analysis.changes) msg += `• ${escapeTelegramMarkdown(change)}\n`;
    msg += "\n";
  }
  if (analysis.risks.length > 0) {
    msg += `⚠️ *Riesgos detectados:*\n`;
    for (const risk of analysis.risks) msg += `• ${escapeTelegramMarkdown(risk)}\n`;
    msg += "\n";
  }
  msg += `⁉ ¿Aprobar este PR?`;
  return msg;
}

/** Formatea mensaje con solo los archivos modificados */
function formatFilesOnlyMessage(prInfo: PrInfo, files: string[]): string {
  let msg = `🔍 *PR detectado*\n\`${prInfo.repo}\` → PR #${prInfo.prNumber}\n\n`;
  msg += `📁 *Archivos modificados (${files.length}):*\n`;
  const displayFiles = files.slice(0, 15);
  for (const file of displayFiles) msg += `• \`${file}\`\n`;
  if (files.length > 15) msg += `• _...y ${files.length - 15} más_\n`;
  msg += "\n⁉ ¿Aprobar este PR?";
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

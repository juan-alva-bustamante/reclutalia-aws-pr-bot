import type { Telegraf } from "telegraf";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AWSBrowser } from "../aws/browser.js";
import type { PrInfo } from "../types.js";
import type { PrQueue } from "../queue/pr-queue.js";
import { prEmitter } from "../ws/pr-emitter.js";
import { isLoggedIn, login, saveSession } from "../aws/auth.js";
import { scrapeDiff } from "../ai/diff-scraper.js";
import { buildPRAnalysisPrompt } from "../ai/prompt-builder.js";
import { callOllama } from "../ai/llm-client.js";
import { parseLLMResponse } from "../ai/response-parser.js";
import {
  sendApprovalRequest,
  buildStandardApprovalText,
  approvalKeyboard,
  escapeTelegramMarkdown,
} from "./helpers.js";
import type { PRAnalysis } from "../types/ai.types.js";

/**
 * Ejecuta el análisis IA de un PR (recién detectado o cuya vez llegó desde la cola)
 * y envía el mensaje de aprobación con botones. Única implementación — se usa tanto
 * cuando el browser está libre de inmediato como cuando un PR `queued` es promovido.
 *
 * Flujo:
 * 1. Mensaje temporal "⏳ Obteniendo resumen IA..."
 * 2. Login si necesario
 * 3. Scraping del diff
 * 4. Análisis con Ollama
 * 5. Edita el mensaje temporal con el resultado (resumen IA, solo archivos, o estándar)
 *
 * No lanza excepciones — si la IA falla o está deshabilitada, termina en el mensaje
 * estándar con botones.
 */
export async function analyzeAndRequestApproval(
  bot: Telegraf,
  awsBrowser: AWSBrowser | undefined,
  chatId: number | string,
  prInfo: PrInfo,
  queue: PrQueue,
): Promise<void> {
  if (!config.ai.enabled || !awsBrowser) {
    await sendApprovalRequest(bot.telegram, chatId, prInfo);
    return;
  }

  logger.info(`[AI] 🔄 Análisis IA para PR #${prInfo.prNumber}`);

  // Mensaje temporal — se edita al final en vez de borrarse + reenviarse
  let tempMessage: { message_id: number } | undefined;
  try {
    tempMessage = await bot.telegram.sendMessage(
      chatId,
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
    const diffResult = await scrapeDiff(page, prInfo.url);
    filesChanged = diffResult.filesChanged;
    prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_scraping", "done");

    // Análisis con Ollama (solo si hay contenido)
    if (diffResult.content && diffResult.content.trim().length > 0) {
      prEmitter.aiStep(prInfo.prNumber, prInfo.repo, "ai_analyzing", "in_progress");
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
    awsBrowser.setBusy(false);
  }

  // Emitir resultado al widget
  prEmitter.aiResult(prInfo.prNumber, prInfo.repo, analysis !== null, analysis?.summary, filesChanged);

  // Guardar resumen IA en la cola (para la bitácora)
  if (analysis?.summary) {
    logger.info(`[AI] 📝 Resumen: ${analysis.summary}`);
    if (analysis.changes.length > 0) logger.info(`[AI] 📁 Cambios: ${analysis.changes.join(", ")}`);
    if (analysis.risks.length > 0) logger.info(`[AI] ⚠️ Riesgos: ${analysis.risks.join(", ")}`);
    queue.setAiSummary(prInfo.prNumber, analysis.summary);
  }

  const messageText = analysis
    ? formatEnrichedMessage(prInfo, analysis)
    : filesChanged.length > 0
      ? formatFilesOnlyMessage(prInfo, filesChanged)
      : buildStandardApprovalText(prInfo);
  const keyboard = approvalKeyboard(prInfo.prNumber);

  // Camino feliz: editar el mensaje temporal en el resultado final (sin borrar +
  // reenviar — un mensaje menos y sin el parpadeo de que el mensaje desaparezca).
  if (tempMessage) {
    try {
      await bot.telegram.editMessageText(chatId, tempMessage.message_id, undefined, messageText, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
      return;
    } catch (e: unknown) {
      logger.warn(`[AI] Error editando mensaje con Markdown, reintentando sin formato: ${e}`);
      try {
        await bot.telegram.editMessageText(chatId, tempMessage.message_id, undefined, messageText.replace(/[*`_\\]/g, ""), {
          reply_markup: keyboard,
        });
        return;
      } catch (e2: unknown) {
        logger.warn(`[AI] No se pudo editar el mensaje temporal, se reemplaza: ${e2}`);
        try {
          await bot.telegram.deleteMessage(chatId, tempMessage.message_id);
        } catch { /* ya no importa, se sigue con el envío de un mensaje nuevo */ }
      }
    }
  }

  // Respaldo: no hubo mensaje temporal, o falló editarlo — enviar uno nuevo
  try {
    await bot.telegram.sendMessage(chatId, messageText, {
      parse_mode: "Markdown",
      message_thread_id: config.telegram.topicId,
      reply_markup: keyboard,
    });
  } catch (e: unknown) {
    logger.warn(`[AI] Error enviando mensaje con Markdown: ${e}`);
    try {
      await bot.telegram.sendMessage(chatId, messageText.replace(/[*`_\\]/g, ""), {
        message_thread_id: config.telegram.topicId,
        reply_markup: keyboard,
      });
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

/** Formatea mensaje con solo los archivos modificados (fallback cuando IA falla) */
function formatFilesOnlyMessage(prInfo: PrInfo, files: string[]): string {
  let msg = `🔍 *PR detectado*\n\`${prInfo.repo}\` → PR #${prInfo.prNumber}\n\n`;
  msg += `📁 *Archivos modificados (${files.length}):*\n`;
  const displayFiles = files.slice(0, 15);
  for (const file of displayFiles) msg += `• \`${file}\`\n`;
  if (files.length > 15) msg += `• _...y ${files.length - 15} más_\n`;
  msg += "\n⁉ ¿Aprobar este PR?";
  return msg;
}

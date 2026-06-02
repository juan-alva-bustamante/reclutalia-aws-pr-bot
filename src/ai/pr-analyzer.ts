import type { Page } from "playwright";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { PRAnalysis } from "../types/ai.types.js";
import { scrapeDiff } from "./diff-scraper.js";
import { callOllama } from "./llm-client.js";
import { buildPRAnalysisPrompt } from "./prompt-builder.js";
import { parseLLMResponse } from "./response-parser.js";

/**
 * Orquestador principal de análisis de PR con IA.
 * Flujo: scrape diff → build prompt → call Ollama → parse response.
 *
 * Retorna null si:
 * - AI_ENABLED=false
 * - Cualquier paso falla (nunca lanza excepciones)
 *
 * @param page - Instancia de Playwright ya autenticada
 * @param prUrl - URL del PR en CodeCommit
 */
export async function analyzePR(page: Page, prUrl: string): Promise<PRAnalysis | null> {
  if (!config.ai.enabled) {
    logger.info("[AI] ⏭️ IA deshabilitada (AI_ENABLED=false)");
    return null;
  }

  const startTime = Date.now();
  logger.info(`[AI] 🔍 Iniciando análisis de PR: ${prUrl}`);

  try {
    // 1. Obtener diff del DOM
    const diffResult = await scrapeDiff(page, prUrl);

    if (!diffResult.content || diffResult.content.trim().length === 0) {
      logger.warn("[AI] ⚠️ Diff vacío, no se puede analizar");
      return null;
    }

    logger.info(`[AI] 📊 Diff: ${diffResult.content.length} chars, ${diffResult.filesChanged.length} archivos`);

    // 2. Construir prompt
    const prompt = buildPRAnalysisPrompt(diffResult.content, diffResult.filesChanged);

    // 3. Llamar a Ollama
    const rawResponse = await callOllama(prompt, config.ai.ollama);

    // 4. Parsear respuesta
    const analysis = parseLLMResponse(rawResponse);

    const elapsed = Date.now() - startTime;
    logger.info(`[AI] ✅ Análisis completado en ${(elapsed / 1000).toFixed(1)}s`);

    return analysis;
  } catch (e: unknown) {
    const elapsed = Date.now() - startTime;
    logger.error(`[AI] ❌ Error en análisis (${(elapsed / 1000).toFixed(1)}s): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

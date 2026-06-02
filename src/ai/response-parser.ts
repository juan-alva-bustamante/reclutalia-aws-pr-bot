import { logger } from "../logger.js";
import type { PRAnalysis } from "../types/ai.types.js";

const DEFAULT_ANALYSIS: PRAnalysis = {
  summary: "No se pudo generar un resumen automático.",
  changes: [],
  risks: [],
};

/**
 * Extrae y parsea la respuesta JSON del LLM.
 * Busca el primer objeto JSON en la respuesta (por si el LLM agrega texto extra).
 * Si falla el parse, retorna valores default — nunca lanza error.
 */
export function parseLLMResponse(raw: string): PRAnalysis {
  try {
    // Buscar JSON en la respuesta: desde el primer { hasta el último }
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn("[AI] ⚠️ No se encontró JSON en la respuesta del LLM");
      return DEFAULT_ANALYSIS;
    }

    const parsed: unknown = JSON.parse(jsonMatch[0]);

    if (typeof parsed !== "object" || parsed === null) {
      logger.warn("[AI] ⚠️ JSON parseado no es un objeto");
      return DEFAULT_ANALYSIS;
    }

    const obj = parsed as Record<string, unknown>;

    // Validar y extraer campos con narrowing
    const summary = typeof obj.summary === "string" && obj.summary.length > 0
      ? obj.summary
      : DEFAULT_ANALYSIS.summary;

    const changes = Array.isArray(obj.changes)
      ? obj.changes.filter((c): c is string => typeof c === "string" && c.length > 0)
      : [];

    const risks = Array.isArray(obj.risks)
      ? obj.risks.filter((r): r is string => typeof r === "string" && r.length > 0)
      : [];

    return { summary, changes, risks };
  } catch (e: unknown) {
    logger.warn(`[AI] ⚠️ Error parseando respuesta del LLM: ${e instanceof Error ? e.message : String(e)}`);
    return DEFAULT_ANALYSIS;
  }
}

import { logger } from "../logger.js";
import type { OllamaConfig } from "../types/ai.types.js";

/** Error tipado para fallos del LLM */
export class LLMError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "LLMError";
  }
}

/**
 * Llama a Ollama para generar una respuesta a partir del prompt.
 * Usa fetch nativo con AbortController para timeout.
 */
export async function callOllama(prompt: string, config: OllamaConfig): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  const url = `${config.baseUrl}/api/generate`;

  logger.info(`[AI] 🤖 Llamando a Ollama (${config.model})...`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 1024,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LLMError(
        `Ollama respondió con status ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const data: unknown = await response.json();

    if (
      typeof data === "object" &&
      data !== null &&
      "response" in data &&
      typeof (data as Record<string, unknown>).response === "string"
    ) {
      const result = (data as { response: string }).response;
      logger.info(`[AI] ✅ Respuesta recibida (${result.length} chars)`);
      return result;
    }

    throw new LLMError("Respuesta de Ollama no tiene formato esperado");
  } catch (e: unknown) {
    if (e instanceof LLMError) throw e;

    if (e instanceof Error && e.name === "AbortError") {
      throw new LLMError(`Ollama timeout después de ${config.timeout}ms`);
    }

    throw new LLMError(
      `Error al conectar con Ollama: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

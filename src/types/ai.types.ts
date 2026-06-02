/** Resultado de extraer el diff del PR via Playwright */
export interface DiffResult {
  /** Contenido del diff (texto plano, máx 8000 chars) */
  content: string;
  /** True si el diff fue truncado por exceder el límite */
  truncated: boolean;
  /** Lista de archivos modificados detectados */
  filesChanged: string[];
}

/** Análisis generado por el LLM */
export interface PRAnalysis {
  /** Resumen del PR en 2-3 oraciones */
  summary: string;
  /** Lista de cambios principales */
  changes: string[];
  /** Riesgos detectados (vacío si no hay) */
  risks: string[];
}

/** Configuración del cliente Ollama */
export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeout: number;
}

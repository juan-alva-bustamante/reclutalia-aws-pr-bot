/** Información extraída de una URL de PR de CodeCommit */
export interface PrInfo {
  repo: string;
  prNumber: string;
  url: string;
}

/** Resultado del flujo completo de PR */
export interface PrFlowResult {
  success: boolean;
  steps: string[];
  error?: string;
}

/** Resultado genérico de operación */
export type Result<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

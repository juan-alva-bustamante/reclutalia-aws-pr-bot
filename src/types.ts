/** Información extraída de una URL de PR de CodeCommit */
export interface PrInfo {
  repo: string;
  prNumber: string;
  url: string;
}

/** Información del autor para el merge en AWS */
export interface AuthorInfo {
  name: string;
  email: string;
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

/** Elemento en la cola de PRs */
export interface QueueItem {
  url: string;
  repo: string;
  prNumber: string;
  status: "awaiting_approval" | "pending" | "processing" | "done" | "error" | "rejected";
  addedAt: string;
  chatId: number;
  requestedBy?: string;
  approvedBy?: string;
  error?: string;
}

/** Estados posibles de un item en la cola */
export type QueueStatus =
  | "awaiting_approval"
  | "pending"
  | "processing"
  | "done"
  | "error"
  | "rejected";

/** Datos de entrada para encolar un PR (lo que se recibe del exterior) */
export interface QueueItemInput {
  url: string;
  repo: string;
  prNumber: string;
  chatId: number;
  requestedBy?: string;
}

/** Elemento completo en la cola de PRs (entrada + estado interno) */
export interface QueueItem extends QueueItemInput {
  status: QueueStatus;
  addedAt: string;
  approvedBy?: string;
  error?: string;
  /** Resumen generado por la IA (si estuvo disponible al momento del análisis) */
  aiSummary?: string;
}

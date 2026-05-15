/**
 * Tipos de eventos que el WebSocket emite al cliente (widget).
 * El widget solo escucha — nunca envía comandos.
 */

/** Pasos del flujo de un PR */
export type PrStep =
  | "login"
  | "switch_authorizer"
  | "approve_authorizer"
  | "switch_manager"
  | "approve_manager"
  | "switch_merge"
  | "merge"
  | "save_session";

/** Estado de un paso */
export type StepStatus = "pending" | "in_progress" | "done" | "error";

/** Evento de progreso de un paso */
export interface StepEvent {
  type: "step";
  prNumber: string;
  repo: string;
  step: PrStep;
  status: StepStatus;
  error?: string;
  timestamp: string;
}

/** Evento de actualización de la cola */
export interface QueueEvent {
  type: "queue";
  current: QueuePrInfo | null;
  pending: QueuePrInfo[];
}

/** Info resumida de un PR para la cola */
export interface QueuePrInfo {
  prNumber: string;
  repo: string;
  approvedBy?: string;
  status: "awaiting_approval" | "pending" | "processing";
}

/** Evento de estado general (idle, procesando, etc.) */
export interface StatusEvent {
  type: "status";
  state: "idle" | "processing" | "completed" | "error";
  prNumber?: string;
  repo?: string;
  error?: string;
  timestamp: string;
}

/** Evento de conexión inicial — envía el estado actual completo */
export interface InitEvent {
  type: "init";
  state: "idle" | "processing";
  current: QueuePrInfo | null;
  pending: QueuePrInfo[];
  currentStep?: PrStep;
  steps: StepSnapshot[];
}

/** Snapshot de un paso (para reconstruir el estado al conectarse) */
export interface StepSnapshot {
  step: PrStep;
  status: StepStatus;
}

/** Todos los eventos posibles */
export type WsEvent = StepEvent | QueueEvent | StatusEvent | InitEvent;

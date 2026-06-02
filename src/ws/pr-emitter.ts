import { EventEmitter } from "node:events";
import type { PrStep, AiStep, StepStatus, StepSnapshot, QueuePrInfo, WsEvent } from "./events.js";

/**
 * Emisor centralizado de eventos de progreso de PRs.
 * El bot emite eventos aquí, y el WS server los retransmite a los clientes.
 */
class PrEventEmitter extends EventEmitter {
  private _state: "idle" | "processing" = "idle";
  private _currentPr: QueuePrInfo | null = null;
  private _pending: QueuePrInfo[] = [];
  private _steps: StepSnapshot[] = [];
  private _currentStep: PrStep | undefined = undefined;

  /** Estado actual para enviar al cliente al conectarse */
  get snapshot(): WsEvent {
    return {
      type: "init",
      state: this._state,
      current: this._currentPr,
      pending: this._pending,
      currentStep: this._currentStep,
      steps: this._steps,
    };
  }

  /** Inicia el procesamiento de un PR */
  startPr(prNumber: string, repo: string, approvedBy?: string): void {
    this._state = "processing";
    this._currentPr = { prNumber, repo, approvedBy, status: "processing" };
    this._steps = this.buildInitialSteps();
    this._currentStep = undefined;

    this.broadcast({
      type: "status",
      state: "processing",
      prNumber,
      repo,
      timestamp: now(),
    });
  }

  /** Emite progreso de un paso */
  step(prNumber: string, repo: string, step: PrStep, status: StepStatus, error?: string): void {
    this._currentStep = step;

    // Actualizar snapshot de steps
    const existing = this._steps.find((s) => s.step === step);
    if (existing) {
      existing.status = status;
    }

    this.broadcast({
      type: "step",
      prNumber,
      repo,
      step,
      status,
      error,
      timestamp: now(),
    });
  }

  /** PR completado exitosamente */
  completePr(prNumber: string, repo: string): void {
    this._state = "idle";
    this._currentPr = null;
    this._currentStep = undefined;

    this.broadcast({
      type: "status",
      state: "completed",
      prNumber,
      repo,
      timestamp: now(),
    });

    // Después de 5s, si sigue idle, limpiar steps
    setTimeout(() => {
      if (this._state === "idle") {
        this._steps = [];
      }
    }, 5_000);
  }

  /** PR falló */
  errorPr(prNumber: string, repo: string, error: string): void {
    this._state = "idle";
    this._currentPr = null;

    this.broadcast({
      type: "status",
      state: "error",
      prNumber,
      repo,
      error,
      timestamp: now(),
    });
  }

  /** Actualiza la cola de PRs pendientes */
  updateQueue(pending: QueuePrInfo[]): void {
    this._pending = pending;

    this.broadcast({
      type: "queue",
      current: this._currentPr,
      pending,
    });
  }

  /** Emite progreso de un paso de análisis IA */
  aiStep(prNumber: string, repo: string, step: AiStep, status: StepStatus, error?: string): void {
    this.broadcast({
      type: "ai_step",
      prNumber,
      repo,
      step,
      status,
      error,
      timestamp: now(),
    });
  }

  /** Emite resultado del análisis IA */
  aiResult(prNumber: string, repo: string, success: boolean, summary?: string, filesChanged?: string[]): void {
    this.broadcast({
      type: "ai_result",
      prNumber,
      repo,
      success,
      summary,
      filesChanged,
      timestamp: now(),
    });
  }

  /** Emite un evento a todos los listeners (el WS server escucha esto) */
  private broadcast(event: WsEvent): void {
    this.emit("ws:event", event);
  }

  private buildInitialSteps(): StepSnapshot[] {
    return [
      { step: "login", status: "pending" },
      { step: "switch_authorizer", status: "pending" },
      { step: "approve_authorizer", status: "pending" },
      { step: "switch_manager", status: "pending" },
      { step: "approve_manager", status: "pending" },
      { step: "switch_merge", status: "pending" },
      { step: "merge", status: "pending" },
      { step: "save_session", status: "pending" },
    ];
  }
}

function now(): string {
  return new Date().toISOString();
}

/** Singleton — se usa en todo el proyecto */
export const prEmitter = new PrEventEmitter();

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { logger } from "../logger.js";
import type { QueueItem, QueueItemInput } from "../types/queue.types.js";

const QUEUE_FILE = resolve(process.cwd(), "data/pr_queue.json");

export class PrQueue {
  private items: QueueItem[] = [];
  private processing = false;
  private onProcess: ((item: QueueItem) => Promise<void>) | null = null;

  constructor() {
    this.load();
  }

  /** Registra el callback que procesa cada PR */
  setProcessor(fn: (item: QueueItem) => Promise<void>): void {
    this.onProcess = fn;
  }

  /** Agrega un PR a la cola esperando aprobación. Retorna true si fue agregado */
  enqueue(item: QueueItemInput): boolean {
    const exists = this.items.some(
      (i) =>
        i.url === item.url &&
        (i.status === "awaiting_approval" || i.status === "pending" || i.status === "processing"),
    );
    if (exists) {
      logger.info(`[Queue] PR #${item.prNumber} ya está en cola, ignorando`);
      return false;
    }

    const queueItem: QueueItem = {
      ...item,
      status: "awaiting_approval",
      addedAt: new Date().toISOString(),
    };

    this.items.push(queueItem);
    this.save();
    logger.info(`[Queue] PR #${item.prNumber} encolado, esperando aprobación`);
    return true;
  }

  /** Aprueba un PR por su número. Retorna el item si se encontró */
  approve(prNumber: string, approvedBy: string): QueueItem | null {
    const item = this.items.find(
      (i) => i.prNumber === prNumber && i.status === "awaiting_approval",
    );
    if (!item) return null;

    item.status = "pending";
    item.approvedBy = approvedBy;
    this.save();
    logger.info(`[Queue] PR #${prNumber} aprobado por @${approvedBy}`);

    // Iniciar procesamiento si no hay nada corriendo
    void this.processNext();
    return item;
  }

  /** Rechaza un PR por su número. Retorna el item si se encontró */
  reject(prNumber: string, rejectedBy: string): QueueItem | null {
    const item = this.items.find(
      (i) => i.prNumber === prNumber && i.status === "awaiting_approval",
    );
    if (!item) return null;

    item.status = "rejected";
    this.save();
    logger.info(`[Queue] PR #${prNumber} rechazado por ${rejectedBy}`);
    return item;
  }

  /** PRs esperando aprobación */
  get awaitingApproval(): QueueItem[] {
    return this.items.filter((i) => i.status === "awaiting_approval");
  }

  /** Cantidad de PRs pendientes (aprobados, listos para procesar) */
  get pendingCount(): number {
    return this.items.filter((i) => i.status === "pending").length;
  }

  /** PR actualmente en proceso */
  get currentItem(): QueueItem | undefined {
    return this.items.find((i) => i.status === "processing");
  }

  /** Resumen de la cola para mostrar en Telegram */
  getSummary(): string {
    const awaiting = this.awaitingApproval;
    const pending = this.items.filter((i) => i.status === "pending");
    const current = this.currentItem;

    let summary = "";
    if (current) {
      summary += `▶️ Procesando: PR #${current.prNumber} (${current.repo})\n`;
    }
    if (awaiting.length > 0) {
      summary += `🔔 Esperando aprobación (${awaiting.length}):\n`;
      awaiting.forEach((p, i) => {
        summary += `  ${i + 1}. PR #${p.prNumber} (${p.repo})\n`;
      });
    }
    if (pending.length > 0) {
      summary += `⏳ Aprobados en cola (${pending.length}):\n`;
      pending.forEach((p, i) => {
        summary += `  ${i + 1}. PR #${p.prNumber} (${p.repo})\n`;
      });
    }
    if (!current && awaiting.length === 0 && pending.length === 0) {
      summary = "📭 Cola vacía, sin PRs pendientes";
    }
    return summary;
  }

  /** Procesa el siguiente PR aprobado en la cola */
  async processNext(): Promise<void> {
    if (this.processing) return;
    if (!this.onProcess) return;

    const next = this.items.find((i) => i.status === "pending");
    if (!next) return;

    this.processing = true;
    next.status = "processing";
    this.save();

    logger.info(`[Queue] Iniciando PR #${next.prNumber} (${next.repo})`);

    try {
      await this.onProcess(next);
      next.status = "done";
    } catch (e) {
      next.status = "error";
      next.error = String(e);
      logger.error(`[Queue] Error procesando PR #${next.prNumber}: ${e}`);
    }

    this.save();
    this.processing = false;

    const remaining = this.pendingCount;
    if (remaining > 0) {
      logger.info(`[Queue] ${remaining} PR(s) restantes en cola`);
      void this.processNext();
    } else {
      logger.info("[Queue] Cola vacía, esperando nuevos PRs");
    }
  }

  /** Carga la cola desde archivo */
  private load(): void {
    try {
      if (!existsSync(QUEUE_FILE)) {
        this.items = [];
        return;
      }
      const data = readFileSync(QUEUE_FILE, "utf-8");
      const parsed: QueueItem[] = JSON.parse(data);
      this.items = parsed.map((i) => ({
        ...i,
        status: i.status === "processing" ? "pending" : i.status,
      }));
      const awaiting = this.awaitingApproval.length;
      const pending = this.pendingCount;
      if (awaiting > 0) logger.info(`[Queue] ${awaiting} PR(s) esperando aprobación`);
      if (pending > 0) logger.info(`[Queue] ${pending} PR(s) pendientes de procesar`);
    } catch {
      this.items = [];
    }
  }

  /** Persiste la cola a archivo */
  private save(): void {
    try {
      const dir = dirname(QUEUE_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const toSave = this.items.filter(
        (i) => i.status === "awaiting_approval" || i.status === "pending" || i.status === "processing",
      );
      writeFileSync(QUEUE_FILE, JSON.stringify(toSave, null, 2), "utf-8");
    } catch (e) {
      logger.error(`[Queue] Error guardando cola: ${e}`);
    }
  }
}

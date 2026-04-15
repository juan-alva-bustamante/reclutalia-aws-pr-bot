import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { logger } from "../logger.js";
import type { QueueItem } from "../types.js";

const QUEUE_FILE = "pr_queue.json";

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

  /** Agrega un PR a la cola. Retorna true si fue agregado, false si ya existe */
  enqueue(item: Omit<QueueItem, "status" | "addedAt">): boolean {
    // No duplicar PRs que ya están pendientes o procesándose
    const exists = this.items.some(
      (i) =>
        i.url === item.url &&
        (i.status === "pending" || i.status === "processing"),
    );
    if (exists) {
      logger.info(`[Queue] PR #${item.prNumber} ya está en cola, ignorando`);
      return false;
    }

    const queueItem: QueueItem = {
      ...item,
      status: "pending",
      addedAt: new Date().toISOString(),
    };

    this.items.push(queueItem);
    this.save();
    logger.info(
      `[Queue] PR #${item.prNumber} agregado a la cola (posición ${this.pendingCount})`,
    );

    // Iniciar procesamiento si no hay nada corriendo
    void this.processNext();

    return true;
  }

  /** Cantidad de PRs pendientes */
  get pendingCount(): number {
    return this.items.filter((i) => i.status === "pending").length;
  }

  /** PR actualmente en proceso */
  get currentItem(): QueueItem | undefined {
    return this.items.find((i) => i.status === "processing");
  }

  /** Resumen de la cola para mostrar en Telegram */
  getSummary(): string {
    const pending = this.items.filter((i) => i.status === "pending");
    const current = this.currentItem;

    let summary = "";
    if (current) {
      summary += `▶️ Procesando: PR #${current.prNumber} (${current.repo})\n`;
    }
    if (pending.length > 0) {
      summary += `⏳ En cola (${pending.length}):\n`;
      pending.forEach((p, i) => {
        summary += `  ${i + 1}. PR #${p.prNumber} (${p.repo})\n`;
      });
    }
    if (!current && pending.length === 0) {
      summary = "📭 Cola vacía, sin PRs pendientes";
    }
    return summary;
  }

  /** Procesa el siguiente PR en la cola */
  private async processNext(): Promise<void> {
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

    // Procesar el siguiente si hay más en cola
    const remaining = this.pendingCount;
    if (remaining > 0) {
      logger.info(`[Queue] ${remaining} PR(s) restantes en cola`);
      void this.processNext();
    } else {
      logger.info("[Queue] Cola vacía, esperando nuevos PRs");
    }
  }

  /** Carga la cola desde archivo (solo items pending, descarta el resto) */
  private load(): void {
    try {
      if (!existsSync(QUEUE_FILE)) {
        this.items = [];
        return;
      }
      const data = readFileSync(QUEUE_FILE, "utf-8");
      const parsed: QueueItem[] = JSON.parse(data);
      // Recuperar solo pending (los processing se reinician como pending)
      this.items = parsed.map((i) => ({
        ...i,
        status: i.status === "processing" ? "pending" : i.status,
      }));
      const pending = this.items.filter((i) => i.status === "pending").length;
      if (pending > 0) {
        logger.info(`[Queue] ${pending} PR(s) pendientes recuperados del archivo`);
      }
    } catch {
      this.items = [];
    }
  }

  /** Persiste la cola a archivo */
  private save(): void {
    try {
      // Solo guardar pending y processing (limpiar done/error viejos)
      const toSave = this.items.filter(
        (i) => i.status === "pending" || i.status === "processing",
      );
      writeFileSync(QUEUE_FILE, JSON.stringify(toSave, null, 2), "utf-8");
    } catch (e) {
      logger.error(`[Queue] Error guardando cola: ${e}`);
    }
  }
}

import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "../logger.js";
import type { Page } from "playwright";

const HISTORY_DIR = resolve(process.cwd(), "data/pull-requests");

export class PrDebugger {
  private dir: string;
  private logFile: string;
  private stepCount = 0;

  constructor(prNumber: string) {
    this.dir = join(HISTORY_DIR, prNumber);
    this.logFile = join(this.dir, "debug.log");
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /** Registra un mensaje en el log de debug del PR */
  log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    try {
      appendFileSync(this.logFile, line, "utf-8");
    } catch (e) {
      logger.warn(`[PrDebug] Error escribiendo log: ${e}`);
    }
  }

  /** Toma screenshot y lo guarda en la carpeta del PR */
  async screenshot(page: Page, label: string): Promise<void> {
    this.stepCount++;
    const filename = `${String(this.stepCount).padStart(2, "0")}_${label}.png`;
    const path = join(this.dir, filename);
    try {
      await page.screenshot({ path, fullPage: true });
      this.log(`Screenshot: ${filename}`);
    } catch (e) {
      this.log(`Error tomando screenshot ${label}: ${e}`);
    }
  }

  /** Guarda el HTML de la página para debug */
  async saveHtml(page: Page, label: string): Promise<void> {
    const filename = `${String(this.stepCount).padStart(2, "0")}_${label}.html`;
    const path = join(this.dir, filename);
    try {
      const html = await page.content();
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, html, "utf-8");
      this.log(`HTML guardado: ${filename}`);
    } catch (e) {
      this.log(`Error guardando HTML ${label}: ${e}`);
    }
  }

  /** Ruta de la carpeta del PR */
  get path(): string {
    return this.dir;
  }
}

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../logger.js";

const LOG_DIR = resolve(process.cwd(), "data");
const LOG_FILE = resolve(LOG_DIR, "pr_bitacora.txt");
const SEPARATOR = "─".repeat(60);

export interface PrLogEntry {
  prNumber: string;
  repo: string;
  url: string;
  status: "success" | "error";
  steps: string[];
  error?: string;
  startedAt: string;
  finishedAt: string;
  requestedBy?: string;
  approvedBy?: string;
  authorName?: string;
  authorEmail?: string;
  /** Resumen generado por la IA (si estuvo disponible) */
  aiSummary?: string;
}

/** Registra un PR completado (exitoso o con error) en la bitácora */
export function logPrResult(entry: PrLogEntry): void {
  const statusIcon = entry.status === "success" ? "✅" : "❌";
  const lines = [
    SEPARATOR,
    `${statusIcon} PR #${entry.prNumber} — ${entry.repo}`,
    `   Estado:    ${entry.status === "success" ? "COMPLETADO" : "ERROR"}`,
    `   URL:       ${entry.url}`,
    `   Solicitó:  @${entry.requestedBy ?? "N/A"}`,
    `   Aprobó:    @${entry.approvedBy ?? "N/A"} (${entry.authorName ?? "N/A"} <${entry.authorEmail ?? "N/A"}>)`,
    `   Inicio:    ${entry.startedAt}`,
    `   Fin:       ${entry.finishedAt}`,
  ];

  if (entry.steps.length > 0) {
    lines.push(`   Pasos:`);
    entry.steps.forEach((s) => lines.push(`     ${s}`));
  }

  if (entry.error) {
    lines.push(`   Error:     ${entry.error}`);
  }

  if (entry.aiSummary) {
    lines.push(`   🤖 IA:     ${entry.aiSummary}`);
  }

  lines.push(SEPARATOR, "");

  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, lines.join("\n") + "\n", "utf-8");
    logger.info(`[Bitácora] PR #${entry.prNumber} registrado`);
  } catch (e) {
    logger.error(`[Bitácora] Error escribiendo: ${e}`);
  }
}

/** Lee las últimas N entradas de la bitácora */
export function getRecentLogs(count = 5): string {
  try {
    if (!existsSync(LOG_FILE)) return "📭 Sin registros aún";
    const content = readFileSync(LOG_FILE, "utf-8");
    const entries = content.split(SEPARATOR).filter((e) => e.trim().length > 0);
    const recent = entries.slice(-count);
    return recent.length > 0 ? recent.join(SEPARATOR) : "📭 Sin registros aún";
  } catch {
    return "⚠️ Error leyendo bitácora";
  }
}

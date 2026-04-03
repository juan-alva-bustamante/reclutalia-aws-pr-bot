import type { PrInfo } from "../types.js";

const CODECOMMIT_RE =
  /https:\/\/[\w-]+\.console\.aws\.amazon\.com\/codesuite\/codecommit\/repositories\/([\w-]+)\/pull-requests\/(\d+)\/details\S*/;

/** Extrae la primera URL de CodeCommit PR encontrada en el texto */
export function extractPrUrl(text: string): string | null {
  return CODECOMMIT_RE.exec(text)?.[0] ?? null;
}

/** Extrae repo y PR number de la URL */
export function parsePrInfo(url: string): PrInfo | null {
  const match = CODECOMMIT_RE.exec(url);
  if (!match) return null;
  return { repo: match[1], prNumber: match[2], url: match[0] };
}

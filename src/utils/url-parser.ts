import type { PrInfo } from "../types.js";

const CODECOMMIT_RE =
  /https:\/\/[\w-]+\.console\.aws\.amazon\.com\/codesuite\/codecommit\/repositories\/([\w-]+)\/pull-requests\/(\d+)\/details\S*/;

const CODECOMMIT_RE_GLOBAL =
  /https:\/\/[\w-]+\.console\.aws\.amazon\.com\/codesuite\/codecommit\/repositories\/([\w-]+)\/pull-requests\/(\d+)\/details\S*/g;

/** Extrae la primera URL de CodeCommit PR encontrada en el texto */
export function extractPrUrl(text: string): string | null {
  return CODECOMMIT_RE.exec(text)?.[0] ?? null;
}

/** Extrae TODAS las URLs de CodeCommit PR encontradas en el texto */
export function extractAllPrUrls(text: string): string[] {
  return [...text.matchAll(CODECOMMIT_RE_GLOBAL)].map((m) => m[0]);
}

/** Extrae repo y PR number de la URL */
export function parsePrInfo(url: string): PrInfo | null {
  const match = CODECOMMIT_RE.exec(url);
  if (!match) return null;
  return { repo: match[1], prNumber: match[2], url: match[0] };
}

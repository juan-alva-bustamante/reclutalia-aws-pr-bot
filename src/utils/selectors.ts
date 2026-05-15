import type { Page } from "playwright";
import { logger } from "../logger.js";

export interface TrySelectorOptions {
  /** Timeout por cada selector individual (ms) */
  timeout?: number;
  /** Acción a realizar cuando se encuentra el elemento */
  action: "click" | "visible" | "fill";
  /** Valor para fill (requerido si action es 'fill') */
  value?: string;
  /** Si true, usa force: true en el click */
  force?: boolean;
  /** Si true, hace scrollIntoView antes del click */
  scroll?: boolean;
}

/**
 * Intenta múltiples selectores en orden hasta que uno funcione.
 * Evita el patrón repetitivo de for + try/catch con selectores.
 *
 * @returns El selector que funcionó, o null si ninguno lo hizo
 */
export async function trySelectors(
  page: Page,
  selectors: string[],
  options: TrySelectorOptions,
): Promise<string | null> {
  const { timeout = 3_000, action, value, force = false, scroll = false } = options;

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible({ timeout }))) continue;

      if (scroll) {
        await el.scrollIntoViewIfNeeded();
      }

      switch (action) {
        case "click":
          await el.click({ force });
          break;
        case "fill":
          if (value !== undefined) await el.fill(value);
          break;
        case "visible":
          // Solo verificar visibilidad — ya lo hicimos arriba
          break;
      }

      logger.info(`[Selectors] ✅ Selector encontrado: ${sel}`);
      return sel;
    } catch {
      /* next selector */
    }
  }

  return null;
}

/**
 * Constante con los ancestros a excluir al buscar botones en AWS Console.
 * Evita hacer click en elementos del header/nav de AWS.
 */
export const AWS_EXCLUDE_ANCESTORS = [
  "[id^='awsc-']",
  "#aws-nav-header",
  "[id='awsui-dropdown']",
].join(", ");

import type { Page } from "playwright";
import { logger } from "../logger.js";
import type { NavigationOptions } from "../types/aws.types.js";

/**
 * Navega a una URL y espera a que la página esté lista para interactuar:
 * 1. goto con domcontentloaded (no networkidle — AWS nunca para de hacer requests)
 * 2. Espera a que desaparezcan spinners/loaders de la consola AWS
 * 3. Espera estabilidad del DOM (sin mutaciones por 1s)
 * 4. Retry automático si la navegación es interrumpida por otro redirect
 */
export async function navigateAndWait(
  page: Page,
  url: string,
  opts?: NavigationOptions,
): Promise<void> {
  const timeout = opts?.timeout ?? 60_000;
  const retries = opts?.retries ?? 2;

  logger.info(`[AWS] Navegando a: ${url}`);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      break;
    } catch (e: unknown) {
      const msg = String(e);
      if (msg.includes("interrupted by another navigation") && attempt < retries) {
        logger.warn(`[AWS] ⚠️ Navegación interrumpida (intento ${attempt + 1}/${retries}), reintentando...`);
        await sleep(3_000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }

  await waitForAwsLoaders(page, timeout);
  await waitForDomStable(page);
  logger.info("[AWS] ✅ Página cargada completamente");
}

/**
 * Espera a que un botón con el texto exacto aparezca visible en la página,
 * haciendo polling cada 2s. Cuando lo encuentra, le da click.
 * Solo busca botones reales (<button>) fuera del header/nav de AWS.
 * Retorna el texto del botón si lo encontró, o null si se agotó el timeout.
 */
export async function waitForButton(
  page: Page,
  buttonText: string,
  timeout = 30_000,
): Promise<string | null> {
  const deadline = Date.now() + timeout;
  const textLower = buttonText.toLowerCase();

  logger.info(`[AWS] ⏳ Esperando botón '${buttonText}'...`);

  while (Date.now() < deadline) {
    const allButtons = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("button"))
        .filter((btn) => btn.offsetParent !== null)
        .map((btn) => (btn.innerText || btn.textContent || "").trim())
        .filter((t) => t.length > 0 && t.length < 50);
    });
    logger.info(`[AWS] Botones visibles: ${JSON.stringify(allButtons.slice(0, 15))}`);

    const result = await page.evaluate((textLower) => {
      const excludeAncestors = [
        "[id^='awsc-']",
        "#aws-nav-header",
        "[id='awsui-dropdown']",
      ].join(", ");

      const buttons = Array.from(document.querySelectorAll("button"));

      for (const btn of buttons) {
        if (btn.closest(excludeAncestors)) continue;

        const text = (btn.innerText || btn.textContent || "").trim();
        const textLc = text.toLowerCase();

        if (
          textLc === textLower &&
          btn.offsetParent !== null &&
          !btn.disabled
        ) {
          btn.scrollIntoView({ behavior: "instant", block: "center" });
          btn.click();
          return text;
        }
      }
      return null;
    }, textLower);

    if (result) return result;

    await sleep(2_000);
  }

  return null;
}

/** Espera a que los spinners/loaders típicos de AWS Console desaparezcan */
export async function waitForAwsLoaders(page: Page, timeout: number): Promise<void> {
  const loaderSelectors = [
    "[class*='loading']",
    "[class*='spinner']",
    "[class*='Spinner']",
    "awsui-spinner",
    "[data-testid='loading']",
    ".awsui-spinner",
    "[class*='awsui'][class*='loading']",
  ];

  const deadline = Date.now() + timeout;

  for (const sel of loaderSelectors) {
    while (Date.now() < deadline) {
      try {
        const visible = await page
          .locator(sel)
          .first()
          .isVisible({ timeout: 500 });
        if (!visible) break;
        logger.info(`[AWS] ⏳ Esperando loader: ${sel}`);
        await sleep(500);
      } catch {
        break;
      }
    }
  }
}

/** Espera a que el DOM se estabilice (sin mutaciones por 1 segundo) */
export async function waitForDomStable(
  page: Page,
  stableMs = 1_000,
  timeout = 15_000,
): Promise<void> {
  try {
    await page.evaluate(
      ({ stableMs, timeout }) =>
        new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const maxTimer = setTimeout(resolve, timeout);
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              observer.disconnect();
              clearTimeout(maxTimer);
              resolve();
            }, stableMs);
          });
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
          });
          timer = setTimeout(() => {
            observer.disconnect();
            clearTimeout(maxTimer);
            resolve();
          }, stableMs);
        }),
      { stableMs, timeout },
    );
  } catch {
    await sleep(stableMs);
  }
}

/** Helper de sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

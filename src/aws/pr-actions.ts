import type { Page } from "playwright";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { navigateAndWait, waitForAwsLoaders, waitForDomStable, waitForButton, sleep } from "./navigation.js";
import { dismissPopups } from "./popups.js";
import type { PrDebugger } from "../history/pr-debug.js";

/** Navega al PR y hace click en "Approve" */
export async function approvePr(page: Page, prUrl: string): Promise<boolean> {
  logger.info(`[AWS] Navegando al PR para APROBAR: ${prUrl}`);
  try {
    await navigateAndWait(page, prUrl, { timeout: 60_000, retries: 2 });

    // Esperar a que el botón Approve aparezca en la página (polling)
    const approveBtn = await waitForButton(page, "Approve", 30_000);
    if (approveBtn) {
      logger.info(`[AWS] ✅ Approve via polling: '${approveBtn}'`);
      await sleep(2_000);
      return true;
    }

    // Fallback: Playwright locators
    logger.warn("[AWS] Polling no encontró Approve, intentando locators...");
    for (const sel of [
      "button:has(span:text-is('Approve'))",
      "button >> text=Approve",
      "[data-testid*='approve']",
      "button[aria-label*='Approve']",
    ]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3_000 })) {
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ force: true });
          logger.info(`[AWS] ✅ Approve con selector: ${sel}`);
          await sleep(3_000);
          return true;
        }
      } catch {
        /* next */
      }
    }

    await page.screenshot({ path: "error_approve.png" });
    logger.error("[AWS] ❌ No se encontró el botón Approve");
    return false;
  } catch (e: unknown) {
    logger.error(`[AWS] Error aprobando PR: ${e}`);
    try {
      await page.screenshot({ path: "error_approve.png" });
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** Navega al PR y ejecuta el merge completo */
export async function mergePr(
  page: Page,
  prUrl: string,
  author?: { name: string; email: string },
  debug?: PrDebugger,
): Promise<boolean> {
  logger.info(`[AWS] Navegando al PR para MERGE: ${prUrl}`);
  try {
    await navigateAndWait(page, prUrl, { timeout: 60_000, retries: 2 });
    debug?.log("Página del PR cargada para merge");
    await debug?.screenshot(page, "merge_page_loaded");

    // Click en botón "Merge"
    const mergeClicked = await waitForButton(page, "Merge", 30_000);
    if (!mergeClicked) {
      if (!(await clickMergeButton(page))) {
        debug?.log("❌ Botón Merge no encontrado");
        await debug?.screenshot(page, "merge_button_not_found");
        throw new Error("Botón Merge no encontrado");
      }
    }
    debug?.log("Click en Merge OK");

    // Esperar página de merge
    try {
      await page.waitForURL("**/merge**", { timeout: 15_000 });
    } catch {
      logger.warn(`[AWS] URL no cambió a /merge, actual: ${page.url()}`);
      debug?.log(`URL no cambió a /merge: ${page.url()}`);
    }
    await waitForAwsLoaders(page, 15_000);
    await waitForDomStable(page);
    await dismissPopups(page);
    debug?.log("Página de merge cargada");
    await debug?.screenshot(page, "merge_form_loaded");

    // Seleccionar 3-way merge
    if (!(await selectThreeWayMerge(page))) {
      debug?.log("❌ No se pudo seleccionar 3-way merge");
      await debug?.screenshot(page, "3way_merge_failed");
      await debug?.saveHtml(page, "3way_merge_failed");
      throw new Error("No se pudo seleccionar 3-way merge");
    }
    debug?.log("3-way merge seleccionado");
    await sleep(2_000);

    // Llenar Author name y Email
    await fillMergeAuthorFields(page, author);
    debug?.log(`Author fields: ${author?.name ?? "default"} / ${author?.email ?? "default"}`);
    await sleep(2_000);

    // Asegurar que "Delete source branch" NO esté marcado
    await uncheckDeleteBranch(page);
    await sleep(1_000);
    await debug?.screenshot(page, "before_merge_submit");

    // Click en "Merge pull request"
    await clickMergePullRequest(page);
    debug?.log("Click en 'Merge pull request'");

    await page
      .waitForLoadState("domcontentloaded", { timeout: 20_000 })
      .catch(() => {});
    await sleep(4_000);

    const finalUrl = page.url();
    debug?.log(`URL final post-merge: ${finalUrl}`);
    await debug?.screenshot(page, "after_merge_submit");

    logger.info(`[AWS] ✅ Merge enviado (URL: ${finalUrl})`);
    return true;
  } catch (e: unknown) {
    logger.error(`[AWS] Error en merge: ${e}`);
    debug?.log(`Error en merge: ${e}`);
    try {
      await debug?.screenshot(page, "merge_error");
    } catch { /* */ }
    return false;
  }
}

// ── Private helpers ──────────────────────────────────────────

async function clickMergeButton(page: Page): Promise<boolean> {
  const clicked = await page.evaluate(() => {
    const excludeAncestors = [
      "[id^='awsc-']",
      "#aws-nav-header",
      "[id='awsui-dropdown']",
    ].join(", ");

    const buttons = Array.from(document.querySelectorAll("button"));
    for (const btn of buttons) {
      if (btn.closest(excludeAncestors)) continue;
      const text = (btn.innerText || btn.textContent || "")
        .trim()
        .toLowerCase();
      if (text === "merge" && btn.offsetParent !== null && !btn.disabled) {
        btn.scrollIntoView({ behavior: "instant", block: "center" });
        btn.click();
        return true;
      }
    }
    for (const el of Array.from(document.querySelectorAll("span, div, a"))) {
      if (el.closest(excludeAncestors)) continue;
      if (
        el.children.length === 0 &&
        el.textContent?.trim().toLowerCase() === "merge"
      ) {
        const clickable = el.closest(
          'button, a, [role="button"]',
        ) as HTMLElement | null;
        if (clickable && !(clickable as HTMLButtonElement).disabled) {
          clickable.scrollIntoView({ behavior: "instant", block: "center" });
          clickable.click();
          return true;
        }
      }
    }
    return false;
  });

  if (clicked) {
    logger.info("[AWS] ✅ Click en Merge");
    return true;
  }

  for (const sel of [
    "button:has-text('Merge')",
    "[data-testid*='merge']",
    "button.awsui-button-variant-primary",
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2_000 })) {
        await el.scrollIntoViewIfNeeded();
        await el.click({ force: true });
        logger.info(`[AWS] ✅ Merge con selector: ${sel}`);
        return true;
      }
    } catch {
      /* next */
    }
  }
  return false;
}

async function selectThreeWayMerge(page: Page): Promise<boolean> {
  logger.info("[AWS] Seleccionando 3-way merge...");

  // Estrategia 1: locator directo por data-value
  try {
    const tile = page.locator("[data-value='THREE_WAY_MERGE']").first();
    if (await tile.isVisible({ timeout: 5_000 })) {
      await tile.click({ force: true });
      logger.info("[AWS] ✅ 3-way merge seleccionado via locator [data-value]");
      return true;
    }
  } catch {
    /* next */
  }

  // Estrategia 2: evaluate
  const clickedTile = await page.evaluate(() => {
    const tile = document.querySelector<HTMLElement>('[data-value="THREE_WAY_MERGE"]');
    if (tile) {
      tile.click();
      return "tile-container";
    }
    const labels = Array.from(document.querySelectorAll<HTMLElement>("span, label"));
    for (const el of labels) {
      if (el.textContent?.trim() === "3-way merge") {
        el.click();
        return "label";
      }
    }
    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    );
    for (const r of radios) {
      if (r.value === "THREE_WAY_MERGE") {
        r.click();
        r.checked = true;
        r.dispatchEvent(new Event("change", { bubbles: true }));
        r.dispatchEvent(new Event("input", { bubbles: true }));
        return "radio-input";
      }
    }
    return null;
  });

  if (clickedTile) {
    logger.info(`[AWS] ✅ 3-way merge seleccionado via evaluate: ${clickedTile}`);
    return true;
  }

  // Estrategia 3: más locators
  for (const sel of [
    "text=3-way merge",
    "label:has-text('3-way')",
    "input[value='THREE_WAY_MERGE']",
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2_000 })) {
        await el.click({ force: true });
        logger.info(`[AWS] ✅ 3-way merge con locator: ${sel}`);
        return true;
      }
    } catch {
      /* next */
    }
  }

  // Verificar si ya está seleccionado
  const alreadySelected = await page.evaluate(() => {
    const tile = document.querySelector('[data-value="THREE_WAY_MERGE"]');
    return tile?.classList.contains("awsui_selected_vj6p7_1five_423") ||
      tile?.className.includes("selected") || false;
  });

  if (alreadySelected) {
    logger.info("[AWS] ✅ 3-way merge ya estaba seleccionado");
    return true;
  }

  logger.error("[AWS] ❌ No se pudo seleccionar 3-way merge");
  return false;
}

async function fillReactInput(
  page: Page,
  selector: string,
  value: string,
): Promise<boolean> {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ state: "visible", timeout: 5_000 });
    await el.click();
    await el.press("Control+a");
    await el.press("Backspace");
    await el.type(value, { delay: 40 });
    await el.press("Tab");
    await sleep(300);
    logger.info(`[AWS] ✅ Campo '${selector}' llenado con: ${value}`);
    return true;
  } catch (e: unknown) {
    logger.warn(`[AWS] ⚠️ No se pudo llenar '${selector}': ${e}`);
    return false;
  }
}

async function fillMergeAuthorFields(page: Page, author?: { name: string; email: string }): Promise<void> {
  const authorName = author?.name ?? config.aws.authorName;
  const authorEmail = author?.email ?? config.aws.authorEmail;

  logger.info(`[AWS] Llenando Author name: ${authorName}`);
  const authorOk = await fillReactInput(page, "#awsui-input-0", authorName);
  if (!authorOk) {
    await fillReactInput(
      page,
      "input[type='text']:not([id*='search']):not([id*='filter'])",
      authorName,
    );
  }

  logger.info(`[AWS] Llenando Email: ${authorEmail}`);
  await sleep(300);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(authorEmail, { delay: 40 });
  await page.keyboard.press("Tab");
  await sleep(300);
  logger.info("[AWS] ✅ Email llenado");
}

async function uncheckDeleteBranch(page: Page): Promise<void> {
  logger.info("[AWS] Verificando checkbox Delete source branch...");
  try {
    await page.evaluate(() => {
      for (const cb of Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      )) {
        const parent = cb.closest(
          "div, li, span, label",
        ) as HTMLElement | null;
        const text = (parent?.innerText ?? "").toLowerCase();
        if (
          text.includes("delete") &&
          text.includes("branch") &&
          cb.checked
        ) {
          cb.click();
        }
      }
    });
  } catch (e: unknown) {
    logger.warn(`[AWS] Error checkbox Delete branch: ${e}`);
  }
}

async function clickMergePullRequest(page: Page): Promise<void> {
  logger.info("[AWS] Click en 'Merge pull request'...");
  await sleep(1_000);

  const clicked = await page.evaluate(() => {
    const excludeAncestors = [
      "[id^='awsc-']",
      "#aws-nav-header",
      "[id='awsui-dropdown']",
    ].join(", ");

    const buttons = Array.from(document.querySelectorAll("button"));
    for (const btn of buttons) {
      if (btn.closest(excludeAncestors)) continue;
      const text = (btn.innerText || btn.textContent || "")
        .trim()
        .toLowerCase();
      if (
        text.includes("merge pull request") &&
        btn.offsetParent !== null &&
        !btn.disabled
      ) {
        btn.scrollIntoView({ behavior: "instant", block: "center" });
        btn.click();
        return true;
      }
    }
    for (const btn of buttons) {
      if (btn.closest(excludeAncestors)) continue;
      const text = (btn.innerText || btn.textContent || "")
        .trim()
        .toLowerCase();
      const cls = btn.className.toLowerCase();
      if (
        text.includes("merge") &&
        btn.offsetParent !== null &&
        !btn.disabled &&
        (cls.includes("primary") || cls.includes("submit"))
      ) {
        btn.scrollIntoView({ behavior: "instant", block: "center" });
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (clicked) {
    logger.info("[AWS] ✅ Click en 'Merge pull request'");
    return;
  }

  for (const sel of [
    "button:has-text('Merge pull request')",
    "button[data-testid*='merge-submit']",
    "button.awsui-button-variant-primary:not([disabled])",
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3_000 })) {
        await el.scrollIntoViewIfNeeded();
        await el.click({ force: true });
        logger.info(`[AWS] ✅ Merge pull request con: ${sel}`);
        return;
      }
    } catch {
      /* next */
    }
  }
  logger.warn("[AWS] ⚠️ No se encontró botón Merge pull request");
}

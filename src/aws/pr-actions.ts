import type { Page } from "playwright";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { navigateAndWait, waitForAwsLoaders, waitForButton, sleep } from "./navigation.js";
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
    await dismissPopups(page);

    // Esperar a que el formulario de merge renderice (React SPA tarda en montar el contenido)
    const formRendered = await waitForMergeForm(page);
    if (!formRendered) {
      debug?.log("❌ El formulario de merge no renderizó a tiempo");
      await debug?.screenshot(page, "merge_form_not_rendered");
      await debug?.saveHtml(page, "merge_form_not_rendered");
      throw new Error("El formulario de merge no renderizó a tiempo");
    }
    debug?.log("Página de merge cargada");
    await debug?.screenshot(page, "merge_form_loaded");

    // Seleccionar 3-way merge (o verificar que ya está seleccionado por default)
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

/** Espera a que el formulario de merge renderice dentro del SPA */
async function waitForMergeForm(page: Page): Promise<boolean> {
  logger.info("[AWS] Esperando que el formulario de merge renderice...");
  const timeout = 30_000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const formExists = await page.evaluate(() => {
      // Indicadores de que el formulario de merge se montó:
      // 1. Botón "Merge pull request" visible
      const buttons = Array.from(document.querySelectorAll("button"));
      const hasMergeBtn = buttons.some(btn => {
        const text = (btn.innerText || btn.textContent || "").trim().toLowerCase();
        return text.includes("merge pull request") && btn.offsetParent !== null;
      });
      if (hasMergeBtn) return true;

      // 2. Input de Author name existe
      const inputs = document.querySelectorAll('input[type="text"]');
      if (inputs.length >= 2) return true;

      // 3. Tiles de merge strategy existen
      const tiles = document.querySelectorAll('[class*="tiles"], [class*="tile_container"]');
      if (tiles.length > 0) return true;

      // 4. Texto "3-way merge" existe en la página
      const allText = document.body?.innerText ?? "";
      if (allText.includes("3-way merge") || allText.includes("Fast forward")) return true;

      return false;
    });

    if (formExists) {
      logger.info("[AWS] ✅ Formulario de merge renderizado");
      await sleep(1_000); // Extra buffer para que React termine de montar todo
      return true;
    }

    await sleep(500);
  }

  logger.error("[AWS] ❌ Timeout esperando formulario de merge");
  return false;
}

async function selectThreeWayMerge(page: Page): Promise<boolean> {
  logger.info("[AWS] Seleccionando 3-way merge...");

  // Estrategia 1: locator directo por data-value
  try {
    const tile = page.locator("[data-value='THREE_WAY_MERGE']").first();
    if (await tile.isVisible({ timeout: 3_000 })) {
      await tile.click({ force: true });
      logger.info("[AWS] ✅ 3-way merge seleccionado via locator [data-value]");
      return true;
    }
  } catch {
    /* next */
  }

  // Estrategia 2: evaluate — buscar por texto "3-way merge" en tiles y hacer click
  const clickedTile = await page.evaluate(() => {
    // Buscar tile container con data-value
    const tile = document.querySelector<HTMLElement>('[data-value="THREE_WAY_MERGE"]');
    if (tile) {
      tile.click();
      return "data-value-tile";
    }

    // Buscar por texto "3-way merge" en cualquier elemento clickeable dentro de tiles
    const allElements = Array.from(document.querySelectorAll<HTMLElement>("*"));
    for (const el of allElements) {
      if (el.children.length > 0) continue; // Solo leaf nodes
      const text = el.textContent?.trim() ?? "";
      if (text === "3-way merge" || text === "3-way merge\ngit merge --no-ff") {
        // Subir al contenedor tile (el div clickeable)
        const tileContainer = el.closest('[class*="tile"], [role="radio"], [class*="awsui_tile"]') as HTMLElement | null;
        if (tileContainer) {
          tileContainer.click();
          return "tile-ancestor";
        }
        // Si no hay tile container, click directo en el label/span
        el.click();
        return "label-direct";
      }
    }

    // Buscar el primer tile que contenga "3-way" en su texto
    const tileElements = Array.from(document.querySelectorAll<HTMLElement>('[class*="awsui_tile"], [class*="tile-"]'));
    for (const t of tileElements) {
      const innerText = (t.innerText || t.textContent || "").toLowerCase();
      if (innerText.includes("3-way")) {
        t.click();
        return "tile-class-match";
      }
    }

    // Input radio con value THREE_WAY_MERGE
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    for (const r of radios) {
      if (r.value === "THREE_WAY_MERGE" || r.value === "three_way_merge") {
        r.click();
        r.checked = true;
        r.dispatchEvent(new Event("change", { bubbles: true }));
        r.dispatchEvent(new Event("input", { bubbles: true }));
        return "radio-input";
      }
    }

    // Último intento: buscar radio cuyo label contenga "3-way"
    for (const r of radios) {
      const label = r.closest("label") ?? document.querySelector(`label[for="${r.id}"]`);
      const parentDiv = r.closest('[class*="tile"]') as HTMLElement | null;
      const context = label?.textContent ?? parentDiv?.textContent ?? "";
      if (context.toLowerCase().includes("3-way")) {
        r.click();
        r.checked = true;
        r.dispatchEvent(new Event("change", { bubbles: true }));
        r.dispatchEvent(new Event("input", { bubbles: true }));
        return "radio-by-label";
      }
    }

    return null;
  });

  if (clickedTile) {
    logger.info(`[AWS] ✅ 3-way merge seleccionado via evaluate: ${clickedTile}`);
    return true;
  }

  // Estrategia 3: Playwright locators
  for (const sel of [
    "text=3-way merge",
    "label:has-text('3-way')",
    "[role='radio']:has-text('3-way')",
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

  // Verificar si ya está seleccionado (clase contiene "selected" o aria-checked)
  const alreadySelected = await page.evaluate(() => {
    // Buscar por data-value
    const tile = document.querySelector('[data-value="THREE_WAY_MERGE"]');
    if (tile?.className.includes("selected")) return true;
    if (tile?.getAttribute("aria-checked") === "true") return true;

    // Buscar cualquier tile/radio con "3-way" que esté seleccionado
    const allTiles = Array.from(document.querySelectorAll('[class*="tile"], [role="radio"]'));
    for (const t of allTiles) {
      const text = (t.textContent ?? "").toLowerCase();
      if (text.includes("3-way")) {
        if (t.className.includes("selected") || t.getAttribute("aria-checked") === "true") {
          return true;
        }
      }
    }

    // Verificar radio inputs
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    for (const r of radios) {
      if ((r.value === "THREE_WAY_MERGE" || r.value === "three_way_merge") && r.checked) {
        return true;
      }
    }

    return false;
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

  // Estrategia: buscar el input por contexto de label "Author name" y llenarlo con interacción real
  let authorInputFilled = false;

  // Intentar localizar el input de Author name por label y hacer click + type (interacción real)
  const authorInputFound = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("label, span, div"));
    for (const lbl of labels) {
      if (lbl.children.length > 0) continue;
      const text = (lbl.textContent ?? "").trim().toLowerCase();
      if (text === "author name") {
        const container = lbl.closest('[class*="form-field"], [class*="FormField"], div') as HTMLElement | null;
        const input = container?.querySelector('input[type="text"]') as HTMLInputElement | null;
        if (input) {
          input.scrollIntoView({ behavior: "instant", block: "center" });
          input.focus();
          input.click();
          return true;
        }
      }
    }
    return false;
  });

  if (authorInputFound) {
    // El foco real está en el input de Author name — escribir con keyboard
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(authorName, { delay: 40 });
    logger.info("[AWS] ✅ Author name llenado via focus + keyboard");
    authorInputFilled = true;
  } else {
    // Fallback: buscar por ID pattern awsui-input-*
    authorInputFilled = await fillReactInput(page, "input[id^='awsui-input-'][type='text']", authorName);
    if (!authorInputFilled) {
      authorInputFilled = await fillReactInput(page, "input[type='text']:not([id*='search']):not([id*='filter'])", authorName);
    }
  }

  // Ahora llenar Email address
  await sleep(500);
  logger.info(`[AWS] Llenando Email: ${authorEmail}`);

  // Estrategia 1: Tab desde Author name (el foco debería estar ahí tras escribir)
  if (authorInputFilled) {
    await page.keyboard.press("Tab");
    await sleep(500);

    // Verificar si el foco cayó en el input de Email address
    const focusedOnEmail = await page.evaluate(() => {
      const active = document.activeElement as HTMLInputElement | null;
      if (active?.tagName === "INPUT" && active.type === "text") {
        // Verificar que el input está en el contexto de "Email address"
        const container = active.closest('[class*="form-field"], [class*="FormField"], div') as HTMLElement | null;
        const containerText = (container?.textContent ?? "").toLowerCase();
        if (containerText.includes("email")) return true;
        // Si no tiene contexto de email, verificar que no es el de Author name
        if (!containerText.includes("author name")) return true;
      }
      return false;
    });

    if (focusedOnEmail) {
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(authorEmail, { delay: 40 });
      await page.keyboard.press("Tab");
      await sleep(300);
      logger.info("[AWS] ✅ Email llenado via Tab desde Author name");
      return;
    }

    logger.warn("[AWS] ⚠️ Tab no llevó al campo Email, buscando por label...");
  }

  // Estrategia 2: Localizar el input de Email directamente por su label
  const emailInputFound = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("label, span, div"));
    for (const lbl of labels) {
      if (lbl.children.length > 0) continue;
      const text = (lbl.textContent ?? "").trim().toLowerCase();
      if (text === "email address") {
        const container = lbl.closest('[class*="form-field"], [class*="FormField"], div') as HTMLElement | null;
        const input = container?.querySelector('input[type="text"]') as HTMLInputElement | null;
        if (input) {
          input.scrollIntoView({ behavior: "instant", block: "center" });
          input.focus();
          input.click();
          return true;
        }
      }
    }
    return false;
  });

  if (emailInputFound) {
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(authorEmail, { delay: 40 });
    await page.keyboard.press("Tab");
    await sleep(300);
    logger.info("[AWS] ✅ Email llenado via localización directa por label");
    return;
  }

  // Estrategia 3: Buscar el segundo input de texto en la página de merge
  logger.warn("[AWS] ⚠️ No se encontró input de Email por label, intentando segundo input...");
  const secondInputFilled = await page.evaluate((email: string) => {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(
      'input[type="text"]:not([id*="search"]):not([id*="filter"])'
    )).filter(inp => inp.offsetParent !== null);
    // El segundo input visible de tipo texto debería ser Email
    if (inputs.length >= 2) {
      const emailInput = inputs[1];
      emailInput.scrollIntoView({ behavior: "instant", block: "center" });
      emailInput.focus();
      emailInput.click();
      emailInput.value = email;
      emailInput.dispatchEvent(new Event("input", { bubbles: true }));
      emailInput.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }, authorEmail);

  if (secondInputFilled) {
    logger.info("[AWS] ✅ Email llenado via segundo input de texto");
  } else {
    logger.error("[AWS] ❌ No se pudo llenar el campo Email address");
  }
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

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { PrFlowResult } from "../types.js";

const FEEDBACK_MODAL_SELECTORS = [
  "div[role='dialog'] button:has-text('Cancel')",
  "[class*='modal-footer'] button:has-text('Cancel')",
  "div[aria-modal='true'] button:has-text('Cancel')",
  "button[aria-label='Close feedback dialog']",
  "div[role='dialog'] button[aria-label='Close']",
];

const SAFE_POPUP_SELECTORS = [
  "#awsccc-cb-btn-accept",
  "button[data-id='awsccc-accept-btn']",
  "button[data-testid='whats-new-close']",
  "[id*='notification'] button[aria-label='Close']",
];

/** Script inyectado para auto-cerrar el modal de Feedback de AWS */
const AUTO_DISMISS_SCRIPT = `
  const observer = new MutationObserver(() => {
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.textContent?.trim() === 'Feedback for AWS Sign-in') {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.trim() === 'Cancel' && btn.offsetParent !== null) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) { btn.click(); return; }
          }
        }
        const closeBtn = document.querySelector('[aria-label="Close"], [aria-label="close"]');
        if (closeBtn instanceof HTMLElement) closeBtn.click();
        break;
      }
    }
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
`;

export class AWSBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: config.headless,
      slowMo: 50,
    });

    this.context = existsSync(config.sessionFile)
      ? await this.browser.newContext({ storageState: config.sessionFile })
      : await this.browser.newContext();

    this.page = await this.context.newPage();
    await this.page.addInitScript(AUTO_DISMISS_SCRIPT);
  }

  /** Ensures the browser is started. Safe to call multiple times. */
  async ensureStarted(): Promise<void> {
    if (this.browser && this.page) return;
    logger.info("🌐 Iniciando browser...");
    await this.start();
    logger.info("🌐 Browser iniciado ✅");
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  private get pg(): Page {
    if (!this.page) throw new Error("Browser not started. Call start() first.");
    return this.page;
  }

  // ── Popups & Modals ────────────────────────────────────────

  private async dismissFeedbackModal(): Promise<void> {
    try {
      const title = this.pg.locator("text='Feedback for AWS Sign-in'");
      if (!(await title.isVisible({ timeout: 1_000 }))) return;

      logger.info("[AWS] Modal Feedback detectado, cerrando...");

      for (const sel of FEEDBACK_MODAL_SELECTORS) {
        try {
          const btn = this.pg.locator(sel).first();
          if (await btn.isVisible({ timeout: 1_000 })) {
            await btn.click();
            await this.sleep(500);
            return;
          }
        } catch {
          /* next selector */
        }
      }
      await this.pg.keyboard.press("Escape");
      await this.sleep(500);
    } catch {
      /* no modal */
    }
  }

  /** Salta la pantalla "Handle expiring password" si aparece post-login */
  private async skipExpiringPassword(): Promise<void> {
    try {
      const skipSelectors = [
        "a:has-text('Skip and continue to sign in')",
        "a:has-text('Skip')",
        "button:has-text('Skip')",
      ];

      for (const sel of skipSelectors) {
        try {
          const link = this.pg.locator(sel).first();
          if (await link.isVisible({ timeout: 3_000 })) {
            await link.click();
            logger.info("[AWS] 🔑 Pantalla 'Handle expiring password' saltada");
            await this.pg.waitForLoadState("domcontentloaded", {
              timeout: 10_000,
            });
            await this.sleep(2_000);
            return;
          }
        } catch {
          /* next selector */
        }
      }
    } catch {
      /* no expiring password screen */
    }
  }

  private async dismissCookieModal(): Promise<void> {
    try {
      // El banner de cookies de AWS usa el id "awsccc-cb-btn-accept"
      // o un botón con texto "Accept" dentro del banner de cookies
      const cookieSelectors = [
        "#awsccc-cb-btn-accept",
        "button[data-id='awsccc-cb-btn-accept']",
        "#awsccc-cb-content button:has-text('Accept')",
        "[id*='awsccc'] button:has-text('Accept')",
        "div[class*='cookie'] button:has-text('Accept')",
      ];

      for (const sel of cookieSelectors) {
        try {
          const btn = this.pg.locator(sel).first();
          if (await btn.isVisible({ timeout: 1_000 })) {
            await btn.click();
            logger.info("[AWS] 🍪 Modal de cookies aceptado");
            await this.sleep(500);
            return;
          }
        } catch {
          /* next selector */
        }
      }
    } catch {
      /* no cookie modal */
    }
  }

  private async dismissPopups(): Promise<void> {
    await this.dismissFeedbackModal();
    await this.dismissCookieModal();
    for (const sel of SAFE_POPUP_SELECTORS) {
      try {
        const btn = this.pg.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click();
          await this.sleep(300);
        }
      } catch {
        /* ignore */
      }
    }
  }

  // ── Session ────────────────────────────────────────────────

  private async saveSession(): Promise<void> {
    await this.context?.storageState({ path: config.sessionFile });
  }

  private async isLoggedIn(): Promise<boolean> {
    try {
      await this.pg.goto("https://console.aws.amazon.com/console/home", {
        waitUntil: "networkidle",
        timeout: 15_000,
      });
      return !this.pg.url().includes("signin");
    } catch {
      return false;
    }
  }

  // ── Login ──────────────────────────────────────────────────

  private async login(): Promise<boolean> {
    const { loginUrl, accountId, username, password } = config.aws;
    logger.info(`[AWS] Navegando a login: ${loginUrl}`);
    await this.pg.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await this.sleep(1_000);
    await this.dismissPopups();

    // Account ID (si lo pide)
    try {
      const accountField = this.pg.locator("#account");
      if (await accountField.isVisible({ timeout: 3_000 })) {
        await accountField.fill(accountId);
        await this.dismissPopups();
        await this.pg.click("#next_button, [type='submit']");
        await this.pg.waitForLoadState("domcontentloaded");
        await this.sleep(1_000);
        await this.dismissPopups();
      }
    } catch {
      /* no account field */
    }

    // Username
    try {
      await this.dismissPopups();
      const userField = this.pg
        .locator("#username, #resolving_input, input[name='username']")
        .first();
      await userField.waitFor({ timeout: 5_000 });
      await userField.fill(username);
      logger.info("[AWS] Usuario llenado ✅");
    } catch (e) {
      logger.error(`[AWS] Error llenando usuario: ${e}`);
      return false;
    }

    // Password + Sign In
    try {
      await this.dismissPopups();
      const passField = this.pg
        .locator("#password, input[name='password'], input[type='password']")
        .first();
      await passField.waitFor({ timeout: 5_000 });
      await passField.fill(password);
      logger.info("[AWS] Contraseña llenada, haciendo Sign In...");
      await this.dismissFeedbackModal();

      const signinBtn = this.pg.locator("#signin_button");
      if (await signinBtn.isVisible({ timeout: 2_000 })) {
        await signinBtn.click();
      } else {
        await this.pg
          .locator("form")
          .evaluate((form: HTMLFormElement) => form.submit());
      }
      await this.pg.waitForLoadState("domcontentloaded");
      await this.sleep(2_000);
      await this.dismissFeedbackModal();
    } catch (e) {
      logger.error(`[AWS] Error llenando contraseña: ${e}`);
      return false;
    }

    // MFA (manual — el usuario lo ingresa en el browser)
    await this.waitForManualMfa();

    // Skip "Handle expiring password" si aparece
    await this.skipExpiringPassword();

    await this.dismissPopups();
    await this.sleep(1_000);

    const url = this.pg.url();
    logger.info(`[AWS] URL post-login: ${url}`);

    if (url.includes("console.aws.amazon.com") || url.includes("console.aws")) {
      await this.saveSession();
      await this.dismissCookieModal();
      logger.info("[AWS] ✅ Login exitoso");
      return true;
    }
    if (url.includes("signin.aws.amazon.com")) {
      logger.error("[AWS] ❌ Login falló — sigue en página de login");
      return false;
    }
    // URL inesperada post-login — asumir éxito
    logger.warn(`[AWS] URL inesperada post-login: ${url} — asumiendo éxito`);
    await this.saveSession();
    await this.dismissCookieModal();
    return true;
  }

  private async waitForManualMfa(): Promise<void> {
    try {
      await this.dismissPopups();
      const mfaField = this.pg
        .locator(
          [
            "#mfaCode",
            "input[name='mfaCode']",
            "input[placeholder*='MFA']",
            "input[placeholder*='code']",
            "input[autocomplete='one-time-code']",
          ].join(", "),
        )
        .first();

      if (!(await mfaField.isVisible({ timeout: 8_000 }))) return;

      logger.info(
        "[AWS] 🔐 Pantalla MFA detectada — ingresa tu código en el browser",
      );
      logger.info("[AWS] ⏳ Tienes 30 segundos...");

      for (let remaining = 30; remaining > 0; remaining--) {
        logger.info(`[AWS] ⏱ Esperando MFA... ${remaining}`);
        await this.sleep(1_000);

        const currentUrl = this.pg.url();
        if (
          currentUrl.includes("console.aws.amazon.com") ||
          !currentUrl.toLowerCase().includes("mfa")
        ) {
          if (!(await mfaField.isVisible({ timeout: 500 }))) {
            logger.info("[AWS] ✅ MFA ingresado — continuando");
            break;
          }
        }
      }

      await this.pg.waitForLoadState("domcontentloaded");
      await this.sleep(1_000);
      await this.dismissFeedbackModal();
    } catch (e) {
      logger.warn(`[AWS] MFA no requerido o ya pasó: ${e}`);
    }
  }

  // ── Role Switching ─────────────────────────────────────────

  private async switchRole(
    roleUrl: string,
    roleName: string,
  ): Promise<boolean> {
    logger.info(`[AWS] Cambiando a rol: ${roleName}`);
    try {
      await this.navigateAndWait(roleUrl, { timeout: 30_000 });

      const submitBtn = this.pg
        .locator(
          [
            "#input_switchrole_button",
            "button[type='submit']",
            "input[type='submit']",
            "button:has-text('Switch Role')",
          ].join(", "),
        )
        .first();

      await submitBtn.waitFor({ timeout: 8_000 });
      await submitBtn.click();

      try {
        await this.pg.waitForLoadState("domcontentloaded", { timeout: 15_000 });
      } catch {
        /* timeout ok */
      }
      await this.waitForAwsLoaders(15_000);
      await this.waitForDomStable();

      logger.info(`[AWS] Rol ${roleName} activado ✅`);
      return true;
    } catch (e) {
      logger.error(`[AWS] Error cambiando a rol ${roleName}: ${e}`);
      return false;
    }
  }

  // ── Approve PR ─────────────────────────────────────────────

  private async approvePr(prUrl: string): Promise<boolean> {
    logger.info(`[AWS] Navegando al PR para APROBAR: ${prUrl}`);
    try {
      await this.navigateAndWait(prUrl, { timeout: 60_000 });

      // Esperar a que el botón Approve aparezca en la página (polling)
      const approveBtn = await this.waitForButton("Approve", 30_000);
      if (approveBtn) {
        logger.info(`[AWS] ✅ Approve via polling: '${approveBtn}'`);
        await this.sleep(2_000);
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
          const btn = this.pg.locator(sel).first();
          if (await btn.isVisible({ timeout: 3_000 })) {
            await btn.scrollIntoViewIfNeeded();
            await btn.click({ force: true });
            logger.info(`[AWS] ✅ Approve con selector: ${sel}`);
            await this.sleep(3_000);
            return true;
          }
        } catch {
          /* next */
        }
      }

      await this.pg.screenshot({ path: "error_approve.png" });
      logger.error("[AWS] ❌ No se encontró el botón Approve");
      return false;
    } catch (e) {
      logger.error(`[AWS] Error aprobando PR: ${e}`);
      try {
        await this.pg.screenshot({ path: "error_approve.png" });
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  // ── Merge PR ───────────────────────────────────────────────

  private async mergePr(prUrl: string): Promise<boolean> {
    logger.info(`[AWS] Navegando al PR para MERGE: ${prUrl}`);
    try {
      await this.navigateAndWait(prUrl, { timeout: 60_000 });

      // Click en botón "Merge"
      const mergeClicked = await this.waitForButton("Merge", 30_000);
      if (!mergeClicked) {
        // Playwright fallback
        if (!(await this.clickMergeButton())) {
          await this.pg.screenshot({ path: "error_merge_no_button.png" });
          throw new Error("Botón Merge no encontrado");
        }
      }

      // Esperar página de merge
      try {
        await this.pg.waitForURL("**/merge**", { timeout: 15_000 });
      } catch {
        logger.warn(`[AWS] URL no cambió a /merge, actual: ${this.pg.url()}`);
      }
      await this.waitForAwsLoaders(15_000);
      await this.waitForDomStable();
      await this.dismissPopups();

      // Seleccionar 3-way merge
      await this.selectThreeWayMerge();
      await this.sleep(2_000);

      // Llenar Author name y Email
      await this.fillMergeAuthorFields();
      await this.sleep(2_000);

      // Asegurar que "Delete source branch" NO esté marcado
      await this.uncheckDeleteBranch();
      await this.sleep(1_000);

      // Click en "Merge pull request"
      await this.clickMergePullRequest();

      await this.pg
        .waitForLoadState("domcontentloaded", { timeout: 20_000 })
        .catch(() => {});
      await this.sleep(4_000);

      logger.info(`[AWS] ✅ Merge enviado (URL: ${this.pg.url()})`);
      return true;
    } catch (e) {
      logger.error(`[AWS] Error en merge: ${e}`);
      try {
        await this.pg.screenshot({ path: "error_merge.png" });
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  private async clickMergeButton(): Promise<boolean> {
    const clicked = await this.pg.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || "")
          .trim()
          .toLowerCase();
        if (text === "merge" && btn.offsetParent !== null) {
          btn.scrollIntoView({ behavior: "instant", block: "center" });
          btn.click();
          return true;
        }
      }
      // Fallback: span/div con texto 'Merge' dentro de un botón
      for (const el of Array.from(document.querySelectorAll("span, div, a"))) {
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

    // Playwright fallback
    for (const sel of [
      "button:has-text('Merge')",
      "[data-testid*='merge']",
      "button.awsui-button-variant-primary",
    ]) {
      try {
        const el = this.pg.locator(sel).first();
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

  private async selectThreeWayMerge(): Promise<void> {
    logger.info("[AWS] Seleccionando 3-way merge...");
    const selected = await this.pg.evaluate(() => {
      const radios = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          'input[type="radio"][name="merge-strategies"]',
        ),
      );
      for (const r of radios) {
        if (r.value === "THREE_WAY_MERGE") {
          r.click();
          return true;
        }
      }
      return false;
    });

    if (selected) {
      logger.info("[AWS] ✅ 3-way merge seleccionado");
      return;
    }

    // Playwright fallback
    for (const sel of [
      "text=3-way merge",
      "[aria-label*='3-way']",
      "label:has-text('3-way')",
      "input[value='THREE_WAY_MERGE']",
    ]) {
      try {
        const el = this.pg.locator(sel).first();
        if (await el.isVisible({ timeout: 2_000 })) {
          await el.click({ force: true });
          logger.info(`[AWS] ✅ 3-way merge con locator: ${sel}`);
          return;
        }
      } catch {
        /* next */
      }
    }
    logger.warn("[AWS] ⚠️ No se pudo seleccionar 3-way merge");
  }

  private async fillReactInput(
    selector: string,
    value: string,
  ): Promise<boolean> {
    try {
      const el = this.pg.locator(selector).first();
      await el.waitFor({ state: "visible", timeout: 5_000 });
      await el.click();
      await el.press("Control+a");
      await el.press("Backspace");
      await el.type(value, { delay: 40 });
      await el.press("Tab");
      await this.sleep(300);
      logger.info(`[AWS] ✅ Campo '${selector}' llenado con: ${value}`);
      return true;
    } catch (e) {
      logger.warn(`[AWS] ⚠️ No se pudo llenar '${selector}': ${e}`);
      return false;
    }
  }

  private async fillMergeAuthorFields(): Promise<void> {
    const { authorName, authorEmail } = config.aws;

    logger.info(`[AWS] Llenando Author name: ${authorName}`);
    const authorOk = await this.fillReactInput("#awsui-input-0", authorName);
    if (!authorOk) {
      await this.fillReactInput(
        "input[type='text']:not([id*='search']):not([id*='filter'])",
        authorName,
      );
    }

    // Email: aprovechar que el Tab del Author dejó el foco en el campo email
    logger.info(`[AWS] Llenando Email: ${authorEmail}`);
    await this.sleep(300);
    await this.pg.keyboard.press("Control+a");
    await this.pg.keyboard.press("Backspace");
    await this.pg.keyboard.type(authorEmail, { delay: 40 });
    await this.pg.keyboard.press("Tab");
    await this.sleep(300);
    logger.info("[AWS] ✅ Email llenado");
  }

  private async uncheckDeleteBranch(): Promise<void> {
    logger.info("[AWS] Verificando checkbox Delete source branch...");
    try {
      await this.pg.evaluate(() => {
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
    } catch (e) {
      logger.warn(`[AWS] Error checkbox Delete branch: ${e}`);
    }
  }

  private async clickMergePullRequest(): Promise<void> {
    logger.info("[AWS] Click en 'Merge pull request'...");
    await this.sleep(1_000);

    const clicked = await this.pg.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      for (const btn of buttons) {
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

    // Playwright fallback
    for (const sel of [
      "button:has-text('Merge pull request')",
      "button[data-testid*='merge-submit']",
      "button.awsui-button-variant-primary:not([disabled])",
    ]) {
      try {
        const el = this.pg.locator(sel).first();
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

  // ── Full PR Flow ───────────────────────────────────────────

  async fullPrFlow(prUrl: string): Promise<PrFlowResult> {
    const result: PrFlowResult = { success: false, steps: [] };

    try {
      // 0. Ensure browser is running
      await this.ensureStarted();

      // 1. Login
      if (!(await this.isLoggedIn())) {
        if (!(await this.login())) {
          result.error = "No se pudo hacer login en AWS";
          return result;
        }
      }
      result.steps.push("✅ Login en AWS");

      // 2. Authorizer → Approve
      if (
        !(await this.switchRole(config.roles.authorizer, "devops/Authorizer"))
      ) {
        result.error = "Falló switch a devops/Authorizer";
        return result;
      }
      if (!(await this.approvePr(prUrl))) {
        result.error = "Falló aprobación con devops/Authorizer";
        return result;
      }
      result.steps.push("✅ Aprobado con devops/Authorizer");

      // 3. Manager → Approve
      if (!(await this.switchRole(config.roles.manager, "devops/Manager"))) {
        result.error = "Falló switch a devops/Manager";
        return result;
      }
      if (!(await this.approvePr(prUrl))) {
        result.error = "Falló aprobación con devops/Manager";
        return result;
      }
      result.steps.push("✅ Aprobado con devops/Manager");

      // 4. MergeMaster → Merge
      if (!(await this.switchRole(config.roles.merge, "MergeMaster"))) {
        result.error = "Falló switch a MergeMaster";
        return result;
      }
      if (!(await this.mergePr(prUrl))) {
        result.error = "Falló el merge con MergeMaster";
        return result;
      }
      result.steps.push("✅ Merge completado con MergeMaster");

      await this.saveSession();
      result.success = true;
    } catch (e) {
      result.error = String(e);
    }

    return result;
  }

  // ── Navigation ───────────────────────────────────────────

  /**
   * Espera a que un botón con el texto exacto aparezca visible en la página,
   * haciendo polling cada 2s. Cuando lo encuentra, le da click.
   * Retorna el texto del botón si lo encontró, o null si se agotó el timeout.
   */
  private async waitForButton(
    buttonText: string,
    timeout = 30_000,
  ): Promise<string | null> {
    const deadline = Date.now() + timeout;
    const textLower = buttonText.toLowerCase();

    logger.info(`[AWS] ⏳ Esperando botón '${buttonText}'...`);

    while (Date.now() < deadline) {
      const result = await this.pg.evaluate((textLower) => {
        const buttons = Array.from(document.querySelectorAll("button"));
        // Exacto
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || "")
            .trim()
            .toLowerCase();
          if (
            text === textLower &&
            btn.offsetParent !== null &&
            !btn.disabled
          ) {
            btn.scrollIntoView({ behavior: "instant", block: "center" });
            btn.click();
            return btn.innerText.trim();
          }
        }
        // Contiene el texto (pero no 'revoke' ni 'close')
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || "")
            .trim()
            .toLowerCase();
          if (
            text.includes(textLower) &&
            !text.includes("revoke") &&
            !text.includes("close") &&
            btn.offsetParent !== null &&
            !btn.disabled
          ) {
            btn.scrollIntoView({ behavior: "instant", block: "center" });
            btn.click();
            return btn.innerText.trim();
          }
        }
        return null;
      }, textLower);

      if (result) return result;

      await this.sleep(2_000);
    }

    return null;
  }

  /**
   * Navega a una URL y espera a que la página esté lista para interactuar:
   * 1. goto con domcontentloaded (no networkidle — AWS nunca para de hacer requests)
   * 2. Espera a que desaparezcan spinners/loaders de la consola AWS
   * 3. Espera estabilidad del DOM (sin mutaciones por 1s)
   */
  private async navigateAndWait(
    url: string,
    opts?: { timeout?: number },
  ): Promise<void> {
    const timeout = opts?.timeout ?? 60_000;
    logger.info(`[AWS] Navegando a: ${url}`);

    await this.pg.goto(url, { waitUntil: "domcontentloaded", timeout });

    // Esperar que desaparezcan spinners/loaders de AWS Console
    await this.waitForAwsLoaders(timeout);

    // Esperar estabilidad del DOM
    await this.waitForDomStable();

    await this.dismissPopups();
    logger.info("[AWS] ✅ Página cargada completamente");
  }

  /** Espera a que los spinners/loaders típicos de AWS Console desaparezcan */
  private async waitForAwsLoaders(timeout: number): Promise<void> {
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
          const visible = await this.pg
            .locator(sel)
            .first()
            .isVisible({ timeout: 500 });
          if (!visible) break;
          logger.info(`[AWS] ⏳ Esperando loader: ${sel}`);
          await this.sleep(500);
        } catch {
          break;
        }
      }
    }
  }

  /** Espera a que el DOM se estabilice (sin mutaciones por 1 segundo) */
  private async waitForDomStable(
    stableMs = 1_000,
    timeout = 15_000,
  ): Promise<void> {
    try {
      await this.pg.evaluate(
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
            // Kick off initial timer in case DOM is already stable
            timer = setTimeout(() => {
              observer.disconnect();
              clearTimeout(maxTimer);
              resolve();
            }, stableMs);
          }),
        { stableMs, timeout },
      );
    } catch {
      // Si falla el evaluate, al menos esperamos un poco
      await this.sleep(stableMs);
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

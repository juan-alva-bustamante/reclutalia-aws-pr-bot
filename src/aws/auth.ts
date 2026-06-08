import type { Page, BrowserContext } from "playwright";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { navigateAndWait, waitForAwsLoaders, waitForDomStable, sleep } from "./navigation.js";
import { dismissFeedbackModal, dismissCookieModal, dismissPopups } from "./popups.js";

/** Callback type para solicitar MFA por Telegram */
export type MfaCallback = () => Promise<string | null>;

/** Verifica si hay una sesión activa en AWS Console */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    logger.info("[AWS] Verificando sesión activa...");
    await page.goto("https://console.aws.amazon.com/console/home", {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await sleep(5_000);
    const url = page.url();
    const loggedIn = !url.includes("signin");
    if (loggedIn) {
      logger.info("[AWS] ✅ Sesión activa detectada, saltando login");
      await dismissPopups(page);
    } else {
      logger.info("[AWS] ❌ No hay sesión activa, se requiere login");
    }
    return loggedIn;
  } catch {
    return false;
  }
}

/** Ejecuta el flujo completo de login en AWS Console */
export async function login(page: Page, onMfaRequired: MfaCallback | null): Promise<boolean> {
  const { loginUrl, accountId, username, password } = config.aws;
  logger.info(`[AWS] Navegando a login: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  await sleep(1_000);
  await dismissPopups(page);

  // Account ID (si lo pide)
  try {
    const accountField = page.locator("#account");
    if (await accountField.isVisible({ timeout: 3_000 })) {
      await accountField.fill(accountId);
      await dismissPopups(page);
      await page.click("#next_button, [type='submit']");
      await page.waitForLoadState("domcontentloaded");
      await sleep(1_000);
      await dismissPopups(page);
    }
  } catch {
    /* no account field */
  }

  // Username
  try {
    await dismissPopups(page);
    const userField = page
      .locator("#username, #resolving_input, input[name='username']")
      .first();
    await userField.waitFor({ timeout: 5_000 });
    await userField.fill(username);
    logger.info("[AWS] Usuario llenado ✅");
  } catch (e: unknown) {
    logger.error(`[AWS] Error llenando usuario: ${e}`);
    return false;
  }

  // Password + Sign In
  try {
    await dismissPopups(page);
    const passField = page
      .locator("#password, input[name='password'], input[type='password']")
      .first();
    await passField.waitFor({ timeout: 5_000 });
    await passField.fill(password);
    logger.info("[AWS] Contraseña llenada, haciendo Sign In...");
    await dismissFeedbackModal(page);

    const signinBtn = page.locator("#signin_button");
    if (await signinBtn.isVisible({ timeout: 2_000 })) {
      await signinBtn.click();
    } else {
      await page
        .locator("form")
        .evaluate((form: HTMLFormElement) => form.submit());
    }
    await page.waitForLoadState("domcontentloaded");
    await sleep(2_000);
    await dismissFeedbackModal(page);
  } catch (e: unknown) {
    logger.error(`[AWS] Error llenando contraseña: ${e}`);
    return false;
  }

  // MFA
  await waitForManualMfa(page, onMfaRequired);

  // Skip "Handle expiring password" si aparece
  await skipExpiringPassword(page);

  await dismissPopups(page);
  await sleep(1_000);

  const url = page.url();
  logger.info(`[AWS] URL post-login: ${url}`);

  if (url.includes("console.aws.amazon.com") || url.includes("console.aws")) {
    await dismissCookieModal(page);
    logger.info("[AWS] ✅ Login exitoso");
    return true;
  }
  if (url.includes("signin.aws.amazon.com")) {
    logger.error("[AWS] ❌ Login falló — sigue en página de login");
    return false;
  }
  logger.warn(`[AWS] URL inesperada post-login: ${url} — asumiendo éxito`);
  await dismissCookieModal(page);
  return true;
}

/** Cambia al rol especificado en AWS Console */
export async function switchRole(
  page: Page,
  roleUrl: string,
  roleName: string,
): Promise<boolean> {
  logger.info(`[AWS] Cambiando a rol: ${roleName}`);
  try {
    await navigateAndWait(page, roleUrl, { timeout: 30_000 });

    const submitBtn = page
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
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
    } catch {
      /* timeout ok */
    }
    await waitForAwsLoaders(page, 15_000);
    await waitForDomStable(page);

    // Espera de seguridad post-switch para evitar redirects tardíos
    await sleep(2_000);

    logger.info(`[AWS] Rol ${roleName} activado ✅`);
    return true;
  } catch (e: unknown) {
    logger.error(`[AWS] Error cambiando a rol ${roleName}: ${e}`);
    return false;
  }
}

/** Guarda el estado de la sesión para reutilizarla */
export async function saveSession(context: BrowserContext): Promise<void> {
  await context.storageState({ path: config.sessionFile });
}

// ── Private helpers ──────────────────────────────────────────

async function waitForManualMfa(page: Page, onMfaRequired: MfaCallback | null): Promise<void> {
  try {
    await dismissPopups(page);

    // Selectores para campo MFA — incluye variantes de pantalla OAuth
    const mfaSelectors = [
      "#mfaCode",
      "input[name='mfaCode']",
      "input[placeholder*='MFA']",
      "input[placeholder*='code']",
      "input[placeholder*='Code']",
      "input[autocomplete='one-time-code']",
      // Pantalla OAuth de AWS ("Additional verification required")
      "input[type='text'][name*='mfa']",
      "input[type='text'][id*='mfa']",
      "input[type='tel']",
    ];

    const mfaField = page.locator(mfaSelectors.join(", ")).first();

    // Timeout de 15s para cubrir redirects lentos (OAuth, SSO)
    if (!(await mfaField.isVisible({ timeout: 15_000 }))) {
      logger.info("[AWS] No se detectó pantalla MFA en 15s, continuando...");
      return;
    }

    logger.info("[AWS] 🔐 Pantalla MFA detectada");
    logger.info(`[AWS] URL actual: ${page.url()}`);
    logger.info(`[AWS] onMfaRequired callback: ${onMfaRequired ? "configurado ✅" : "❌ NULL"}`);

    // Intentar obtener MFA por Telegram
    if (onMfaRequired) {
      logger.info("[AWS] 📲 Enviando solicitud MFA por Telegram al owner...");
      const code = await onMfaRequired();
      logger.info(`[AWS] Respuesta de onMfaRequired: ${code ? `código recibido (${code.length} chars)` : "null/vacío"}`);

      if (code && /^\d{6}$/.test(code)) {
        logger.info("[AWS] MFA recibido por Telegram, ingresando...");

        await mfaField.click();
        await sleep(300);
        await mfaField.press("Control+a");
        await mfaField.press("Backspace");
        await mfaField.type(code, { delay: 80 });
        await sleep(1_000);

        logger.info("[AWS] MFA escrito en el campo, buscando botón submit...");
        await dismissFeedbackModal(page);

        const submitSelectors = [
          "#submitMfa_button",
          "button#submitMfa_button",
          "button:has-text('Sign in')",
          "button:has-text('Verify')",
          "#signin_button",
        ];

        let submitted = false;
        for (const sel of submitSelectors) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1_500 })) {
              logger.info(`[AWS] Click en submit MFA: ${sel}`);
              await btn.click();
              submitted = true;
              break;
            }
          } catch {
            /* next */
          }
        }

        if (!submitted) {
          const clicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button[type='submit'], input[type='submit']"));
            for (const btn of buttons) {
              if (btn.closest("[role='dialog'], [aria-modal='true'], [class*='modal']")) continue;
              if (btn.offsetParent !== null && !btn.disabled) {
                btn.click();
                return true;
              }
            }
            return false;
          });
          if (clicked) {
            logger.info("[AWS] Click en submit MFA via evaluate (excluyendo modales)");
            submitted = true;
          }
        }

        if (!submitted) {
          logger.info("[AWS] No se encontró botón submit, presionando Enter...");
          await mfaField.click();
          await page.keyboard.press("Enter");
        }

        logger.info("[AWS] Esperando que la página avance después del MFA...");
        for (let i = 0; i < 20; i++) {
          await sleep(1_000);
          const currentUrl = page.url();
          logger.info(`[AWS] URL post-MFA: ${currentUrl}`);
          if (
            currentUrl.includes("console.aws.amazon.com") ||
            (!currentUrl.includes("mfa") && !currentUrl.includes("signin"))
          ) {
            logger.info("[AWS] ✅ MFA aceptado, página avanzó");
            break;
          }
          if (!(await mfaField.isVisible({ timeout: 500 }))) {
            logger.info("[AWS] ✅ Campo MFA desapareció, avanzando");
            break;
          }
        }

        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
        await sleep(2_000);
        await dismissFeedbackModal(page);
        logger.info("[AWS] ✅ MFA completado por Telegram");
        return;
      }
      logger.warn("[AWS] ⚠️ MFA no recibido o inválido por Telegram, cayendo a espera manual...");
    } else {
      logger.warn("[AWS] ⚠️ onMfaRequired es null — no hay callback para solicitar MFA por Telegram");
    }

    // Fallback: esperar ingreso manual
    logger.info("[AWS] ⏳ Esperando MFA manual (60 segundos)...");
    for (let remaining = 60; remaining > 0; remaining--) {
      await sleep(1_000);
      const currentUrl = page.url();
      if (
        currentUrl.includes("console.aws.amazon.com") ||
        !currentUrl.toLowerCase().includes("mfa")
      ) {
        if (!(await mfaField.isVisible({ timeout: 500 }))) {
          logger.info("[AWS] ✅ MFA ingresado manualmente");
          break;
        }
      }
    }

    await page.waitForLoadState("domcontentloaded");
    await sleep(1_000);
    await dismissFeedbackModal(page);
  } catch (e: unknown) {
    logger.warn(`[AWS] MFA no requerido o ya pasó: ${e}`);
  }
}

async function skipExpiringPassword(page: Page): Promise<void> {
  try {
    const skipSelectors = [
      "a:has-text('Skip and continue to sign in')",
      "a:has-text('Skip')",
      "button:has-text('Skip')",
    ];

    for (const sel of skipSelectors) {
      try {
        const link = page.locator(sel).first();
        if (await link.isVisible({ timeout: 3_000 })) {
          await link.click();
          logger.info("[AWS] 🔑 Pantalla 'Handle expiring password' saltada");
          await page.waitForLoadState("domcontentloaded", { timeout: 10_000 });
          await sleep(2_000);
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

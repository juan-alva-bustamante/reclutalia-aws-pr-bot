import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { PrDebugger } from "../history/pr-debug.js";
import type { PrFlowResult } from "../types.js";
import { AUTO_DISMISS_SCRIPT } from "./popups.js";
import { isLoggedIn, login, switchRole, saveSession, type MfaCallback } from "./auth.js";
import { approvePr, mergePr } from "./pr-actions.js";
import { prEmitter } from "../ws/pr-emitter.js";

export class AWSBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  /** Callback para solicitar MFA por Telegram. Se inyecta desde el bot. */
  onMfaRequired: MfaCallback | null = null;

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
    if (this.context) {
      try {
        await this.context.storageState({ path: config.sessionFile });
        logger.info("[AWS] 💾 Sesión guardada antes de cerrar browser");
      } catch (e: unknown) {
        logger.warn(`[AWS] No se pudo guardar sesión al cerrar: ${e}`);
      }
    }
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  private get pg(): Page {
    if (!this.page) throw new Error("Browser not started. Call start() first.");
    return this.page;
  }

  // ── Full PR Flow ───────────────────────────────────────────

  async fullPrFlow(
    prUrl: string,
    author?: { name: string; email: string },
    prNumber?: string,
  ): Promise<PrFlowResult> {
    const result: PrFlowResult = { success: false, steps: [] };
    const prNum = prNumber ?? prUrl.match(/pull-requests\/(\d+)/)?.[1] ?? "unknown";
    const repo = prUrl.match(/repositories\/([\w-]+)/)?.[1] ?? "unknown";
    const debug = new PrDebugger(prNum);
    debug.log(`Inicio de flujo para PR #${prNum}`);
    debug.log(`URL: ${prUrl}`);
    debug.log(`Author: ${author ? `${author.name} <${author.email}>` : "default"}`);

    // Notificar inicio al widget
    prEmitter.startPr(prNum, repo);

    try {
      // 0. Ensure browser is running
      await this.ensureStarted();

      // 1. Login
      prEmitter.step(prNum, repo, "login", "in_progress");
      if (!(await isLoggedIn(this.pg))) {
        debug.log("Sesión no activa, iniciando login...");
        if (!(await login(this.pg, this.onMfaRequired))) {
          debug.log("❌ Login falló");
          await debug.screenshot(this.pg, "login_failed");
          result.error = "No se pudo hacer login en AWS";
          prEmitter.step(prNum, repo, "login", "error", result.error);
          prEmitter.errorPr(prNum, repo, result.error);
          return result;
        }
        if (this.context) await saveSession(this.context);
      }
      debug.log("✅ Login OK");
      result.steps.push("✅ Login en AWS");
      prEmitter.step(prNum, repo, "login", "done");

      // 2. Authorizer → Approve
      prEmitter.step(prNum, repo, "switch_authorizer", "in_progress");
      if (!(await switchRole(this.pg, config.roles.authorizer.url, config.roles.authorizer.name))) {
        debug.log("❌ Falló switch a devops/Authorizer");
        await debug.screenshot(this.pg, "switch_authorizer_failed");
        result.error = "Falló switch a devops/Authorizer";
        prEmitter.step(prNum, repo, "switch_authorizer", "error", result.error);
        prEmitter.errorPr(prNum, repo, result.error);
        return result;
      }
      prEmitter.step(prNum, repo, "switch_authorizer", "done");

      prEmitter.step(prNum, repo, "approve_authorizer", "in_progress");
      if (!(await approvePr(this.pg, prUrl))) {
        debug.log("❌ Falló aprobación con devops/Authorizer");
        await debug.screenshot(this.pg, "approve_authorizer_failed");
        result.error = "Falló aprobación con devops/Authorizer";
        prEmitter.step(prNum, repo, "approve_authorizer", "error", result.error);
        prEmitter.errorPr(prNum, repo, result.error);
        return result;
      }
      debug.log("✅ Aprobado con devops/Authorizer");
      result.steps.push("✅ Aprobado con devops/Authorizer");
      prEmitter.step(prNum, repo, "approve_authorizer", "done");

      // 3. Manager → Approve
      prEmitter.step(prNum, repo, "switch_manager", "in_progress");
      if (!(await switchRole(this.pg, config.roles.manager.url, config.roles.manager.name))) {
        debug.log("❌ Falló switch a devops/Manager");
        await debug.screenshot(this.pg, "switch_manager_failed");
        result.error = "Falló switch a devops/Manager";
        prEmitter.step(prNum, repo, "switch_manager", "error", result.error);
        prEmitter.errorPr(prNum, repo, result.error);
        return result;
      }
      prEmitter.step(prNum, repo, "switch_manager", "done");

      prEmitter.step(prNum, repo, "approve_manager", "in_progress");
      if (!(await approvePr(this.pg, prUrl))) {
        debug.log("❌ Falló aprobación con devops/Manager");
        await debug.screenshot(this.pg, "approve_manager_failed");
        result.error = "Falló aprobación con devops/Manager";
        prEmitter.step(prNum, repo, "approve_manager", "error", result.error);
        prEmitter.errorPr(prNum, repo, result.error);
        return result;
      }
      debug.log("✅ Aprobado con devops/Manager");
      result.steps.push("✅ Aprobado con devops/Manager");
      prEmitter.step(prNum, repo, "approve_manager", "done");

      // 4. MergeMaster → Merge
      prEmitter.step(prNum, repo, "switch_merge", "in_progress");
      if (!(await switchRole(this.pg, config.roles.merge.url, config.roles.merge.name))) {
        debug.log("❌ Falló switch a MergeMaster");
        await debug.screenshot(this.pg, "switch_mergemaster_failed");
        result.error = "Falló switch a MergeMaster";
        prEmitter.step(prNum, repo, "switch_merge", "error", result.error);
        prEmitter.errorPr(prNum, repo, result.error);
        return result;
      }
      prEmitter.step(prNum, repo, "switch_merge", "done");

      debug.log("Iniciando merge...");
      await debug.screenshot(this.pg, "before_merge");
      prEmitter.step(prNum, repo, "merge", "in_progress");
      if (!(await mergePr(this.pg, prUrl, author, debug))) {
        debug.log("❌ Falló el merge con MergeMaster");
        await debug.screenshot(this.pg, "merge_failed");
        await debug.saveHtml(this.pg, "merge_failed");
        result.error = "Falló el merge con MergeMaster";
        prEmitter.step(prNum, repo, "merge", "error", result.error);
        prEmitter.errorPr(prNum, repo, result.error);
        return result;
      }
      debug.log("✅ Merge completado");
      result.steps.push("✅ Merge completado con MergeMaster");
      prEmitter.step(prNum, repo, "merge", "done");

      // 5. Save session
      prEmitter.step(prNum, repo, "save_session", "in_progress");
      if (this.context) await saveSession(this.context);
      prEmitter.step(prNum, repo, "save_session", "done");

      result.success = true;
      debug.log("✅ Flujo completado exitosamente");
      prEmitter.completePr(prNum, repo);
    } catch (e: unknown) {
      result.error = String(e);
      debug.log(`❌ Error inesperado: ${e}`);
      prEmitter.errorPr(prNum, repo, result.error);
      try { await debug.screenshot(this.pg, "unexpected_error"); } catch { /* */ }
    }

    return result;
  }
}

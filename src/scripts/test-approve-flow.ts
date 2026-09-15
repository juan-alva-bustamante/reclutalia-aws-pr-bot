/**
 * Script manual para medir tiempos del flujo real hasta la aprobación con Manager.
 * NO cambia al rol MergeMaster ni navega a la pantalla de merge — se detiene
 * justo después de aprobar con Manager, a propósito.
 *
 * Uso:
 *   npx tsx src/scripts/test-approve-flow.ts <URL_DEL_PR>
 *
 * El MFA (si AWS lo pide) llega por DM de Telegram al TELEGRAM_OWNER_USER_ID configurado.
 * Se guardan screenshots en data/pull-requests/<prNumber>-speedtest/ para poder revisar
 * componentes, loaders y botones de cada paso.
 */
import "dotenv/config";
import { Telegraf } from "telegraf";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { AWSBrowser } from "../aws/browser.js";
import { isLoggedIn, login, switchRole, saveSession } from "../aws/auth.js";
import { approvePr } from "../aws/pr-actions.js";
import { setupMfaHandler } from "../bot/mfa-handler.js";
import { PrDebugger } from "../history/pr-debug.js";
import { parsePrInfo } from "../utils/url-parser.js";

async function main(): Promise<void> {
  const prUrl = process.argv[2];
  if (!prUrl) {
    console.error("❌ Falta la URL del PR como argumento.");
    console.error("   Uso: npx tsx src/scripts/test-approve-flow.ts <URL_DEL_PR>");
    process.exit(1);
  }

  const prInfo = parsePrInfo(prUrl);
  if (!prInfo) {
    console.error("❌ URL no válida. Debe ser una URL de PR de CodeCommit.");
    process.exit(1);
  }

  console.log(`\n🔎 Test de velocidad — PR #${prInfo.prNumber} (${prInfo.repo})`);
  console.log(`   Flujo: login → switch Authorizer → approve → switch Manager → approve`);
  console.log(`   🛑 Se detiene ahí a propósito — NO toca MergeMaster ni la pantalla de merge.\n`);

  const bot = new Telegraf(config.telegram.token);
  const awsBrowser = new AWSBrowser();
  setupMfaHandler(bot, awsBrowser);

  console.log("⏳ Verificando bot de Telegram (getMe)...");
  const me = await bot.telegram.getMe();
  console.log(`✅ Bot identificado: @${me.username}`);

  // OJO: bot.launch() en modo polling NUNCA resuelve mientras el bot corre normal
  // (el loop interno de Telegraf solo termina cuando se llama bot.stop()).
  // Por eso NO se hace await aquí — se lanza fire-and-forget, igual que el
  // patrón estándar de Telegraf (ver hallazgo sobre src/main.ts en el resumen final).
  bot.launch({ dropPendingUpdates: true }).catch((e: unknown) => {
    logger.error(`[Bot] launch() terminó con error: ${e instanceof Error ? e.message : String(e)}`);
  });
  console.log(`🤖 Bot de Telegram lanzado — si AWS pide MFA, llega un DM a tu Telegram (${config.telegram.ownerUserId}).\n`);

  const debug = new PrDebugger(`${prInfo.prNumber}-speedtest`);
  const marks: { label: string; t: number }[] = [];
  const mark = (label: string): void => {
    marks.push({ label, t: Date.now() });
  };

  mark("start");

  try {
    await awsBrowser.ensureStarted();
    const page = awsBrowser.getPage();
    if (!page) throw new Error("No se pudo obtener la página del browser");
    mark("browser_started");

    if (!(await isLoggedIn(page))) {
      console.log("🔑 Sesión expirada — haciendo login (puede pedir MFA por Telegram)...");
      await debug.screenshot(page, "pre_login");
      const ok = await login(page, awsBrowser.onMfaRequired);
      mark("login_done");
      if (!ok) throw new Error("Login falló");
      await saveSession(awsBrowser.getContext()!);
      await debug.screenshot(page, "post_login");
      console.log("✅ Login OK\n");
    } else {
      console.log("✅ Sesión activa reutilizada — sin MFA esta vez\n");
      mark("login_done");
    }

    console.log("🎭 Switch a rol Authorizer...");
    await debug.screenshot(page, "pre_switch_authorizer");
    const switchedAuthorizer = await switchRole(page, config.roles.authorizer.url, config.roles.authorizer.name);
    mark("switch_authorizer_done");
    await debug.screenshot(page, "post_switch_authorizer");
    if (!switchedAuthorizer) throw new Error("Switch a Authorizer falló");

    console.log("✅ Approve como Authorizer...");
    const approvedAuthorizer = await approvePr(page, prUrl);
    mark("approve_authorizer_done");
    await debug.screenshot(page, "post_approve_authorizer");
    if (!approvedAuthorizer) throw new Error("Approve (Authorizer) falló");
    console.log("✅ Aprobado con Authorizer\n");

    console.log("🎭 Switch a rol Manager...");
    await debug.screenshot(page, "pre_switch_manager");
    const switchedManager = await switchRole(page, config.roles.manager.url, config.roles.manager.name);
    mark("switch_manager_done");
    await debug.screenshot(page, "post_switch_manager");
    if (!switchedManager) throw new Error("Switch a Manager falló");

    console.log("✅ Approve como Manager...");
    const approvedManager = await approvePr(page, prUrl);
    mark("approve_manager_done");
    await debug.screenshot(page, "post_approve_manager");
    if (!approvedManager) throw new Error("Approve (Manager) falló");
    console.log("✅ Aprobado con Manager\n");

    await saveSession(awsBrowser.getContext()!);
    console.log("🛑 DETENIDO a propósito — no se cambió a MergeMaster ni se tocó merge.\n");
  } catch (e: unknown) {
    logger.error(`❌ Error en test de flujo: ${e instanceof Error ? e.message : String(e)}`);
    try {
      const page = awsBrowser.getPage();
      if (page) await debug.screenshot(page, "error");
    } catch { /* */ }
  } finally {
    // Tabla de tiempos
    console.log(`${"═".repeat(60)}`);
    console.log("  TIEMPOS POR PASO");
    console.log(`${"═".repeat(60)}`);
    for (let i = 1; i < marks.length; i++) {
      const deltaMs = marks[i].t - marks[i - 1].t;
      console.log(`  ${marks[i - 1].label.padEnd(24)} → ${marks[i].label.padEnd(24)} ${(deltaMs / 1000).toFixed(1)}s`);
    }
    if (marks.length > 1) {
      const totalMs = marks[marks.length - 1].t - marks[0].t;
      console.log(`${"─".repeat(60)}`);
      console.log(`  TOTAL: ${(totalMs / 1000).toFixed(1)}s`);
    }
    console.log(`${"═".repeat(60)}`);
    console.log(`\n📁 Screenshots guardados en: ${debug.path}`);

    await awsBrowser.close();
    console.log("🌐 Browser cerrado (sesión guardada).");
    bot.stop("done");
  }
}

main();

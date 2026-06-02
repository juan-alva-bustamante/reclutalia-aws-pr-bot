/**
 * Script manual para probar el análisis de IA sobre un PR.
 *
 * Uso:
 *   npx tsx src/scripts/test-ai-analysis.ts <URL_DEL_PR>
 *
 * Ejemplo:
 *   npx tsx src/scripts/test-ai-analysis.ts "https://us-east-1.console.aws.amazon.com/codesuite/codecommit/repositories/reclutalia/pull-requests/29537/details?region=us-east-1"
 *
 * Requiere:
 *   - AI_ENABLED=true en .env
 *   - Ollama corriendo localmente
 *   - Credenciales AWS válidas en .env (para login en browser)
 */
import "dotenv/config";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { isLoggedIn, login, saveSession } from "../aws/auth.js";
import { AUTO_DISMISS_SCRIPT } from "../aws/popups.js";
import { analyzePR } from "../ai/pr-analyzer.js";
import { parsePrInfo } from "../utils/url-parser.js";

async function main(): Promise<void> {
  const prUrl = process.argv[2];

  if (!prUrl) {
    console.error("❌ Falta la URL del PR como argumento.");
    console.error("   Uso: npx tsx src/scripts/test-ai-analysis.ts <URL_DEL_PR>");
    process.exit(1);
  }

  const prInfo = parsePrInfo(prUrl);
  if (!prInfo) {
    console.error("❌ URL no válida. Debe ser una URL de PR de CodeCommit.");
    process.exit(1);
  }

  console.log(`\n🔍 Analizando PR #${prInfo.prNumber} en repo "${prInfo.repo}"...\n`);

  if (!config.ai.enabled) {
    console.error("⚠️  AI_ENABLED=false en .env. Forzando habilitado para este test.");
    // Forzar para el script de prueba
    (config.ai as { enabled: boolean }).enabled = true;
  }

  // Iniciar browser
  console.log("🌐 Iniciando browser...");
  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: 50,
  });

  const context = existsSync(config.sessionFile)
    ? await browser.newContext({ storageState: config.sessionFile })
    : await browser.newContext();

  const page = await context.newPage();
  await page.addInitScript(AUTO_DISMISS_SCRIPT);

  try {
    // Login si es necesario
    if (!(await isLoggedIn(page))) {
      console.log("🔑 Sesión no activa, haciendo login...");
      const loginOk = await login(page, null);
      if (!loginOk) {
        console.error("❌ No se pudo hacer login en AWS.");
        process.exit(1);
      }
      await saveSession(context);
      console.log("✅ Login exitoso");
    } else {
      console.log("✅ Sesión activa reutilizada");
    }

    // Ejecutar análisis
    console.log("\n🤖 Ejecutando análisis de IA...\n");
    const startTime = Date.now();
    const analysis = await analyzePR(page, prUrl);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (!analysis) {
      console.log(`\n⚠️  El análisis retornó null (${elapsed}s). Revisa los logs arriba.`);
    } else {
      console.log(`\n${"═".repeat(60)}`);
      console.log(`  RESULTADO DEL ANÁLISIS (${elapsed}s)`);
      console.log(`${"═".repeat(60)}\n`);

      console.log(`📋 Resumen:`);
      console.log(`   ${analysis.summary}\n`);

      if (analysis.changes.length > 0) {
        console.log(`📁 Cambios:`);
        for (const change of analysis.changes) {
          console.log(`   • ${change}`);
        }
        console.log();
      }

      if (analysis.risks.length > 0) {
        console.log(`⚠️  Riesgos:`);
        for (const risk of analysis.risks) {
          console.log(`   • ${risk}`);
        }
        console.log();
      } else {
        console.log(`✅ No se detectaron riesgos.\n`);
      }

      console.log(`${"═".repeat(60)}`);
      console.log(`\n📊 JSON completo:`);
      console.log(JSON.stringify(analysis, null, 2));
    }

    // Guardar sesión para reutilizar
    await context.storageState({ path: config.sessionFile });
  } catch (e: unknown) {
    logger.error(`❌ Error: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
  } finally {
    await browser.close();
    console.log("\n🌐 Browser cerrado.");
  }
}

main();

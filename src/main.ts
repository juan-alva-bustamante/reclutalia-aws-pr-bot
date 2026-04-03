import { config } from "./config.js";
import { logger } from "./logger.js";
import { AWSBrowser } from "./aws/browser.js";
import { createBot } from "./bot/telegram-bot.js";

async function main(): Promise<void> {
  logger.info("🚀 Iniciando bot de PR Autorización...");

  const awsBrowser = new AWSBrowser();
  await awsBrowser.start();
  logger.info("🌐 Browser iniciado");

  const bot = createBot(awsBrowser);

  logger.info("🤖 Bot de Telegram iniciado, escuchando mensajes...");
  logger.info("📡 Monitoreando URLs de CodeCommit en canales/grupos");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`⛔ ${signal} recibido, deteniendo bot...`);
    bot.stop(signal);
    await awsBrowser.close();
    logger.info("✅ Bot detenido correctamente");
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.launch({ dropPendingUpdates: true });
  logger.info("✅ Bot corriendo. Presiona Ctrl+C para detener.");
}

main().catch((err) => {
  logger.error(`Fatal: ${err}`);
  process.exit(1);
});

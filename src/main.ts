import { logger } from "./logger.js";
import { AWSBrowser } from "./aws/browser.js";
import { createBot } from "./bot/telegram-bot.js";
import { startWsServer, stopWsServer } from "./ws/ws-server.js";

async function main(): Promise<void> {
  logger.info("🚀 Iniciando bot de PR Autorización...");

  // Protección contra errores no capturados — el bot NO debe crashear por errores de Telegram
  process.on("unhandledRejection", (reason) => {
    logger.error(`[Process] Unhandled Rejection: ${reason}`);
  });
  process.on("uncaughtException", (err) => {
    logger.error(`[Process] Uncaught Exception: ${err.message}`);
    // Solo crashear si es un error crítico (no errores de red/Telegram)
    if (err.message.includes("ENOMEM") || err.message.includes("Cannot find module")) {
      process.exit(1);
    }
  });

  // Iniciar WebSocket server para el widget
  startWsServer();

  const awsBrowser = new AWSBrowser();
  const bot = createBot(awsBrowser);

  logger.info("🤖 Bot de Telegram iniciado, escuchando mensajes...");
  logger.info("📡 Monitoreando URLs de CodeCommit en canales/grupos");
  logger.info("🌐 Browser se iniciará cuando llegue un PR");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`⛔ ${signal} recibido, deteniendo bot...`);
    bot.stop(signal);
    await awsBrowser.close();
    stopWsServer();
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

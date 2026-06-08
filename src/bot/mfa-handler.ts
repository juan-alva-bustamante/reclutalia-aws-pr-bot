import type { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AWSBrowser } from "../aws/browser.js";

/**
 * Configura el manejo de MFA por Telegram:
 * - Inyecta el callback `onMfaRequired` en el browser
 * - Registra el listener de DMs del owner para capturar el código
 */
export function setupMfaHandler(bot: Telegraf, awsBrowser: AWSBrowser): void {
  let mfaResolve: ((code: string | null) => void) | null = null;

  awsBrowser.onMfaRequired = async (): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      mfaResolve = resolve;

      logger.info(`[Bot] 📲 Enviando DM de MFA al owner (userId: ${config.telegram.ownerUserId})...`);

      bot.telegram.sendMessage(
        config.telegram.ownerUserId,
        `🔐 *Se requiere código MFA*\nAsegurate que el token tenga minimo 20 seg de expiración.\n\nEnvía tu código de 6 dígitos aquí:`,
        { parse_mode: "Markdown" },
      ).then(() => {
        logger.info("[Bot] ✅ DM de MFA enviado al owner, esperando respuesta...");
      }).catch((e: unknown) => {
        logger.error(`[Bot] ❌ Error enviando DM de MFA al owner (userId: ${config.telegram.ownerUserId}): ${e}`);
        mfaResolve = null;
        resolve(null);
      });

      setTimeout(() => {
        if (mfaResolve === resolve) {
          logger.warn("[Bot] Timeout esperando MFA por Telegram");
          mfaResolve = null;
          resolve(null);
        }
      }, 90_000);
    });
  };

  // Listener de DMs del owner para capturar MFA (debe registrarse ANTES de otros handlers de texto)
  bot.on(message("text"), async (ctx, next) => {
    if (
      ctx.chat.type === "private" &&
      ctx.from?.id === config.telegram.ownerUserId &&
      mfaResolve
    ) {
      const code = ctx.message.text.trim();
      if (/^\d{6}$/.test(code)) {
        logger.info("[Bot] MFA recibido por Telegram");
        await ctx.reply("✅ Código MFA recibido, ingresando...");
        const resolve = mfaResolve;
        mfaResolve = null;
        resolve(code);
        return;
      }
      await ctx.reply("⚠️ El código MFA debe ser exactamente 6 dígitos numéricos.");
      return;
    }
    return next();
  });
}

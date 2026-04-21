import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { extractAllPrUrls, parsePrInfo } from "../utils/url-parser.js";
import { PrQueue } from "../queue/pr-queue.js";
import { logPrResult, getRecentLogs } from "../queue/pr-log.js";
import type { AWSBrowser } from "../aws/browser.js";
import type { PrInfo, QueueItem } from "../types.js";

// Respuestas válidas de aprobación/rechazo
const APPROVE_WORDS = ["si", "sí", "autorizar"];
const REJECT_WORDS = ["no", "denegar"];

/** Helper to send a message to the configured topic */
async function sendToTopic(
  telegram: Telegraf["telegram"],
  chatId: number | string,
  text: string,
  parseMode: "Markdown" | "MarkdownV2" = "Markdown",
): Promise<void> {
  await telegram.sendMessage(chatId, text, {
    parse_mode: parseMode,
    message_thread_id: config.telegram.topicId,
  });
}

/** Verifica si un username está en la lista de autorizados */
function isAuthorized(username: string | undefined): boolean {
  if (!username) return false;
  return config.telegram.authorizedUsers.some(
    (u) => u === username.toLowerCase(),
  );
}

/** Envía el mensaje de solicitud de aprobación con botones inline */
async function sendApprovalRequest(
  telegram: Telegraf["telegram"],
  chatId: number | string,
  prInfo: PrInfo,
): Promise<void> {
  await telegram.sendMessage(
    chatId,
    `🔔 *Solicitud de aprobación*\n\n` +
      `📦 Repo: \`${prInfo.repo}\`\n` +
      `🔢 PR #: \`${prInfo.prNumber}\`\n\n` +
      `Antes de Aprobar se recomenda abrir el PR y validar los siguientes puntos: \n\n` +
      `▸ Ramas del PR (init-dev, dev-qa, qa-master) \n` +
      `▸ Quien manda el PR \n` +
      `▸ Cambios incluidos en este PR \n\n` +
      `Despues de validar estos puntos, \n` +
      `⁉ ¿Estás seguro que quieres Aprobar este PR? \n\n`,
    {
      parse_mode: "Markdown",
      message_thread_id: config.telegram.topicId,
      ...Markup.inlineKeyboard([
        Markup.button.callback("✅ Aprobar", `approve:${prInfo.prNumber}`),
        Markup.button.callback("❌ Rechazar", `reject:${prInfo.prNumber}`),
      ]),
    },
  );
}

export function createBot(awsBrowser: AWSBrowser): Telegraf {
  const bot = new Telegraf(config.telegram.token);
  const queue = new PrQueue();

  // ── Procesador de la cola (se ejecuta cuando un PR es aprobado) ──
  queue.setProcessor(async (item: QueueItem) => {
    const prInfo: PrInfo = {
      repo: item.repo,
      prNumber: item.prNumber,
      url: item.url,
    };
    const startedAt = new Date().toISOString();

    await sendToTopic(
      bot.telegram,
      item.chatId,
      `▶️ *Procesando PR #${prInfo.prNumber}*\n` +
        `📦 Repo: \`${prInfo.repo}\`\n\n` +
        `⏳ Iniciando proceso de autorización...`,
    );

    const result = await awsBrowser.fullPrFlow(item.url);
    const finishedAt = new Date().toISOString();

    logPrResult({
      prNumber: prInfo.prNumber,
      repo: prInfo.repo,
      url: item.url,
      status: result.success ? "success" : "error",
      steps: result.steps,
      error: result.error,
      startedAt,
      finishedAt,
    });

    logger.info("[Bot] Cerrando browser después de procesar PR");
    await awsBrowser.close();

    if (result.success) {
      const stepsText = result.steps.join("\n");
      await sendToTopic(
        bot.telegram,
        item.chatId,
        `✅ *PR procesado exitosamente*\n\n` +
          `📦 Repo: \`${prInfo.repo}\`\n` +
          `🔢 PR #: \`${prInfo.prNumber}\`\n\n` +
          `*Pasos completados:*\n${stepsText}`,
      );
      await bot.telegram.sendMessage(
        config.telegram.ownerUserId,
        `✅ PR #${prInfo.prNumber} del repo \`${prInfo.repo}\` fue mergeado exitosamente.`,
        { parse_mode: "Markdown" },
      );
    } else {
      const stepsText = result.steps.length
        ? result.steps.join("\n")
        : "Ninguno";
      await sendToTopic(
        bot.telegram,
        item.chatId,
        `❌ *Error procesando PR*\n\n` +
          `📦 Repo: \`${prInfo.repo}\`\n` +
          `🔢 PR #: \`${prInfo.prNumber}\`\n\n` +
          `*Pasos completados:*\n${stepsText}\n\n` +
          `*Error:* \`${result.error}\`\n\n` +
          `⚠️ Revisa el PR manualmente: ${item.url}`,
      );
      throw new Error(result.error);
    }

    const remaining = queue.pendingCount;
    if (remaining > 0) {
      await sendToTopic(
        bot.telegram,
        item.chatId,
        `📋 *${remaining} PR(s) restantes en cola*\n⏳ Procesando el siguiente...`,
      );
    }

    // Si hay PRs esperando aprobación, recordar
    const awaiting = queue.awaitingApproval;
    if (awaiting.length > 0) {
      const list = awaiting
        .map((p) => `  • PR #${p.prNumber} (${p.repo})`)
        .join("\n");
      await sendToTopic(
        bot.telegram,
        item.chatId,
        `🔔 *${awaiting.length} PR(s) esperando aprobación:*\n${list}\n\n` +
          `Responde *si #NUMERO* o *no #NUMERO*`,
      );
    }
  });

  // ── Callback de botones inline (Aprobar / Rechazar) ──
  bot.action(/^approve:(\d+)$/, async (ctx) => {
    const prNumber = ctx.match[1];
    const username = ctx.from?.username;

    if (!isAuthorized(username)) {
      await ctx.answerCbQuery("⛔ No estás autorizado para aprobar PRs.");
      return;
    }

    const item = queue.approve(prNumber, username ?? "unknown");
    if (item) {
      await ctx.answerCbQuery(`✅ PR #${prNumber} aprobado`);
      // Editar el mensaje original para mostrar quién aprobó
      await ctx.editMessageText(
        ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
          ? ctx.callbackQuery.message.text +
              `\n\n✅ *Aprobado* por @${username}`
          : `✅ PR #${prNumber} aprobado por @${username}`,
        { parse_mode: "Markdown" },
      );
      await sendToTopic(
        bot.telegram,
        ctx.callbackQuery.message?.chat.id ?? config.telegram.chatId,
        `✅ PR #${prNumber} *aprobado* por @${username}\n⏳ Iniciando proceso...`,
      );
    } else {
      await ctx.answerCbQuery(
        `⚠️ PR #${prNumber} ya no está esperando aprobación.`,
      );
    }
  });

  bot.action(/^reject:(\d+)$/, async (ctx) => {
    const prNumber = ctx.match[1];
    const username = ctx.from?.username;

    if (!isAuthorized(username)) {
      await ctx.answerCbQuery("⛔ No estás autorizado para rechazar PRs.");
      return;
    }

    const item = queue.reject(prNumber, username ?? "unknown");
    if (item) {
      await ctx.answerCbQuery(`🚫 PR #${prNumber} rechazado`);
      await ctx.editMessageText(
        ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
          ? ctx.callbackQuery.message.text +
              `\n\n🚫 *Rechazado* por @${username}`
          : `🚫 PR #${prNumber} rechazado por @${username}`,
        { parse_mode: "Markdown" },
      );
    } else {
      await ctx.answerCbQuery(
        `⚠️ PR #${prNumber} ya no está esperando aprobación.`,
      );
    }
  });

  // ── Comandos ──

  bot.command("status", async (ctx) => {
    const queueSummary = queue.getSummary();
    await ctx.reply(
      `🤖 *Bot de PR Autorización*\n\n` +
        `✅ Activo y escuchando\n📡 Monitoreando URLs de CodeCommit\n\n` +
        `*Cola de PRs:*\n${queueSummary}\n\n` +
        `Comandos:\n/status - Estado y cola\n/queue - Cola de PRs\n/log - Bitácora\n/pr <url> - PR manual`,
      { parse_mode: "Markdown", message_thread_id: config.telegram.topicId },
    );
  });

  bot.command("queue", async (ctx) => {
    await ctx.reply(`📋 *Cola de PRs*\n\n${queue.getSummary()}`, {
      parse_mode: "Markdown",
      message_thread_id: config.telegram.topicId,
    });
  });

  bot.command("log", async (ctx) => {
    const logs = getRecentLogs(5);
    await ctx.reply(`📒 *Bitácora (últimos 5)*\n\n\`\`\`\n${logs}\n\`\`\``, {
      parse_mode: "Markdown",
      message_thread_id: config.telegram.topicId,
    });
  });

  bot.command("pr", async (ctx) => {
    if (!isAuthorized(ctx.from?.username)) {
      await ctx.reply("⛔ No tienes permisos para usar este comando.");
      return;
    }
    const url = ctx.message.text.split(" ")[1];
    if (!url) {
      await ctx.reply("Uso: /pr <url_del_pr>");
      return;
    }
    const prInfo = parsePrInfo(url);
    if (!prInfo) {
      await ctx.reply("❌ URL de PR no válida.");
      return;
    }

    const added = queue.enqueue({
      url: prInfo.url,
      repo: prInfo.repo,
      prNumber: prInfo.prNumber,
      chatId: ctx.chat.id,
    });
    logger.info(`Enviando mensaje de aprobacion `, ctx);
    if (added) {
      await sendApprovalRequest(bot.telegram, ctx.chat.id, prInfo);
    } else {
      await ctx.reply(`ℹ️ PR #${prInfo.prNumber} ya está en cola.`);
    }
  });

  // ── Listener principal de mensajes ──
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text.trim();
    const chatType = ctx.chat.type;

    if (chatType === "private") return;
    if (
      config.telegram.topicId &&
      ctx.message.message_thread_id !== config.telegram.topicId
    )
      return;

    // ── 1. Verificar si es una respuesta de aprobación/rechazo ──
    const textLower = text.toLowerCase();

    // Parsear: "si #29426", "no 29426", "autorizar #29426", "si", "no", etc.
    const prNumberMatch = textLower.match(/#?(\d{4,})/);
    // Extraer la primera palabra (ignorando el número y #)
    const commandPart = textLower.replace(/#?\d+/g, "").trim();
    const firstWord = commandPart.split(/\s+/)[0];

    const isApprove = APPROVE_WORDS.includes(firstWord);
    const isReject = REJECT_WORDS.includes(firstWord);

    // Solo procesar si el mensaje es EXACTAMENTE una palabra de aprobación/rechazo
    // opcionalmente seguida de un número de PR
    const isExactCommand = commandPart === firstWord;

    if ((isApprove || isReject) && isExactCommand) {
      if (!isAuthorized(ctx.from?.username)) {
        await sendToTopic(
          bot.telegram,
          ctx.chat.id,
          `⛔ @${ctx.from?.username ?? "usuario"} no está autorizado para aprobar/rechazar PRs.`,
        );
        return;
      }

      const awaiting = queue.awaitingApproval;
      if (awaiting.length === 0) {
        await sendToTopic(
          bot.telegram,
          ctx.chat.id,
          `ℹ️ No hay PRs esperando aprobación.`,
        );
        return;
      }

      // Determinar qué PR se está aprobando/rechazando
      let targetPrNumber: string | null = null;

      if (prNumberMatch) {
        // Respuesta explícita: "si #29426"
        targetPrNumber = prNumberMatch[1];
      } else if (awaiting.length === 1) {
        // Solo 1 PR esperando, "si" o "no" aplica a ese
        targetPrNumber = awaiting[0].prNumber;
      } else {
        // Múltiples PRs esperando, necesita especificar
        const list = awaiting
          .map((p) => `  • PR #${p.prNumber} (${p.repo})`)
          .join("\n");
        await sendToTopic(
          bot.telegram,
          ctx.chat.id,
          `⚠️ Hay ${awaiting.length} PRs esperando aprobación:\n${list}\n\n` +
            `Especifica cuál: *si #NUMERO* o *no #NUMERO*`,
        );
        return;
      }

      if (isApprove) {
        const username = ctx.from?.username ?? "unknown";
        const item = queue.approve(targetPrNumber, username);
        if (item) {
          await sendToTopic(
            bot.telegram,
            ctx.chat.id,
            `✅ PR #${targetPrNumber} *aprobado* por @${ctx.from?.username ?? "usuario"}\n` +
              `⏳ Iniciando proceso...`,
          );
        } else {
          await sendToTopic(
            bot.telegram,
            ctx.chat.id,
            `⚠️ PR #${targetPrNumber} no está esperando aprobación.`,
          );
        }
      } else {
        const username = ctx.from?.username ?? "unknown";
        const item = queue.reject(targetPrNumber, username);
        if (item) {
          await sendToTopic(
            bot.telegram,
            ctx.chat.id,
            `🚫 PR #${targetPrNumber} *rechazado* por @${ctx.from?.username ?? "usuario"}`,
          );
        } else {
          await sendToTopic(
            bot.telegram,
            ctx.chat.id,
            `⚠️ PR #${targetPrNumber} no está esperando aprobación.`,
          );
        }
      }
      return;
    }

    // ── 2. Detectar URLs de PR en el mensaje ──
    const prUrls = extractAllPrUrls(text);
    if (prUrls.length === 0) return;

    const parsed: PrInfo[] = [];
    for (const url of prUrls) {
      const info = parsePrInfo(url);
      if (info) parsed.push(info);
    }
    if (parsed.length === 0) return;

    logger.info(`${parsed.length} PR(s) detectados en mensaje`);

    const added: PrInfo[] = [];
    const duplicates: PrInfo[] = [];

    for (const prInfo of parsed) {
      const wasAdded = queue.enqueue({
        url: prInfo.url,
        repo: prInfo.repo,
        prNumber: prInfo.prNumber,
        chatId: ctx.chat.id,
      });
      if (wasAdded) added.push(prInfo);
      else duplicates.push(prInfo);
    }

    // Enviar solicitud de aprobación por cada PR nuevo
    for (const prInfo of added) {
      await sendApprovalRequest(bot.telegram, ctx.chat.id, prInfo);
    }

    if (duplicates.length > 0) {
      const dupList = duplicates.map((p) => `PR #${p.prNumber}`).join(", ");
      await sendToTopic(bot.telegram, ctx.chat.id, `ℹ️ Ya en cola: ${dupList}`);
    }
  });

  return bot;
}

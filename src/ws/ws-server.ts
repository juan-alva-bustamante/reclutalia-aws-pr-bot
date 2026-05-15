import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "../logger.js";
import { prEmitter } from "./pr-emitter.js";
import type { WsEvent } from "./events.js";

const WS_PORT = Number(process.env.WS_PORT ?? 9876);

let wss: WebSocketServer | null = null;

/** Inicia el servidor WebSocket para el widget */
export function startWsServer(): void {
  wss = new WebSocketServer({ port: WS_PORT });

  wss.on("connection", (ws: WebSocket) => {
    logger.info(`[WS] Cliente conectado (total: ${wss!.clients.size})`);

    // Enviar estado actual al conectarse
    const initEvent = prEmitter.snapshot;
    ws.send(JSON.stringify(initEvent));

    ws.on("close", () => {
      logger.info(`[WS] Cliente desconectado (total: ${wss!.clients.size})`);
    });

    ws.on("error", (err) => {
      logger.warn(`[WS] Error en cliente: ${err.message}`);
    });
  });

  // Retransmitir eventos del emitter a todos los clientes conectados
  prEmitter.on("ws:event", (event: WsEvent) => {
    if (!wss) return;
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(data);
      }
    }
  });

  wss.on("error", (err) => {
    logger.error(`[WS] Error en servidor: ${err.message}`);
  });

  logger.info(`[WS] Servidor WebSocket iniciado en puerto ${WS_PORT}`);
}

/** Detiene el servidor WebSocket */
export function stopWsServer(): void {
  if (wss) {
    wss.close();
    wss = null;
    logger.info("[WS] Servidor WebSocket detenido");
  }
}

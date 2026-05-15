---
inclusion: fileMatch
fileMatchPattern: "src/bot/**"
---

# Telegram Bot Conventions

## Arquitectura del bot

El bot se divide en módulos por responsabilidad:

- **`telegram-bot.ts`** — Creación del bot, wiring de handlers, inyección de dependencias
- **`commands.ts`** — Handlers de comandos: `/status`, `/queue`, `/log`, `/pr`
- **`handlers.ts`** — Inline buttons (approve/reject), text message handler (detección de URLs y comandos por texto)
- **`mfa-handler.ts`** — Lógica de solicitud y recepción de MFA por DM al owner

## Mensajes al grupo

### Siempre usar `sendToTopic`

```typescript
// ✅ Envía al topic configurado, con fallback si Markdown falla
await sendToTopic(bot.telegram, chatId, "Mensaje con *formato*");

// ❌ No usar directamente
await bot.telegram.sendMessage(chatId, text);
```

### Formato Markdown

- Usar `parse_mode: "Markdown"` (no MarkdownV2)
- Escapar `_` en usernames: `username.replace(/_/g, "\\_")`
- Si el mensaje falla por formato, `sendToTopic` reintenta sin Markdown automáticamente
- Usar backticks para repos y números: `` `repo-name` ``, `` `#29537` ``

### Estructura de mensajes

```
🔔 *Solicitud de aprobación*        ← Emoji + título bold
📦 Repo: `nombre-repo`              ← Datos con emoji + backtick
🔢 PR #: `29537`
⁉ ¿Aprobar este PR?                 ← Call to action
```

## Autorización

- Solo usuarios en `TELEGRAM_AUTHORIZED_USERS` pueden aprobar/rechazar
- Validar con `isAuthorized(ctx.from?.username)` antes de cualquier acción
- Responder con `⛔ No estás autorizado` si no tiene permisos

## Flujo de aprobación

### Por botones inline (preferido)

1. Bot envía mensaje con `Markup.inlineKeyboard`
2. Usuario hace click en ✅ o ❌
3. Handler edita el mensaje original agregando quién aprobó/rechazó
4. No se envía mensaje nuevo — se edita el existente

### Por texto

- Palabras de aprobación: `["si", "sí", "autorizar"]`
- Palabras de rechazo: `["no", "denegar"]`
- Si hay múltiples PRs pendientes, pedir especificar: `"si #29537"`
- Si hay solo uno, se asume ese

## MFA por Telegram

1. El browser detecta pantalla MFA
2. Llama a `onMfaRequired()` que envía DM al owner
3. Owner responde con 6 dígitos en DM privado
4. El listener intercepta el DM y resuelve la Promise
5. Timeout de 90 segundos — si no responde, intenta espera manual

## Cola de PRs

- Cada PR pasa por: `awaiting_approval` → `pending` → `processing` → `done/error`
- Solo se procesa un PR a la vez (secuencial)
- Si hay PRs en cola, notificar: `"📋 PR #X aprobado, en cola (procesando PR #Y)"`
- Al terminar uno, procesar el siguiente automáticamente

## Comandos disponibles

| Comando | Descripción |
|---------|-------------|
| `/status` | Estado del bot + resumen de cola |
| `/queue` | Detalle de la cola actual |
| `/log` | Últimas 5 entradas de la bitácora |
| `/pr <url>` | Agregar PR manualmente |

## Manejo de errores en mensajes

- Error en PR → mensaje al grupo + DM al owner con detalle
- Incluir URL del PR para revisión manual
- Incluir pasos completados para saber dónde falló

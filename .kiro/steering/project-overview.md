---
inclusion: always
---

# Project Overview — Reclutalia AWS PR Bot

## Qué es

Bot de Telegram que automatiza la aprobación y merge de Pull Requests en AWS CodeCommit usando Playwright (browser automation). Corre como proceso Node.js con PM2.

## Stack

- **Runtime**: Node.js + TypeScript (strict)
- **Browser automation**: Playwright (Chromium headless)
- **Bot**: Telegraf (Telegram Bot API)
- **Logging**: Winston
- **Process manager**: PM2

## Flujo principal

1. Un usuario pega una URL de PR de CodeCommit en el grupo de Telegram
2. El bot detecta la URL, la encola y envía botones inline pidiendo aprobación
3. Un usuario autorizado aprueba (botón ✅ o texto "si")
4. El bot ejecuta `fullPrFlow`:
   - Login en AWS Console (o reutiliza sesión guardada)
   - Switch a rol `devops/Authorizer` → navega al PR → click en "Approve"
   - Switch a rol `devops/Manager` → navega al PR → click en "Approve"
   - Switch a rol `MergeMaster` → navega al PR → ejecuta merge (3-way, llena author, submit)
5. Reporta resultado por Telegram (éxito o error con detalle)

## Estructura objetivo (post-refactor)

```
src/
├── aws/
│   ├── browser.ts          ← Clase AWSBrowser (lifecycle + orquestación)
│   ├── navigation.ts       ← navigateAndWait, waitForButton, waitForAwsLoaders, waitForDomStable
│   ├── auth.ts             ← login, isLoggedIn, waitForManualMfa, switchRole
│   ├── pr-actions.ts       ← approvePr, mergePr, helpers de merge
│   └── popups.ts           ← dismissFeedbackModal, dismissCookieModal, dismissPopups
├── bot/
│   ├── telegram-bot.ts     ← Creación del bot y wiring
│   ├── commands.ts         ← /status, /queue, /log, /pr
│   ├── handlers.ts         ← Inline buttons, text message handler
│   └── mfa-handler.ts     ← Lógica de MFA por Telegram
├── queue/
│   └── pr-queue.ts         ← Cola con persistencia
├── history/
│   ├── pr-debug.ts         ← PrDebugger (screenshots + logs)
│   └── pr-log.ts           ← Bitácora de resultados
├── utils/
│   ├── url-parser.ts       ← Parser de URLs CodeCommit
│   └── selectors.ts        ← Helper genérico trySelectors
├── types/
│   ├── index.ts            ← Re-exports
│   ├── pr.types.ts         ← PrInfo, PrFlowResult, QueueItem
│   ├── aws.types.ts        ← NavigationOptions, RoleConfig
│   └── bot.types.ts        ← Tipos del bot
├── config.ts
├── logger.ts
└── main.ts
data/                        ← Runtime data (fuera de src/)
├── pull-requests/           ← Screenshots y debug logs por PR
├── pr_queue.json            ← Cola persistida
└── pr_bitacora.txt          ← Bitácora histórica
```

## Convenciones

- Imports con extensión `.js` (ESM compilado)
- Logging con prefijo `[Módulo]` (ej: `[AWS]`, `[Bot]`, `[Queue]`)
- Emojis en logs para identificar rápido el estado
- Archivos de runtime data en `data/` (no en `src/`)
- Un archivo no debe superar ~300 líneas
- Cada módulo tiene una responsabilidad clara

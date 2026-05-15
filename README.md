# 🤖 Reclutalia AWS PR Bot

Bot de Telegram que automatiza la aprobación y merge de Pull Requests en AWS CodeCommit.

## Quick Start

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar
cp .env.example .env
# Editar .env con tus credenciales (ver docs/guia-instalacion.html)

# 3. Ejecutar
npm run start
```

## Documentación

Abre `docs/guia-instalacion.html` en tu navegador para la guía completa paso a paso.

## Comandos

| Comando | Descripción |
|---------|-------------|
| `npm run build` | Compila TypeScript |
| `npm run start` | Compila y ejecuta |
| `npm run dev` | Compila y ejecuta con tsx |
| `npm run validate` | Verifica tipos sin compilar |

## Estructura

```
src/
├── aws/           ← Automatización con Playwright
├── bot/           ← Bot de Telegram (Telegraf)
├── queue/         ← Cola de PRs con persistencia
├── ws/            ← WebSocket server (para widget de monitoreo)
├── history/       ← Debug y bitácora
├── utils/         ← Helpers
├── types/         ← Tipos TypeScript
├── config.ts      ← Configuración desde .env
├── logger.ts      ← Winston logger
└── main.ts        ← Entry point
data/              ← Runtime data (screenshots, logs, cola)
```

## Uso en Telegram

1. Pega una URL de PR de CodeCommit en el grupo
2. El bot muestra botones ✅ Aprobar / ❌ Rechazar
3. Un usuario autorizado aprueba
4. El bot hace approve + merge automáticamente

### Comandos del bot

- `/status` — Estado del bot
- `/queue` — Cola de PRs
- `/log` — Últimos 5 PRs procesados
- `/pr <url>` — Agregar PR manualmente

## Requisitos

- Node.js 18+
- Cuenta AWS con roles: devops/Authorizer, devops/Manager, MergeMaster
- Bot de Telegram configurado como admin en un grupo

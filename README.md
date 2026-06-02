# PR Automation Bot

Automatización end-to-end de aprobación y merge de Pull Requests en AWS CodeCommit, orquestado desde Telegram. Reduce un proceso manual de 4 pasos (login → switch role → approve × 2 → merge) a un solo tap.

---

## Problema

El equipo gestiona 30+ microservicios en AWS CodeCommit. Cada PR requiere:
1. Login en AWS Console
2. Cambiar a rol `devops/Authorizer` → Aprobar
3. Cambiar a rol `devops/Manager` → Aprobar
4. Cambiar a rol `MergeMaster` → Ejecutar merge

Esto toma ~5 minutos por PR, repetido 10-15 veces al día. La fricción atrasa deployments y crea cuellos de botella cuando el TL no está disponible.

**Este bot automatiza el flujo completo** — un desarrollador pega la URL del PR en Telegram, un usuario autorizado aprueba con un tap, y el bot se encarga del resto en ~90 segundos.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────┐
│  Grupo de Telegram                                               │
│  └─ Developer pega URL del PR → Bot envía solicitud             │
│  └─ Usuario autorizado toca ✅ → Bot procesa el PR              │
└──────────────────────────────────┬──────────────────────────────┘
                                   │ Telegraf (Bot API)
┌──────────────────────────────────▼──────────────────────────────┐
│  Proceso Node.js                                                 │
│  ├─ Cola (secuencial, persistente)                               │
│  ├─ Servidor WebSocket (status en tiempo real para widget)       │
│  └─ Automatización Playwright ──────┐                           │
└──────────────────────────────────────┼──────────────────────────┘
                                       │ Chromium Headless
┌──────────────────────────────────────▼──────────────────────────┐
│  AWS Console (CodeCommit)                                        │
│  ├─ Switch Role: devops/Authorizer → Aprobar                    │
│  ├─ Switch Role: devops/Manager → Aprobar                       │
│  └─ Switch Role: MergeMaster → Merge 3-way                     │
└─────────────────────────────────────────────────────────────────┘
```

### Decisiones de diseño

- **Browser automation sobre API**: El sistema de aprobaciones de CodeCommit no está completamente expuesto via AWS SDK. Playwright da control total sobre el flujo de consola, incluyendo switch de roles y MFA.
- **Cola secuencial**: Solo una instancia de browser corre a la vez. Los PRs se encolan y procesan en orden para evitar conflictos de sesión.
- **Persistencia de sesión**: Las cookies de AWS se guardan en disco, evitando re-login y MFA en cada PR (las sesiones duran ~12 horas).
- **Retry con backoff**: AWS Console ocasionalmente interrumpe la navegación durante switch de roles. El bot reintenta automáticamente (2 intentos con backoff exponencial).
- **WebSocket en tiempo real**: Un servidor WS local emite eventos paso a paso para un widget de monitoreo de escritorio opcional.

---

## Stack tecnológico

| Capa | Tecnología | Propósito |
|------|-----------|-----------|
| Runtime | Node.js + TypeScript (strict) | Automatización type-safe |
| Browser | Playwright (Chromium) | Interacción con AWS Console |
| Bot | Telegraf | API de Telegram |
| LLM | Ollama (qwen2.5-coder:7b) | Análisis inteligente de diffs |
| Cola | Custom (persistencia JSON) | Procesamiento secuencial |
| Tiempo real | ws (WebSocket) | Eventos de progreso en vivo |
| Logging | Winston | Logs estructurados con timestamp |
| Proceso | PM2 | Daemon en producción |

---

## Estructura del proyecto

```
src/
├── ai/
│   ├── diff-scraper.ts  # Extrae diff del DOM via Playwright
│   ├── llm-client.ts    # Cliente Ollama (fetch nativo)
│   ├── prompt-builder.ts # Prompt en español para análisis
│   ├── response-parser.ts # Extrae JSON de respuesta LLM
│   └── pr-analyzer.ts   # Orquestador: scrape → prompt → LLM → parse
├── aws/
│   ├── browser.ts       # Lifecycle + orquestación fullPrFlow
│   ├── auth.ts          # Login, MFA, switch de roles
│   ├── pr-actions.ts    # Approve, merge, interacción con formularios
│   ├── navigation.ts    # navigateAndWait con retry, estabilidad DOM
│   └── popups.ts        # Auto-dismiss de modals/cookies de AWS
├── bot/
│   ├── telegram-bot.ts  # Creación del bot + wiring del procesador
│   ├── commands.ts      # /status, /queue, /log, /pr
│   ├── handlers.ts      # Botones inline + aprobación por texto + integración IA
│   ├── helpers.ts       # sendToTopic, autorización
│   └── mfa-handler.ts   # Solicitud/respuesta de MFA por DM
├── queue/
│   └── pr-queue.ts      # Cola secuencial persistente
├── ws/
│   ├── events.ts        # Tipos de eventos WS (incluye AI events)
│   ├── pr-emitter.ts    # Emisor singleton de eventos
│   └── ws-server.ts     # Servidor WebSocket (puerto 9876)
├── history/
│   ├── pr-debug.ts      # Screenshots + debug logs por PR
│   └── pr-log.ts        # Bitácora histórica de resultados
├── scripts/
│   └── test-ai-analysis.ts # Script para probar análisis IA manual
├── utils/
│   ├── url-parser.ts    # Detección + normalización de URLs de CodeCommit
│   └── selectors.ts     # Helper genérico de selectores
├── types/               # Tipos compartidos (incluye ai.types.ts)
├── config.ts            # Configuración basada en variables de entorno
├── logger.ts            # Setup de Winston
└── main.ts              # Entry point
```

---

## Instalación

```bash
# Clonar
git clone <repo-url>
cd reclutalia-aws-pr-bot

# Instalar (también instala Chromium via Playwright)
npm install

# Configurar
cp .env.example .env
# Editar .env con tus credenciales
```

### Variables de entorno

```bash
# Telegram
TELEGRAM_BOT_TOKEN=         # Token de @BotFather
TELEGRAM_CHAT_ID=           # ID del grupo (número negativo)
TELEGRAM_OWNER_USER_ID=     # Tu ID numérico de Telegram (recibe MFA + alertas)
TELEGRAM_TOPIC_ID=          # Opcional: ID del topic
TELEGRAM_AUTHORIZED_USERS=  # Usernames autorizados (por coma, sin @)

# Perfiles de usuario para atribución del merge
USER_PROFILES=user1:Nombre Completo:email@empresa.com,user2:Nombre:email@empresa.com

# AWS
AWS_LOGIN_URL=              # URL de login de tu cuenta AWS
AWS_ACCOUNT_ID=             # Alias de la cuenta
AWS_USERNAME=               # Usuario IAM
AWS_PASSWORD=               # Contraseña IAM
AWS_AUTHOR_NAME=            # Nombre default del autor del merge
AWS_AUTHOR_EMAIL=           # Email default del autor del merge
HEADLESS=true               # true = browser invisible

# URLs de switch de rol (requeridas)
ROLE_AUTHORIZER_URL=        # URL de switch role para Authorizer
ROLE_MANAGER_URL=           # URL de switch role para Manager
ROLE_MERGE_URL=             # URL de switch role para MergeMaster

# AI (opcional — requiere Ollama corriendo localmente)
AI_ENABLED=false            # true/false para habilitar análisis IA
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:7b
OLLAMA_TIMEOUT=30000        # Timeout en ms
```

---

## Uso

### Ejecutar

```bash
npm run start          # Build + ejecutar
npm run dev            # Build + ejecutar con tsx
npm run validate       # Verificar tipos sin compilar
npm run ai:test -- "URL"  # Probar análisis IA sobre un PR
```

### Producción (PM2)

```bash
npm run build
pm2 start dist/main.js --name pr-bot
pm2 startup && pm2 save   # Auto-arranque al reiniciar
```

### Comandos de Telegram

| Comando | Descripción |
|---------|-------------|
| `/status` | Estado del bot + resumen de cola |
| `/queue` | Estado actual de la cola |
| `/log` | Últimos 5 PRs procesados |
| `/pr <url>` | Encolar un PR manualmente |

### Flujo de aprobación

1. Pegar una URL de PR de CodeCommit en el grupo
2. Si IA habilitada: el bot muestra "⏳ Obteniendo resumen IA...", analiza el diff con Ollama, y envía solicitud de aprobación con resumen + riesgos + archivos
3. Si IA deshabilitada o falla: envía solicitud de aprobación estándar
4. El bot envía botones inline (✅ Aprobar / ❌ Rechazar)
5. Usuario autorizado toca ✅
6. El bot procesa: login → approve (×2 roles) → merge → reportar resultado

Alternativa: responder con `si` o `si #29540` para aprobar por texto.

---

## AI Analysis (opcional)

El bot puede analizar el diff de cada PR usando un LLM local (Ollama) y mostrar un resumen inteligente antes de la aprobación.

### Cómo funciona

```
URL de PR detectada
       │
       ▼
"⏳ Obteniendo resumen IA..."  +  Evento WS: ai_login
       │
       ▼
Login (si necesario, con MFA)
       │
       ▼
Navega a tab "Changes" → Extrae diff (DOM scraping)  +  WS: ai_scraping
       │
       ▼
Envía diff a Ollama (qwen2.5-coder:7b)  +  WS: ai_analyzing
       │
       ▼
Borra mensaje temporal  +  WS: ai_result
       │
       ▼
Envía solicitud de aprobación enriquecida:
  • Resumen IA (si exitoso)
  • Solo archivos modificados (si Ollama falla)
  • Mensaje estándar (si todo falla)
```

### Configuración

```bash
# En .env
AI_ENABLED=true                          # true/false para habilitar/deshabilitar
OLLAMA_BASE_URL=http://localhost:11434    # URL de Ollama
OLLAMA_MODEL=qwen2.5-coder:7b           # Modelo a usar
OLLAMA_TIMEOUT=30000                     # Timeout en ms
```

### Requisitos

- [Ollama](https://ollama.ai) corriendo localmente
- Modelo descargado: `ollama pull qwen2.5-coder:7b`

### Testing manual

```bash
npm run ai:test -- "URL_DEL_PR"
```

Ejecuta el análisis completo (login → scraping → Ollama) sin pasar por Telegram.

### Fallbacks

| Situación | Resultado |
|-----------|-----------|
| `AI_ENABLED=false` | Mensaje estándar con botones |
| Login falla | Mensaje estándar con botones |
| Diff vacío | Solo lista de archivos + botones |
| Ollama timeout/error | Solo lista de archivos + botones |
| Todo falla | Mensaje estándar con botones |

---

## Prácticas de ingeniería

- **Arquitectura modular**: El monolito original de 1200 líneas fue refactorizado en 5 módulos enfocados (~150-290 líneas cada uno)
- **Type safety**: TypeScript strict, cero `any`, manejo de errores tipado (`catch (e: unknown)`)
- **Resiliencia**: Auto-retry en interrupciones de navegación, checks de estabilidad DOM, auto-dismiss de popups
- **Observabilidad**: Carpeta de debug por PR con screenshots timestampeados + snapshots HTML en cada paso
- **Seguridad**: Todas las credenciales en `.env`, cero secretos hardcodeados, archivos de sesión en `.gitignore`
- **Monitoreo en tiempo real**: Servidor WebSocket emite eventos granulares paso a paso para consumidores externos
- **Persistencia de cola**: Sobrevive reinicios del proceso, auto-recupera items en progreso

---

## Roadmap

- [x] **AI Analysis** — Resumen inteligente de PRs con Ollama (qwen2.5-coder:7b) antes de la aprobación
- [ ] **Widget de escritorio** (Electron) — Monitor visual en tiempo real mostrando progreso del pipeline (el servidor WS ya emite eventos)
- [ ] **Detección de conflictos** — Verificar estado del PR antes de intentar merge, saltar si hay conflictos
- [ ] **Soporte multi-cuenta** — Manejar PRs en diferentes cuentas AWS / regiones
- [ ] **Health check endpoint** — Endpoint HTTP para monitoreo de uptime
- [ ] **Métricas** — Trackear tasa de éxito, tiempo promedio de procesamiento, patrones de fallos
- [ ] **Refresh programado de sesión** — Renovar sesión AWS proactivamente antes de que expire

---

## Documentación

Abre `docs/guia-instalacion.html` en tu navegador para una guía visual paso a paso de instalación y configuración.

# reclutalia-aws-pr-bot

Bot de Telegram que automatiza la aprobación y merge de PRs en AWS CodeCommit, con capa de autorización humana por chat.

## Cómo funciona

1. Alguien envía un mensaje con URL(s) de PR de CodeCommit al topic de Telegram
2. El bot detecta las URLs, las encola y pide aprobación en el chat
3. Un usuario autorizado responde `si` o `no` (opcionalmente con `#NUMERO` del PR)
4. Si se aprueba, el bot abre un browser con Playwright, hace login en AWS y ejecuta:
   - Switch a rol `devops/Authorizer` → Approve
   - Switch a rol `devops/Manager` → Approve
   - Switch a rol `MergeMaster` → Merge (3-way merge)
5. Notifica el resultado en el topic y por DM al owner
6. Cierra el browser y procesa el siguiente PR en cola

## Setup

```bash
npm install
cp .env.example .env
# Editar .env con tus credenciales
```

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Token del bot de Telegram |
| `TELEGRAM_CHAT_ID` | ✅ | ID del grupo/supergrupo |
| `TELEGRAM_OWNER_USER_ID` | ✅ | ID numérico del owner (para DMs) |
| `TELEGRAM_TOPIC_ID` | ❌ | ID del topic donde escuchar (ej: `205`) |
| `TELEGRAM_AUTHORIZED_USERS` | ❌ | Usernames autorizados separados por coma |
| `AWS_LOGIN_URL` | ✅ | URL de login de la consola AWS |
| `AWS_ACCOUNT_ID` | ❌ | Alias de la cuenta AWS |
| `AWS_USERNAME` | ✅ | Usuario IAM |
| `AWS_PASSWORD` | ✅ | Contraseña IAM |
| `AWS_AUTHOR_NAME` | ❌ | Nombre para el commit de merge |
| `AWS_AUTHOR_EMAIL` | ❌ | Email para el commit de merge |
| `HEADLESS` | ❌ | `true` para browser sin ventana |

## Uso

```bash
# Desarrollo
npm run dev

# Producción
npm run build
npm start
```

## Despliegue con PM2

```bash
# Compilar y levantar
npm run build && pm2 start dist/main.js --name reclutalia-pr-auto-approver

# Reiniciar después de cambios
npm run build && pm2 restart reclutalia-pr-auto-approver

# Logs en tiempo real
pm2 logs reclutalia-pr-auto-approver

# Guardar para auto-inicio
pm2 save && pm2 startup
```

## Comandos del bot

| Comando | Descripción |
|---|---|
| `/status` | Estado del bot y cola de PRs |
| `/queue` | Ver cola de PRs (esperando aprobación, pendientes, procesando) |
| `/log` | Últimos 5 PRs de la bitácora |
| `/pr <url>` | Encolar un PR manualmente (solo usuarios autorizados) |

## Flujo de aprobación

Cuando llega un mensaje con URLs de PR al topic configurado:

1. El bot extrae todas las URLs de CodeCommit del mensaje (soporta múltiples PRs)
2. Cada PR se encola con estado `awaiting_approval`
3. El bot envía un mensaje pidiendo aprobación por cada PR:
   ```
   🔔 Solicitud de aprobación
   📦 Repo: mi-repo
   🔢 PR #: 29426
   ¿Aprobar este PR?
   Responde si #29426 o no #29426
   ```
4. Un usuario autorizado responde en el chat

### Respuestas válidas

| Mensaje | Acción |
|---|---|
| `si` | Aprueba (si hay 1 solo PR esperando) |
| `si #29426` | Aprueba el PR 29426 específicamente |
| `si 29426` | Aprueba el PR 29426 (sin #) |
| `sí #29426` | Aprueba (con acento) |
| `autorizar #29426` | Aprueba |
| `no` | Rechaza (si hay 1 solo PR esperando) |
| `no #29426` | Rechaza el PR 29426 |
| `denegar #29426` | Rechaza |

Si hay múltiples PRs esperando aprobación y se responde solo `si` o `no` sin número, el bot pide que se especifique cuál.

### Usuarios autorizados

Se configuran en `.env` por username de Telegram (sin @):

```
TELEGRAM_AUTHORIZED_USERS=juanalva997,JcLievano,gabrielbarba28,el_chambas3000
```

Solo estos usuarios pueden aprobar/rechazar PRs y usar el comando `/pr`.

## Cola de PRs

Los PRs se procesan secuencialmente (uno a la vez). Si llegan varios PRs:

1. Todos se encolan con estado `awaiting_approval`
2. Se pide aprobación para cada uno
3. Los aprobados pasan a `pending` y se procesan en orden
4. Mientras un PR se está procesando, los demás esperan en cola
5. Al terminar, el bot toma el siguiente `pending`

### Estados de un PR

| Estado | Descripción |
|---|---|
| `awaiting_approval` | Esperando que un usuario autorizado apruebe |
| `pending` | Aprobado, esperando su turno para procesarse |
| `processing` | En proceso (browser abierto, ejecutando flujo) |
| `done` | Completado exitosamente |
| `error` | Falló durante el procesamiento |
| `rejected` | Rechazado por un usuario autorizado |

## Archivos de persistencia

| Archivo | Descripción |
|---|---|
| `pr_queue.json` | Cola activa de PRs (se recupera al reiniciar) |
| `pr_bitacora.txt` | Historial de PRs procesados con fechas y detalles |
| `aws_session.json` | Cookies/sesión de AWS (se reutiliza entre PRs) |

## Flujo del browser (Playwright)

- El browser se inicia lazy: solo cuando un PR aprobado va a procesarse
- Al terminar cada PR, guarda la sesión y cierra el browser
- Al iniciar el siguiente PR, reabre el browser y carga la sesión guardada
- Si la sesión sigue válida, salta el login y va directo al rol
- Si expiró, hace login completo (con espera de MFA manual de 30s)

### Manejo de la consola de AWS

El bot maneja automáticamente:
- Modal de feedback de AWS Sign-in
- Banner de cookies ("Select your cookie preferences")
- Pantalla "Handle expiring password" (la salta)
- Spinners y loaders de la consola
- Estabilidad del DOM antes de interactuar

## Estructura del proyecto

```
src/
├── main.ts                 # Entry point
├── config.ts               # Variables de entorno
├── logger.ts               # Winston logger
├── types.ts                # Interfaces TypeScript
├── bot/
│   └── telegram-bot.ts     # Bot de Telegram + lógica de aprobación
├── aws/
│   └── browser.ts          # Playwright: login, roles, approve, merge
├── queue/
│   ├── pr-queue.ts         # Cola persistente con aprobación
│   └── pr-log.ts           # Bitácora de PRs
└── utils/
    └── url-parser.ts       # Extracción de URLs de CodeCommit
```

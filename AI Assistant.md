# AI PR Assistant — Feature Spec

## Objetivo

Agregar una capa de IA al bot existente que analice el diff de cada PR
y genere un resumen inteligente antes de enviarlo al grupo de Telegram.

## Flujo actual

1. Developer pega URL del PR en Telegram
2. Bot envía botones inline (✅ Aprobar / ❌ Rechazar)
3. Usuario autorizado aprueba
4. Bot procesa: login → approve × 2 → merge

## Flujo nuevo (con IA)

1. Developer pega URL del PR en Telegram
2. Bot detecta URL, encola el PR
3. Bot envía mensaje temporal "⏳ Obteniendo resumen IA..."
4. Bot emite eventos WebSocket (`ai_login`, `ai_scraping`, `ai_analyzing`) para el widget
5. **Bot verifica sesión en AWS, hace login si necesario (incluyendo MFA por Telegram)**
6. **Bot navega al tab "Changes" del PR y extrae el diff del DOM**
7. **Ollama (qwen2.5-coder:7b) analiza el diff y genera resumen**
8. Bot borra mensaje temporal
9. Bot envía mensaje de aprobación con:
   - Resumen IA + cambios + riesgos + botones ✅/❌ (si IA exitosa)
   - Solo archivos modificados + botones (si Ollama falla pero scraping OK)
   - Mensaje estándar + botones (si todo falla o IA deshabilitada)
10. Flujo de aprobación continúa igual

> Si la IA falla en cualquier punto, el flujo no se bloquea — se envía el mensaje con botones de aprobación inmediatamente.

## Stack de la capa IA

- **LLM**: Ollama local (`qwen2.5-coder:7b`)
- **Obtención del diff**: Playwright (scrapeo del tab "Changes" del PR)
- **Input**: diff del PR (texto plano, máx 8000 chars)
- **Output**: resumen estructurado (JSON → formateado en Telegram)

## Constraints

- El diff puede ser muy largo → truncado inteligente por archivo (no cortar a mitad de hunk)
- Debe ser opcional (`AI_ENABLED=true/false`)
- No debe bloquear el flujo si la IA falla (graceful fallback escalonado)
- Latencia aceptable: ~15 segundos (no bloquea porque mensaje temporal se muestra, y botones se envían al final)
- Sin dependencias externas pesadas (no LangChain, no OpenAI SDK)
- Emite eventos WebSocket para el widget de monitoreo

## Decisiones de diseño

| Decisión | Justificación |
|----------|---------------|
| Playwright para diff (no AWS SDK) | Las credenciales en .env son de sesión browser, no IAM programáticas |
| Solo Ollama (no OpenAI) | Ya corre localmente, sin costo, suficiente para la tarea |
| Modelo qwen2.5-coder:7b | Entrenado para código, mejor que llama3 para analizar diffs |
| Mensaje temporal → borra → nuevo mensaje con botones | Los botones de aprobación siempre llegan con el resumen (o sin él si falla) |
| Fallback escalonado | IA exitosa > solo archivos > mensaje estándar — nunca se bloquea |
| Truncado por archivo | Mejor contexto que cortar chars arbitrariamente |
| Tipos en src/types/ai.types.ts | Convención del proyecto: tipos compartidos en src/types/ |
| Reutilizar url-parser.ts | No duplicar lógica de parseo de URLs de CodeCommit |
| Eventos WebSocket para IA | El widget puede mostrar progreso del análisis en tiempo real |

## Arquitectura — Módulos nuevos

```
src/
├── ai/                        ← NUEVO
│   ├── diff-scraper.ts        # Navega al PR y extrae diff del DOM via Playwright
│   ├── llm-client.ts          # Cliente Ollama (fetch a localhost:11434)
│   ├── prompt-builder.ts      # Construye prompt en español para análisis de PR
│   ├── response-parser.ts     # Extrae JSON de la respuesta del LLM
│   └── pr-analyzer.ts         # Orquestador: scrape → prompt → LLM → parse
├── types/
│   └── ai.types.ts            ← NUEVO: PRAnalysis, DiffResult, OllamaConfig
├── bot/
│   └── handlers.ts            ← MODIFICAR: mensaje temporal + editar con análisis
└── config.ts                  ← MODIFICAR: agregar vars AI
```

## Detalle por módulo

### 1. `src/types/ai.types.ts`

```typescript
export interface DiffResult {
  content: string;
  truncated: boolean;
  filesChanged: string[];
}

export interface PRAnalysis {
  summary: string;
  changes: string[];
  risks: string[];
}

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeout: number;
}
```

### 2. `src/ai/diff-scraper.ts`

- Recibe la `Page` de Playwright (ya autenticada) y la URL del PR
- Navega al tab "Changes" del PR
- Extrae el diff del DOM (contenido de los bloques de código/diff)
- Trunca inteligentemente por archivo hasta máx 8000 chars
- Retorna `DiffResult`

### 3. `src/ai/llm-client.ts`

- Función `callOllama(prompt: string, config: OllamaConfig): Promise<string>`
- Usa `fetch` nativo contra `http://localhost:11434/api/generate`
- Timeout de 30 segundos via `AbortController`
- Lanza error tipado si falla (con mensaje descriptivo)

### 4. `src/ai/prompt-builder.ts`

- Función `buildPRAnalysisPrompt(diff: string, files: string[]): string`
- Prompt en español
- Pide respuesta SOLO en JSON con estructura `PRAnalysis`
- Incluye los archivos modificados como contexto

### 5. `src/ai/response-parser.ts`

- Función `parseLLMResponse(raw: string): PRAnalysis`
- Busca JSON en la respuesta (regex: primer `{` hasta último `}` balanceado)
- Si falla el parse, retorna valores default (no lanza error)

### 6. `src/ai/pr-analyzer.ts`

- Función `analyzePR(page: Page, prUrl: string): Promise<PRAnalysis | null>`
- Orquesta: `scrapeDiff` → `buildPrompt` → `callOllama` → `parseResponse`
- Si `AI_ENABLED=false`, retorna `null`
- Si cualquier paso falla, loggea y retorna `null`
- Loggea tiempo de ejecución total

### 7. Modificar `src/bot/handlers.ts`

- Al detectar URL de PR:
  1. Enviar mensaje temporal: "⏳ Obteniendo resumen IA para PR #{id}..."
  2. Emitir eventos WS (`ai_login`, `ai_scraping`, `ai_analyzing`)
  3. Login si no hay sesión (con MFA por Telegram si aplica)
  4. Scrape diff → Ollama → Parse
  5. Borrar mensaje temporal
  6. Enviar mensaje de aprobación con botones ✅/❌:
     - Con resumen IA (si exitoso)
     - Solo archivos (si Ollama falla pero scraping OK)
     - Estándar (si todo falla)
- Si `AI_ENABLED=false`: enviar mensaje estándar directo, sin análisis

### 8. Modificar `src/config.ts`

Agregar variables:

```typescript
// AI Configuration
AI_ENABLED: boolean;        // default: false
OLLAMA_BASE_URL: string;    // default: 'http://localhost:11434'
OLLAMA_MODEL: string;       // default: 'qwen2.5-coder:7b'
OLLAMA_TIMEOUT: number;     // default: 30000 (ms)
```

## Formato del mensaje enriquecido (Telegram)

### Con resumen IA (caso exitoso)
```
🔍 *PR detectado*
`{repo-name}` → PR #{id}

📋 *Resumen IA:*
{summary}

📁 *Cambios principales:*
• cambio 1
• cambio 2

⚠️ *Riesgos detectados:*
• riesgo 1

⁉ ¿Aprobar este PR?
[✅ Aprobar] [❌ Rechazar]
```

### Solo archivos (fallback si Ollama falla)
```
🔍 *PR detectado*
`{repo-name}` → PR #{id}

📁 *Archivos modificados ({n}):*
• `archivo1.ts`
• `archivo2.ts`

⁉ ¿Aprobar este PR?
[✅ Aprobar] [❌ Rechazar]
```

> La sección "Riesgos" solo aparece si `risks.length > 0`.
> La lista de archivos se limita a 15 máximo.

## Variables de entorno

```env
# AI Configuration
AI_ENABLED=true
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:7b
OLLAMA_TIMEOUT=30000
```

## Orden de implementación

1. `src/types/ai.types.ts` — Tipos
2. `src/config.ts` — Variables AI
3. `src/ai/llm-client.ts` — Cliente Ollama
4. `src/ai/prompt-builder.ts` — Prompt
5. `src/ai/response-parser.ts` — Parser
6. `src/ai/diff-scraper.ts` — Scrapeo del diff
7. `src/ai/pr-analyzer.ts` — Orquestador
8. `src/bot/handlers.ts` — Integración en bot
9. README.md — Documentación

## Notas de implementación

- `diff-scraper.ts` necesita investigar los selectores del tab "Changes" en AWS CodeCommit Console. Puede requerir ajustes según la UI actual.
- El modelo `qwen2.5-coder:7b` tiende a respetar bien instrucciones de formato JSON.
- Si en el futuro se quiere agregar OpenAI, se crea un segundo cliente en `llm-client.ts` con una factory function. No sobre-ingeniería ahora.
- El script `npm run ai:test -- "URL"` permite probar el flujo completo sin Telegram.
- Eventos WebSocket nuevos: `ai_step` (progreso) y `ai_result` (resultado) — el widget puede escucharlos para mostrar el estado del análisis.

## Eventos WebSocket para el widget

### `ai_step` — Progreso del análisis

```json
{
  "type": "ai_step",
  "prNumber": "29537",
  "repo": "reclutalia",
  "step": "ai_login" | "ai_scraping" | "ai_analyzing",
  "status": "in_progress" | "done" | "error",
  "error": "mensaje de error (opcional)",
  "timestamp": "2026-06-02T..."
}
```

### `ai_result` — Resultado del análisis

```json
{
  "type": "ai_result",
  "prNumber": "29537",
  "repo": "reclutalia",
  "success": true,
  "summary": "Resumen del PR...",
  "filesChanged": ["src/file1.ts", "src/file2.ts"],
  "timestamp": "2026-06-02T..."
}
```

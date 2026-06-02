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
2. Bot envía mensaje temporal "⏳ Analizando PR..."
3. **Bot navega al PR con Playwright y extrae el diff del DOM**
4. **Ollama (qwen2.5-coder:7b) analiza el diff y genera resumen**
5. Bot **edita** el mensaje temporal con el resumen enriquecido + botones inline
6. Flujo de aprobación continúa igual

> Si la IA falla o está deshabilitada, se envía el mensaje original sin cambios (fallback).

## Stack de la capa IA

- **LLM**: Ollama local (`qwen2.5-coder:7b`)
- **Obtención del diff**: Playwright (scrapeo del tab "Changes" del PR)
- **Input**: diff del PR (texto plano, máx 8000 chars)
- **Output**: resumen estructurado (JSON → formateado en Telegram)

## Constraints

- El diff puede ser muy largo → truncado inteligente por archivo (no cortar a mitad de hunk)
- Debe ser opcional (`AI_ENABLED=true/false`)
- No debe bloquear el flujo si la IA falla (graceful fallback)
- Latencia aceptable: ~15 segundos (no bloquea porque se usa mensaje temporal + editar)
- Sin dependencias externas pesadas (no LangChain, no OpenAI SDK)

## Decisiones de diseño

| Decisión | Justificación |
|----------|---------------|
| Playwright para diff (no AWS SDK) | Las credenciales en .env son de sesión browser, no IAM programáticas |
| Solo Ollama (no OpenAI) | Ya corre localmente, sin costo, suficiente para la tarea |
| Modelo qwen2.5-coder:7b | Entrenado para código, mejor que llama3 para analizar diffs |
| Mensaje temporal → editar | No bloquea aprobación mientras IA procesa |
| Truncado por archivo | Mejor contexto que cortar chars arbitrariamente |
| Tipos en src/types/ai.types.ts | Convención del proyecto: tipos compartidos en src/types/ |
| Reutilizar url-parser.ts | No duplicar lógica de parseo de URLs de CodeCommit |

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
  1. Enviar mensaje temporal: "⏳ Analizando PR #{id}..."
  2. Llamar `analyzePR(page, url)`
  3. Si retorna `PRAnalysis`, editar mensaje con formato enriquecido
  4. Si retorna `null`, editar mensaje con formato original + botones
- Botones de aprobación disponibles desde el inicio (en el mensaje editado)

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

```
🔍 *PR detectado*
`{repo-name}` → PR #{id}

📋 *Resumen IA:*
{summary}

📁 *Archivos modificados ({n}):*
• archivo1.ts
• archivo2.ts

⚠️ *Riesgos detectados:*
• riesgo 1

[✅ Aprobar] [❌ Rechazar]
```

> La sección "Riesgos" solo aparece si `risks.length > 0`.

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

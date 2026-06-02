---
inclusion: always
---

# Coding Standards

## TypeScript

- Strict mode habilitado
- No usar `any` — preferir `unknown` y hacer narrowing
- Interfaces para contratos públicos, types para unions/intersections
- Exports explícitos (no `export default`)
- Imports con extensión `.js` (requerido por ESM)

## Estructura de archivos

- Máximo ~300 líneas por archivo
- Un archivo = una responsabilidad clara
- Nombrar archivos en kebab-case: `pr-actions.ts`, `url-parser.ts`
- Carpetas agrupan por dominio: `aws/`, `bot/`, `queue/`, `history/`, `utils/`, `types/`

## Tipos

- Separar tipos de entrada (Input/Params) de tipos de estado interno
- Usar tipos literales para estados: `'pending' | 'processing' | 'done' | 'error'`
- Interfaces con prefijo descriptivo, no `I`: `NavigationOptions`, no `INavigationOptions`
- Tipos compartidos en `src/types/`, tipos locales junto al módulo que los usa

## Manejo de errores

- Siempre tipar el catch: `catch (e: unknown)`
- Usar `String(e)` o `e instanceof Error ? e.message : String(e)` para mensajes
- Logging del error antes de re-throw o return
- Funciones que pueden fallar retornan `boolean` o `Result<T>` — no lanzan excepciones silenciosas

## Patrones del proyecto

### Selectores de AWS Console

Usar el helper `trySelectors` para intentar múltiples selectores:

```typescript
// ✅ Correcto
const clicked = await trySelectors(page, selectors, 'click', { timeout: 3000 });

// ❌ Evitar — loops manuales repetidos
for (const sel of selectors) {
  try { ... } catch { /* next */ }
}
```

### Logging

```typescript
// Prefijo de módulo + emoji de estado
logger.info("[AWS] ✅ Login exitoso");
logger.warn("[AWS] ⚠️ URL inesperada post-login");
logger.error("[AWS] ❌ Error en merge: ${e}");
```

### Resiliencia en navegación

- Siempre usar `navigateAndWait` en vez de `page.goto` directo
- Incluir retry para errores de "navigation interrupted"
- Esperar estabilidad del DOM después de acciones que causan redirects
- Timeout explícito en toda operación de navegación

## Capa IA (src/ai/)

### Principios

- La IA es **opcional** — todo el módulo se cortocircuita si `AI_ENABLED=false`
- Nunca lanzar excepciones que rompan el flujo del bot — si falla, se envía mensaje estándar con botones
- Logging con prefijo `[AI]` + emoji de estado
- Emitir eventos WebSocket (`ai_step`, `ai_result`) para que el widget muestre progreso

### Flujo de integración en handlers.ts

1. Mensaje temporal "⏳ Obteniendo resumen IA..." (se borra al terminar)
2. Login propio si no hay sesión (reutiliza `awsBrowser.ensureStarted()`)
3. Si login falla → fallback a mensaje estándar con botones (no bloquea)
4. Scrape diff → Ollama → Parse → mensaje de aprobación enriquecido
5. Fallback escalonado: resumen IA > solo archivos > mensaje estándar

### Ollama

- Llamadas via `fetch` nativo (no SDKs pesados)
- Timeout con `AbortController` (default 30s)
- Modelo por env var, no hardcodeado

### Diff scraping

- Reutilizar la instancia de Playwright existente (no crear browser nuevo)
- Reutilizar `url-parser.ts` para extraer repo/prId de la URL
- Truncado inteligente: por archivo completo, no cortar a mitad de hunk
- Límite: 8000 chars máximo al LLM

### Formato de respuesta

- El LLM responde en JSON: `{ summary, changes[], risks[] }`
- El parser usa regex para extraer JSON (no confiar en formato limpio)
- Si parse falla → valores default, no error

### Script de testing

- `npm run ai:test -- "URL_PR"` ejecuta el análisis aislado (sin Telegram)
- Útil para validar selectores y respuestas de Ollama

## Runtime data

- Screenshots, logs de debug, cola JSON, bitácora → carpeta `data/` en raíz
- Nunca guardar runtime data dentro de `src/`
- Paths resueltos desde `process.cwd()` + `data/`

## Git

- No commitear: `aws_session.json`, `data/pull-requests/`, `.env`
- Sí commitear: `data/pr_bitacora.txt` (historial útil)

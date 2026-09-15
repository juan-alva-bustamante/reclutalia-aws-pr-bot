# Plan de correcciones — reclutalia-aws-pr-bot

> Generado a partir de una revisión de arquitectura y lógica del código en `src/`.
> Estado del repo al momento de la revisión: 4230 líneas en `src/`, sin tests, sin lint funcional.

## Cómo leer este documento

Cada ítem tiene:
- **Problema** — qué está mal y por qué importa.
- **Archivos afectados** — dónde tocar.
- **Fix propuesto** — qué hacer.
- **Esfuerzo** — estimación aproximada (S = <1h, M = 1-3h, L = medio día+).

Los ítems están ordenados por severidad, no por orden de implementación sugerido.

---

## 🔴 Crítico

### 1. Colisión de `prNumber` entre repositorios distintos

**Problema:** CodeCommit numera los Pull Requests **por repositorio**, no globalmente. Con 30+ microservicios en la cuenta, es perfectamente posible que el repo `service-a` y el repo `service-b` tengan simultáneamente un PR #145 esperando aprobación. `PrQueue.approve()`, `PrQueue.reject()` y `PrQueue.setAiSummary()` buscan el item **solo por `prNumber`**, ignorando `repo`:

```ts
// src/queue/pr-queue.ts:73-77
approve(prNumber: string, approvedBy: string): QueueItem | null {
  const item = this.items.find(
    (i) => i.prNumber === prNumber && i.status === "awaiting_approval",
  );
```

Si dos PRs con el mismo número de dos repos distintos están `awaiting_approval` a la vez, `approve("145", ...)` va a resolver al primero que encuentre en el array — no necesariamente al que el usuario cree estar aprobando. Con un bot que ejecuta merge automático a producción, esto es el riesgo más serio del repo: puede aprobar/mergear el repo equivocado sin que nadie lo note hasta después.

**Archivos afectados:**
- `src/queue/pr-queue.ts` (`approve`, `reject`, `setAiSummary`, y el matching de duplicados en `enqueue`)
- `src/bot/handlers.ts` (comando de aprobación por texto: `si #NUMERO` — debería aceptar/mostrar el repo cuando hay ambigüedad)
- `src/bot/commands.ts` / mensajes que listan PRs por número

**Fix propuesto:**
1. Cambiar la clave de búsqueda a `repo + prNumber` en todos los métodos de `PrQueue` que hacen lookup.
2. Cuando el usuario aprueba por texto con solo `#NUMERO` y hay más de un PR con ese número (en repos distintos) esperando aprobación, forzar que especifique también el repo (ej. `si repo-a#145`), igual que ya se hace hoy cuando hay múltiples PRs esperando sin número.
3. Los botones inline (`approve:${prNumber}`) tienen el mismo problema potencial si Telegram no distingue mensajes — usar `callback_data: approve:${repo}:${prNumber}` es más seguro y evita ambigüedad total.

**Esfuerzo:** M

---

### 2. El merge no verifica éxito real (conflictos no detectados)

**Problema:** `mergePr()` en `src/aws/pr-actions.ts` retorna `true` en cuanto se hace click en "Merge pull request" y la página termina de cargar — no verifica que AWS Console haya confirmado el merge (por ejemplo, un banner de éxito o la ausencia de un mensaje de conflicto/error). Si el merge falla por conflictos de 3-way merge, el bot lo reporta como éxito igual.

Este gap ya está reconocido en el roadmap del README ("Detección de conflictos — Verificar estado del PR antes de intentar merge, saltar si hay conflictos"), pero conviene resolverlo pronto porque agrava el bug #1: un merge silenciosamente fallido que se reporta como éxito es más difícil de detectar y corregir después.

**Archivos afectados:** `src/aws/pr-actions.ts` (función `mergePr`)

**Fix propuesto:** Después del click en "Merge pull request", esperar explícitamente a uno de dos resultados:
- Indicador de éxito (banner "Pull request merged", cambio de estado del PR a "Merged", o desaparición del formulario de merge).
- Indicador de error/conflicto (texto "conflict", "cannot be merged", banner de error).

Si no se detecta ninguno de los dos en un timeout razonable, tratarlo como fallo (no como éxito por defecto) y capturar screenshot/HTML para debug, igual que ya se hace en los demás pasos.

**Esfuerzo:** M

---

## 🟠 Alto

### 3. Duplicación casi exacta entre `handlers.ts` y `pre-merge-analysis.ts`

**Problema:** `sendApprovalWithAnalysis()` en `src/bot/handlers.ts:193-355` y `analyzeAndRequestApproval()` en `src/bot/pre-merge-analysis.ts:24-171` son ~150 líneas casi idénticas: mismo flujo (mensaje temporal → login → scraping → Ollama → mensaje enriquecido), y las tres funciones de formato (`formatEnrichedMessage`, `formatFilesOnlyMessage`, `formatStandardMessage`) están copiadas literalmente en ambos archivos. Cualquier cambio futuro al flujo de IA (ej. el fix del bug de Markdown del ítem #6) hay que aplicarlo dos veces, y ya hay riesgo de que diverjan sin que nadie lo note.

**Archivos afectados:** `src/bot/handlers.ts`, `src/bot/pre-merge-analysis.ts`

**Fix propuesto:** Mover la lógica común a una sola función en `pre-merge-analysis.ts` (por ejemplo `runAiAnalysisAndSendApproval(bot, awsBrowser, chatId, prInfo, queue)`) y hacer que `handlers.ts` la invoque directamente en vez de mantener su propia copia. Eliminar `formatEnrichedMessage`/`formatFilesOnlyMessage`/`formatStandardMessage` de `handlers.ts`.

**Esfuerzo:** M

---

### 4. Imports dinámicos innecesarios

**Problema:** Las dos funciones duplicadas del ítem #3 usan `await import(...)` para `aws/auth.js` y los cuatro módulos de `ai/*` en vez de imports estáticos al inicio del archivo:

```ts
// src/bot/handlers.ts:243, 258, 266-268
const { isLoggedIn, login, saveSession } = await import("../aws/auth.js");
const { scrapeDiff } = await import("../ai/diff-scraper.js");
const { buildPRAnalysisPrompt } = await import("../ai/prompt-builder.js");
const { callOllama } = await import("../ai/llm-client.js");
const { parseLLMResponse } = await import("../ai/response-parser.js");
```

No hay dependencia circular que lo justifique: `src/ai/pr-analyzer.ts` importa exactamente los mismos módulos de forma estática sin problema. Esto solo agrega indirección y hace más difícil rastrear dependencias con herramientas estáticas.

**Archivos afectados:** `src/bot/handlers.ts`, `src/bot/pre-merge-analysis.ts`

**Fix propuesto:** Reemplazar por imports estáticos al inicio del archivo. Se resuelve solo al aplicar el fix del ítem #3 (la función unificada puede importar todo de forma estática).

**Esfuerzo:** S (viene incluido en el ítem #3)

---

## 🟡 Medio

### 5. Utilidad `trySelectors` / `AWS_EXCLUDE_ANCESTORS` sin usar (código muerto)

**Problema:** `src/utils/selectors.ts` define `trySelectors()` y la constante `AWS_EXCLUDE_ANCESTORS` explícitamente para evitar el patrón repetitivo de "probar selectores en un for + try/catch" y para centralizar la lista de ancestros a excluir al buscar botones. Ninguna de las dos se usa en ningún otro archivo — confirmado por grep. Mientras tanto, el array `excludeAncestors` que `AWS_EXCLUDE_ANCESTORS` debería reemplazar está copiado manualmente **3 veces**:

- `src/aws/pr-actions.ts:152` (`clickMergeButton`)
- `src/aws/pr-actions.ts:591` (`clickMergePullRequest`)
- `src/aws/navigation.ts:68` (`waitForButton`)

**Archivos afectados:** `src/utils/selectors.ts`, `src/aws/pr-actions.ts`, `src/aws/navigation.ts`

**Fix propuesto:** Elegir una de dos:
- **(a) Adoptar:** reemplazar las 3 copias de `excludeAncestors` por `AWS_EXCLUDE_ANCESTORS` importado. Nota: como se usa dentro de `page.evaluate()`, hay que pasarlo como argumento serializado (no se puede capturar por closure en el contexto del browser).
- **(b) Eliminar:** si `trySelectors()` no encaja bien con el patrón real de `page.evaluate()` usado en la mayoría de estos casos, borrar el archivo completo para no dejar código muerto.

Recomendación: (a) para `AWS_EXCLUDE_ANCESTORS` (fácil, reduce triplicación), (b) para `trySelectors()` si tras revisarlo no aplica bien a los casos reales.

**Esfuerzo:** S

---

### 6. Script `npm run lint` roto

**Problema:** `package.json` define `"lint": "eslint src/"`, pero `eslint` no está en `devDependencies` y no existe ningún archivo de configuración (`.eslintrc*` / `eslint.config.*`) en el repo. El comando falla apenas se ejecuta.

**Archivos afectados:** `package.json`

**Fix propuesto:** Elegir una de dos:
- Instalar `eslint` + `typescript-eslint` y agregar una config mínima acorde al estilo ya usado (strict TS, sin `any`).
- Si no se va a mantener lint por ahora, quitar el script para no dejar un comando roto en el `package.json`.

**Esfuerzo:** S (quitar el script) / M (configurar eslint real)

---

### 7. Sin tests automatizados

**Problema:** No existe ningún `*.test.ts` / `*.spec.ts` en el repo. Hay varias piezas de lógica pura, fáciles de testear sin necesidad de mockear Playwright/Telegram, que hoy dependen 100% de pruebas manuales:

- `src/utils/url-parser.ts` — regex de extracción/normalización de URLs (fácil que una URL con formato ligeramente distinto rompa el matching sin que se note).
- `src/ai/response-parser.ts` — parseo tolerante a fallos del JSON del LLM.
- `src/queue/pr-queue.ts` — máquina de estados (`queued` → `awaiting_approval` → `pending` → `processing` → `done`/`error`, más `rejected`), incluyendo el bug del ítem #1.

**Archivos afectados:** nuevo directorio `src/**/*.test.ts` o `tests/`

**Fix propuesto:** Agregar `vitest` (liviano, funciona bien con ESM + TS sin configuración extra) y cubrir primero `url-parser.ts`, `response-parser.ts` y `pr-queue.ts` (este último sirve además como test de regresión para el fix del ítem #1).

**Esfuerzo:** M (setup + primeros tests)

---

## 🟢 Bajo

### 8. `AWSBrowser.fullPrFlow` muy repetitivo

**Problema:** `src/aws/browser.ts:92-227` repite 4 veces el mismo patrón (switch de rol → emitir evento `in_progress` → verificar → si falla: log + screenshot + emitir error + return; si OK: emitir `done`). Son ~140 líneas donde la lógica real cabría en ~50-60 con un helper.

**Fix propuesto:** Extraer un helper interno tipo:

```ts
private async runStep(
  prNum: string, repo: string, step: PrStep,
  action: () => Promise<boolean>, errorLabel: string,
): Promise<boolean> {
  prEmitter.step(prNum, repo, step, "in_progress");
  const ok = await action();
  if (!ok) {
    await debug.screenshot(this.pg, `${step}_failed`);
    result.error = errorLabel;
    prEmitter.step(prNum, repo, step, "error", errorLabel);
    prEmitter.errorPr(prNum, repo, errorLabel);
    return false;
  }
  prEmitter.step(prNum, repo, step, "done");
  return true;
}
```

y usarlo para cada uno de los 6 pasos del flujo. Reduce el riesgo de que un copy-paste futuro entre pasos introduzca una inconsistencia (por ejemplo, olvidar un `prEmitter.errorPr(...)` en un paso nuevo).

**Esfuerzo:** M

---

### 9. Arranque de cola depende de un `setTimeout(2000)` mágico

**Problema:** `src/queue/pr-queue.ts:20-31` — la recuperación de items `pending`/`queued` al iniciar el proceso se dispara con un `setTimeout(..., 2_000)` fijo, asumiendo que en 2 segundos el bot ya está listo para procesar. Es un heurístico frágil: si el arranque del bot (conexión a Telegram, etc.) tarda más en algún entorno, la recuperación podría dispararse antes de que `onProcess`/`onQueuedReady` estén completamente operativos (aunque hoy ya se registran antes de `bot.launch()`, así que el riesgo actual es bajo, pero sigue siendo un timing implícito no documentado como contrato).

**Fix propuesto:** Reemplazar el `setTimeout` por una llamada explícita `queue.runStartupRecovery()` invocada después de que `bot.launch()` resuelve (o después de confirmar conexión), en vez de depender de un delay arbitrario.

**Esfuerzo:** S

---

### 10. `escapeTelegramMarkdown` no escapa todos los caracteres problemáticos

**Problema:** `src/bot/helpers.ts:35-43` solo escapa `_`, `[` y `]`, pero no `*` ni `` ` ``. El texto que escapa es el resumen/cambios/riesgos generados por el LLM (texto libre, no controlado por el bot), que perfectamente puede incluir asteriscos o backticks (ej. el LLM menciona un nombre de función entre backticks). Si el LLM genera un backtick o asterisco impar, `parse_mode: "Markdown"` de Telegram puede fallar al enviar el mensaje.

**Impacto real:** bajo, porque tanto `handlers.ts` como `pre-merge-analysis.ts` ya tienen un catch que reintenta sin Markdown si falla el envío — pero vale la pena escapar correctamente para no depender del fallback en el camino feliz.

**Fix propuesto:** Agregar `*` y `` ` `` a la lista de caracteres escapados en `escapeTelegramMarkdown`.

**Esfuerzo:** S

---

## Resumen priorizado

| # | Ítem | Severidad | Esfuerzo |
|---|------|-----------|----------|
| 1 | Colisión de `prNumber` entre repos | 🔴 Crítico | M |
| 2 | Merge no verifica éxito real | 🔴 Crítico | M |
| 3 | Duplicación `handlers.ts` / `pre-merge-analysis.ts` | 🟠 Alto | M |
| 4 | Imports dinámicos innecesarios | 🟠 Alto | S (incluido en #3) |
| 5 | Código muerto en `utils/selectors.ts` | 🟡 Medio | S |
| 6 | Script `lint` roto | 🟡 Medio | S/M |
| 7 | Sin tests automatizados | 🟡 Medio | M |
| 8 | `fullPrFlow` repetitivo | 🟢 Bajo | M |
| 9 | `setTimeout` mágico en arranque de cola | 🟢 Bajo | S |
| 10 | Escapado de Markdown incompleto | 🟢 Bajo | S |

**Orden de implementación sugerido:** 1 → 2 → 3 (que arrastra el 4) → 7 (agregar test de regresión para el fix de 1) → 5, 6, 9, 10 → 8.

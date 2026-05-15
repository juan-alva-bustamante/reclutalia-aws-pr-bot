---
inclusion: fileMatch
fileMatchPattern: "src/aws/**"
---

# Playwright Patterns — AWS Console Automation

## Contexto

AWS Console es una SPA pesada con React, múltiples loaders, modals inesperados y redirects tardíos. Las estrategias estándar de Playwright (waitForNavigation, networkidle) no funcionan bien aquí.

## Navegación

### Siempre usar `navigateAndWait` — nunca `page.goto` directo

```typescript
// ✅ Correcto
await this.navigateAndWait(url, { timeout: 60_000, retries: 2 });

// ❌ Incorrecto — no maneja loaders ni redirects
await this.pg.goto(url, { waitUntil: "domcontentloaded" });
```

### Estrategia de navegación

1. `page.goto(url, { waitUntil: "domcontentloaded" })` — no usar `networkidle` (AWS nunca para)
2. `waitForAwsLoaders()` — esperar que spinners desaparezcan
3. `waitForDomStable()` — esperar que el DOM no mute por 1 segundo
4. `dismissPopups()` — cerrar modals de feedback/cookies si aparecen

### Retry en navegación interrumpida

El error `"Navigation is interrupted by another navigation"` ocurre cuando AWS hace un redirect tardío post-switch-role. Solución:

```typescript
// Retry automático con backoff
for (let attempt = 0; attempt <= retries; attempt++) {
  try {
    await this.pg.goto(url, { waitUntil: "domcontentloaded", timeout });
    break;
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("interrupted by another navigation") && attempt < retries) {
      await this.sleep(3_000 * (attempt + 1));
      continue;
    }
    throw e;
  }
}
```

## Selectores

### Prioridad de estrategias

1. **`page.evaluate()`** — más confiable para AWS Console (acceso directo al DOM)
2. **Playwright locators** — fallback cuando evaluate no es suficiente
3. **Keyboard shortcuts** — último recurso (Enter, Escape)

### Excluir elementos del header/nav de AWS

Siempre excluir el chrome de AWS al buscar botones:

```typescript
const excludeAncestors = [
  "[id^='awsc-']",
  "#aws-nav-header",
  "[id='awsui-dropdown']",
].join(", ");

// Verificar: if (btn.closest(excludeAncestors)) continue;
```

### Helper `trySelectors`

Para evitar loops repetitivos de try/catch con selectores:

```typescript
interface TrySelectorOptions {
  timeout?: number;
  action: 'click' | 'visible' | 'fill';
  value?: string;
}

async function trySelectors(
  page: Page,
  selectors: string[],
  options: TrySelectorOptions
): Promise<boolean> { ... }
```

## Modals y popups de AWS

AWS Console muestra modals inesperados en cualquier momento:
- **Feedback modal** — "Feedback for AWS Sign-in" con botón Cancel
- **Cookie banner** — `#awsccc-cb-btn-accept`
- **What's new** — `button[data-testid='whats-new-close']`
- **Expiring password** — link "Skip and continue to sign in"

### Auto-dismiss script

Se inyecta via `page.addInitScript()` un MutationObserver que cierra el modal de Feedback automáticamente. Esto corre en background sin bloquear el flujo.

## Switch de rol

Después de hacer click en "Switch Role", AWS puede hacer un redirect tardío. Siempre:

1. Esperar `waitForLoadState("domcontentloaded")`
2. Esperar `waitForAwsLoaders()`
3. Esperar `waitForDomStable()`
4. **Verificar que la URL no sea `/console/home`** — si lo es, el switch falló o hay redirect pendiente
5. Agregar `sleep(2_000)` de seguridad antes de la siguiente navegación

## Formularios React de AWS (AWSUI)

Los inputs de AWS Console son componentes React que no responden bien a `.fill()`:

```typescript
// Estrategia para inputs React
await el.click();
await el.press("Control+a");
await el.press("Backspace");
await el.type(value, { delay: 40 });
await el.press("Tab"); // Trigger onChange de React
await this.sleep(300);
```

## Timeouts recomendados

| Operación | Timeout |
|-----------|---------|
| Navegación a página | 60s |
| Esperar botón (polling) | 30s |
| Esperar loader | 15s |
| DOM estable | 15s (1s sin mutaciones) |
| Visibilidad de elemento | 3-5s |
| Entre acciones | 1-2s sleep |

## Screenshots y debug

Usar `PrDebugger` para capturar estado en cada paso crítico:

```typescript
await debug?.screenshot(this.pg, "before_merge");
debug?.log("Descripción del paso");
```

En caso de error, siempre capturar screenshot + HTML:

```typescript
catch (e: unknown) {
  await debug?.screenshot(this.pg, "error_step_name");
  await debug?.saveHtml(this.pg, "error_step_name");
  throw e;
}
```

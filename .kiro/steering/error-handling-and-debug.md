---
inclusion: fileMatch
fileMatchPattern: "src/history/**,src/aws/**"
---

# Error Handling & Debug System

## Sistema de debug por PR

Cada PR procesado genera una carpeta en `data/pull-requests/{prNumber}/` con:

- `debug.log` — Log cronológico de cada paso del flujo
- `01_before_merge.png`, `02_merge_page_loaded.png`, etc. — Screenshots numerados
- `*.html` — HTML de la página en caso de error (para debug offline)

### Uso del PrDebugger

```typescript
const debug = new PrDebugger(prNumber);

// Registrar pasos
debug.log("✅ Login OK");
debug.log(`URL: ${prUrl}`);

// Screenshots en puntos clave
await debug.screenshot(page, "merge_page_loaded");

// En caso de error, capturar todo
await debug.screenshot(page, "error_step_name");
await debug.saveHtml(page, "error_step_name");
```

### Puntos de captura obligatorios

| Paso | Label del screenshot |
|------|---------------------|
| Antes del merge | `before_merge` |
| Página del PR cargada | `merge_page_loaded` |
| Formulario de merge | `merge_form_loaded` |
| Antes de submit | `before_merge_submit` |
| Después de submit | `after_merge_submit` |
| Cualquier error | `{step}_failed` o `{step}_error` |

## Bitácora (`pr_bitacora.txt`)

Registro histórico de todos los PRs procesados (éxito y error). Cada entrada incluye:

- PR number y repo
- Estado (COMPLETADO / ERROR)
- Quién solicitó y quién aprobó
- Timestamps de inicio y fin
- Pasos completados
- Error (si aplica)

### Formato

```
────────────────────────────────────────────────────────────
✅ PR #29538 — reclutalia-front-web
   Estado:    COMPLETADO
   Solicitó:  @Alex_139139
   Aprobó:    @JcLievano (Juan Carlos Lievano <juan.lievano@tecnologiaaccionable.mx>)
   Inicio:    2026-04-29T17:36:10.333Z
   Fin:       2026-04-29T17:37:57.125Z
   Pasos:
     ✅ Login en AWS
     ✅ Aprobado con devops/Authorizer
     ✅ Aprobado con devops/Manager
     ✅ Merge completado con MergeMaster
────────────────────────────────────────────────────────────
```

## Patrones de error conocidos

### 1. "Navigation interrupted by another navigation"

- **Causa**: AWS hace redirect tardío post-switch-role al `/console/home`
- **Cuándo**: Justo después de `switchRole()`, al navegar al PR
- **Solución**: Retry con backoff en `navigateAndWait`, espera post-switch-role
- **Frecuencia**: Intermitente (~5% de los PRs)

### 2. "Botón Merge/Approve no encontrado"

- **Causa**: La página no terminó de cargar, o el PR ya fue mergeado/cerrado
- **Cuándo**: En `approvePr()` o `mergePr()`
- **Solución**: Verificar estado del PR antes de buscar botón, aumentar timeout de polling

### 3. "Target page, context or browser has been closed"

- **Causa**: El browser se cerró inesperadamente (crash, OOM, timeout de PM2)
- **Cuándo**: Al intentar guardar sesión post-merge
- **Solución**: Wrap en try/catch, no fallar el flujo si solo falla el save de sesión

### 4. "Falló el merge con MergeMaster"

- **Causa**: Múltiples — botón no encontrado, formulario no cargó, conflictos en el PR
- **Cuándo**: En la fase de merge
- **Solución**: Revisar screenshots del debug, verificar si el PR tiene conflictos

## Estrategia de resiliencia

### Retries

```typescript
// Para navegación: max 2 retries con backoff
// Para clicks en botones: polling cada 2s por 30s (ya implementado en waitForButton)
// Para formularios: no retry — si falla, reportar error
```

### Resultado del flujo

```typescript
interface PrFlowResult {
  success: boolean;
  steps: string[];    // Pasos completados (para saber dónde falló)
  error?: string;     // Mensaje de error si !success
}
```

### Principio: nunca fallar silenciosamente

- Todo error se loguea con `logger.error`
- Todo error se registra en el debug log del PR
- Todo error se reporta por Telegram (grupo + DM al owner)
- Los screenshots permiten debug post-mortem sin reproducir el problema

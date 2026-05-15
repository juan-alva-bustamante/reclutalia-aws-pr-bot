---
inclusion: fileMatch
fileMatchPattern: "src/queue/**"
---

# Queue & PR Flow

## Cola de PRs (`PrQueue`)

### Estados

```
awaiting_approval → pending → processing → done
                  ↘ rejected              ↘ error
```

| Estado | Significado |
|--------|-------------|
| `awaiting_approval` | PR detectado, esperando que alguien apruebe |
| `pending` | Aprobado, en cola esperando su turno |
| `processing` | Actualmente siendo procesado por el browser |
| `done` | Completado exitosamente |
| `error` | Falló durante el procesamiento |
| `rejected` | Rechazado por un usuario autorizado |

### Reglas de la cola

1. **Procesamiento secuencial** — solo un PR a la vez (una instancia de browser)
2. **No duplicados** — si un PR ya está en cola (awaiting/pending/processing), no se agrega de nuevo
3. **Persistencia** — la cola se guarda en JSON después de cada cambio de estado
4. **Recovery** — al reiniciar, PRs en `processing` vuelven a `pending`
5. **Auto-advance** — al terminar uno, automáticamente procesa el siguiente `pending`

### Persistencia

```typescript
// Solo se persisten los items activos (no done/error/rejected)
const toSave = items.filter(i => 
  i.status === "awaiting_approval" || 
  i.status === "pending" || 
  i.status === "processing"
);
```

Archivo: `data/pr_queue.json`

### Interfaz del QueueItem

```typescript
// Input (lo que se recibe al encolar)
interface QueueItemInput {
  url: string;
  repo: string;
  prNumber: string;
  chatId: number;
  requestedBy?: string;
}

// Estado completo (interno)
interface QueueItem extends QueueItemInput {
  status: QueueStatus;
  addedAt: string;
  approvedBy?: string;
  error?: string;
}
```

## Flujo completo (fullPrFlow)

```
ensureStarted()
    ↓
isLoggedIn() → login() si no hay sesión
    ↓
switchRole(Authorizer) → approvePr(url)
    ↓
switchRole(Manager) → approvePr(url)
    ↓
switchRole(MergeMaster) → mergePr(url, author)
    ↓
saveSession() → return { success: true }
```

### Cada paso reporta progreso

```typescript
result.steps.push("✅ Login en AWS");
result.steps.push("✅ Aprobado con devops/Authorizer");
result.steps.push("✅ Aprobado con devops/Manager");
result.steps.push("✅ Merge completado con MergeMaster");
```

Si falla en cualquier punto, `result.steps` muestra hasta dónde llegó.

## Procesador (callback)

El procesador se registra con `queue.setProcessor(fn)` y se ejecuta automáticamente cuando un PR pasa a `pending`. El callback:

1. Envía mensaje "⏳ Procesando PR #X" al grupo
2. Ejecuta `awsBrowser.fullPrFlow()`
3. Registra en bitácora
4. Cierra el browser
5. Envía resultado (✅ o ❌) al grupo
6. Si hay error, envía DM al owner con detalle

## Author del merge

El author del merge se determina por quién aprobó el PR en Telegram:

```typescript
const authorInfo = config.userProfiles[approver]; 
// { name: "Juan Carlos Lievano", email: "juan.lievano@..." }
```

Si el username no está en `userProfiles`, se usa el default de config (`AWS_AUTHOR_NAME` / `AWS_AUTHOR_EMAIL`).

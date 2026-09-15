# Ciclo de vida completo de un PR

> Diagrama a detalle desde que llega el mensaje con la URL hasta que el PR queda `done`, `error` o `rejected`.
> Actualiza y complementa `docs/diagrama-flujo-approve-pr.md`, que no cubre el análisis con IA (`AI_ENABLED=true`), el estado `queued` (browser ocupado) ni los eventos WebSocket emitidos para el widget.
>
> Nota: se generó con diagramas Mermaid (misma convención ya usada en `docs/diagrama-flujo-approve-pr.md`) — no se usó una skill de terceros de diagramación porque no está disponible en este entorno.

## Índice

1. [Vista general end-to-end](#1-vista-general-end-to-end)
2. [Estados de la cola (incluye `queued`)](#2-estados-de-la-cola-incluye-queued)
3. [Detalle: llegada del mensaje y encolado](#3-detalle-llegada-del-mensaje-y-encolado)
4. [Detalle: análisis con IA (opcional)](#4-detalle-análisis-con-ia-opcional)
5. [Detalle: aprobación](#5-detalle-aprobación)
6. [Detalle: `fullPrFlow` — ejecución en AWS Console](#6-detalle-fullprflow--ejecución-en-aws-console)
7. [Eventos WebSocket emitidos](#7-eventos-websocket-emitidos)

---

## 1. Vista general end-to-end

```mermaid
flowchart TD
    START(("📩 Mensaje con URL de PR<br/>llega al topic de Telegram")) --> DETECT["extractAllPrUrls()<br/>puede haber 1 o más PRs en el mismo mensaje"]

    DETECT --> DEDUP{"¿Ya está en cola<br/>(queued/awaiting_approval/<br/>pending/processing)?"}
    DEDUP -->|Sí| SKIP["ℹ️ Se ignora, se avisa<br/>'Ya en cola'"]
    DEDUP -->|No| BUSY{"¿Browser ocupado?<br/>awsBrowser.isBusy()"}

    BUSY -->|No| ENQ_AWAIT["enqueue()<br/>status = awaiting_approval"]
    BUSY -->|Sí| ENQ_QUEUED["enqueue()<br/>status = queued"]

    ENQ_AWAIT --> AI_ANALYSIS["🤖 Análisis IA (si AI_ENABLED)<br/>ver sección 4"]
    AI_ANALYSIS --> APPROVAL_MSG["🔔 Mensaje de aprobación<br/>+ botones ✅/❌"]

    ENQ_QUEUED --> WAIT_TURN["⏳ Espera a que el browser<br/>quede libre (queue.processNext)"]
    WAIT_TURN --> PROMOTE["promoteNextQueued()<br/>status: queued → awaiting_approval"]
    PROMOTE --> AI_ANALYSIS

    APPROVAL_MSG --> AUTH{"¿Usuario autorizado<br/>responde si/no?<br/>(botón o texto)"}
    AUTH -->|"no / ❌ Rechazar"| REJECTED(("🚫 status: rejected<br/>FIN"))
    AUTH -->|"si / ✅ Aprobar"| APPROVE_CALL["queue.approve()<br/>status = pending"]

    APPROVE_CALL --> PROC_CHECK{"¿Ya hay otro PR<br/>en processing?"}
    PROC_CHECK -->|Sí| WAIT_QUEUE["📋 Espera en cola<br/>(status: pending)"]
    WAIT_QUEUE --> PROCESSING
    PROC_CHECK -->|No| PROCESSING["processNext()<br/>status = processing"]

    PROCESSING --> FULLFLOW["🌐 fullPrFlow()<br/>ver sección 6<br/>login → approve×2 → merge"]

    FULLFLOW --> RESULT{"¿Resultado?"}
    RESULT -->|Éxito| DONE_ST["status = done<br/>✅ Notifica grupo"]
    RESULT -->|Error| ERROR_ST["status = error<br/>❌ Notifica grupo + DM al owner<br/>⚠️ Revisar manualmente"]

    DONE_ST --> LOG["📒 logPrResult()<br/>escribe en pr_bitacora.txt"]
    ERROR_ST --> LOG

    LOG --> CLOSE["🔒 awsBrowser.close()<br/>guarda sesión, cierra Chromium"]
    CLOSE --> NEXT{"¿Quedan PRs<br/>pending?"}
    NEXT -->|Sí| PROCESSING
    NEXT -->|No| NEXT_Q{"¿Quedan PRs<br/>queued?"}
    NEXT_Q -->|Sí| WAIT_TURN
    NEXT_Q -->|No| IDLE(("💤 Cola vacía<br/>esperando nuevos PRs"))

    style START fill:#4a9eff,color:white
    style REJECTED fill:#f8d7da,stroke:#dc3545,color:#000
    style DONE_ST fill:#d4edda,stroke:#28a745,color:#000
    style ERROR_ST fill:#f8d7da,stroke:#dc3545,color:#000
    style IDLE fill:#9e9e9e,color:white
```

---

## 2. Estados de la cola (incluye `queued`)

```mermaid
stateDiagram-v2
    [*] --> queued: Browser ocupado al llegar el PR
    [*] --> awaiting_approval: Browser libre al llegar el PR

    queued --> awaiting_approval: promoteNextQueued()<br/>(browser quedó libre)

    awaiting_approval --> pending: Usuario autorizado aprueba
    awaiting_approval --> rejected: Usuario autorizado rechaza

    pending --> processing: processNext()<br/>(no hay otro PR corriendo)

    processing --> done: fullPrFlow() exitoso
    processing --> error: fullPrFlow() falla

    done --> [*]
    error --> [*]
    rejected --> [*]

    note right of queued
        Nuevo estado (no documentado
        antes en docs/diagrama-flujo-approve-pr.md).
        El browser solo soporta 1 tarea
        a la vez (merge O scraping IA),
        así que un PR que llega mientras
        el browser está ocupado espera
        aquí su turno para el análisis IA.
    end note

    note right of awaiting_approval
        Bot ya mostró el mensaje
        de aprobación (con o sin
        resumen IA) y espera
        respuesta humana.
    end note

    note right of processing
        Solo 1 PR a la vez.
        awsBrowser.isBusy() = true
        durante todo fullPrFlow().
    end note
```

---

## 3. Detalle: llegada del mensaje y encolado

```mermaid
sequenceDiagram
    actor User as 👤 Cualquier usuario del grupo
    participant TG as 🤖 handlers.ts
    participant Parser as 🔗 url-parser.ts
    participant Queue as 📋 PrQueue

    User->>TG: Mensaje de texto en el topic correcto
    TG->>TG: chatType !== "private"?<br/>message_thread_id === TOPIC_ID?
    Note over TG: Si no cumple, se ignora el mensaje

    TG->>Parser: extractAllPrUrls(text)
    Parser-->>TG: string[] (0, 1 o varias URLs)

    alt Sin URLs válidas
        TG->>TG: (no hace nada más con este handler)
    else 1+ URLs detectadas
        loop Por cada URL
            TG->>Parser: parsePrInfo(url)
            Parser-->>TG: PrInfo { repo, prNumber, url normalizada a /details }
        end

        TG->>TG: isBusy = awsBrowser.isBusy()

        loop Por cada PrInfo parseado
            TG->>Queue: enqueue({url, repo, prNumber, chatId, requestedBy}, isBusy)
            alt Ya existe en cola (mismo url + status activo)
                Queue-->>TG: false → se agrega a "duplicates"
            else No existe
                Queue-->>TG: true
                Note over TG: isBusy=true → status "queued"<br/>isBusy=false → status "awaiting_approval"
            end
        end

        par Por cada PR agregado como awaiting_approval
            TG->>TG: sendApprovalWithAnalysis() (fire-and-forget, sin await)
            Note over TG: No se hace await para no bloquear<br/>el handler — si se bloqueara, el listener<br/>de MFA por DM nunca respondería (deadlock)
        end

        opt Hay PRs que quedaron "queued"
            TG->>User: 📋 "PR(s) detectado(s) y encolado(s)... se analizarán cuando termine"
        end
        opt Hay duplicados
            TG->>User: ℹ️ "Ya en cola: PR #N, ..."
        end
    end
```

---

## 4. Detalle: análisis con IA (opcional)

Aplica tanto para PRs que entran directo (`awaiting_approval` inmediato) como para los que estaban `queued` y acaban de promoverse — la lógica es la misma en `handlers.ts::sendApprovalWithAnalysis` y `bot/pre-merge-analysis.ts::analyzeAndRequestApproval` (código duplicado, ver `plan-correcciones.md` ítem 3).

```mermaid
sequenceDiagram
    participant TG as 🤖 Bot
    participant WS as 📡 prEmitter (WS)
    participant Browser as 🖥️ AWSBrowser
    participant AWS as ☁️ AWS Console
    participant Scraper as 📄 diff-scraper.ts
    participant Ollama as 🧠 Ollama (LLM local)

    alt AI_ENABLED=false o sin awsBrowser
        TG->>TG: sendApprovalRequest() — mensaje estándar directo
    else AI_ENABLED=true
        TG->>TG: sendMessage "⏳ Obteniendo resumen IA..."
        TG->>WS: aiStep(ai_login, in_progress)

        TG->>Browser: setBusy(true)
        Note over Browser: 🔒 Bloquea el browser para que<br/>otro merge no pise este scraping

        TG->>Browser: ensureStarted()
        Browser->>Browser: start() si no había browser abierto

        TG->>AWS: isLoggedIn()?
        alt Sesión activa
            AWS-->>TG: ✅ sesión válida
        else Sesión expirada/ausente
            TG->>AWS: login() — usuario + password
            opt AWS pide MFA
                TG->>TG: onMfaRequired() → DM al owner,<br/>espera código 6 dígitos (máx 90s)
            end
            TG->>Browser: saveSession()
        end
        TG->>WS: aiStep(ai_login, done)

        TG->>WS: aiStep(ai_scraping, in_progress)
        TG->>Scraper: scrapeDiff(page, prUrl)
        Scraper->>AWS: navega a tab "Changes"
        Scraper->>Scraper: extractFileNames() + extractDiffContent()<br/>(scraping DOM con múltiples estrategias fallback)
        Scraper->>Scraper: truncateByFile() si excede 8000 chars
        Scraper-->>TG: DiffResult { content, filesChanged, truncated }
        TG->>WS: aiStep(ai_scraping, done)

        alt Diff con contenido
            TG->>WS: aiStep(ai_analyzing, in_progress)
            TG->>Ollama: callOllama(prompt) — POST /api/generate
            Ollama-->>TG: respuesta cruda (texto, se espera JSON)
            TG->>TG: parseLLMResponse() — tolerante a fallos,<br/>nunca lanza excepción
            TG->>WS: aiStep(ai_analyzing, done)
        else Diff vacío
            Note over TG: Se omite la llamada a Ollama,<br/>solo se listan archivos
        end

        TG->>Browser: setBusy(false)
        Note over Browser: 🔓 Libera el browser

        TG->>TG: deleteMessage(mensaje temporal ⏳)
        TG->>WS: aiResult(success, summary, filesChanged)

        opt Hubo resumen IA
            TG->>TG: queue.setAiSummary(prNumber, summary)<br/>(se guarda para la bitácora final)
        end

        alt Hay analysis completo
            TG->>TG: formatEnrichedMessage() — resumen + cambios + riesgos
        else Solo hay archivos (Ollama falló o diff vacío)
            TG->>TG: formatFilesOnlyMessage() — lista de hasta 15 archivos
        else Todo falló (login/scraping fallaron)
            TG->>TG: formatStandardMessage() — mensaje genérico
        end

        TG->>TG: sendMessage(texto + botones ✅/❌)
        opt Falla el envío con Markdown
            TG->>TG: reintenta sin Markdown
            opt Falla también sin Markdown
                TG->>TG: sendApprovalRequest() — último fallback
            end
        end
    end
```

**Fallbacks del análisis IA** (nunca bloquea la aprobación — siempre termina en un mensaje con botones):

| Situación | Resultado mostrado al usuario |
|---|---|
| `AI_ENABLED=false` | Mensaje estándar |
| Login a AWS falla | Mensaje estándar |
| Diff vacío tras el scraping | Solo lista de archivos modificados |
| Ollama timeout / error / respuesta inválida | Solo lista de archivos modificados |
| Todo falla | Mensaje estándar |

---

## 5. Detalle: aprobación

```mermaid
flowchart TD
    MSG["Botón ✅/❌ o texto<br/>'si' / 'si #N' / 'no' / 'no #N'"] --> WHO{"¿Usuario en<br/>TELEGRAM_AUTHORIZED_USERS?"}

    WHO -->|No| DENY["⛔ 'No estás autorizado'"]
    WHO -->|Sí| WHICH{"¿Se especificó<br/>#NUMERO?"}

    WHICH -->|Sí| FIND["Buscar en awaitingApproval<br/>por prNumber"]
    WHICH -->|No| COUNT{"¿Cuántos PRs<br/>awaiting_approval?"}

    COUNT -->|0| NOOP["No hace nada<br/>(nada que aprobar)"]
    COUNT -->|1| AUTO["Aplica al único<br/>PR esperando"]
    COUNT -->|"2+"| ASK["⚠️ 'Hay N PRs pendientes,<br/>especifica: si #NUMERO'"]

    FIND --> ACTION
    AUTO --> ACTION

    ACTION{"¿Aprobar<br/>o rechazar?"}
    ACTION -->|Aprobar| DO_APPROVE["queue.approve(prNumber, username)<br/>⚠️ ver plan-correcciones.md #1:<br/>NO valida repo, solo prNumber"]
    ACTION -->|Rechazar| DO_REJECT["queue.reject(prNumber, username)<br/>status → rejected"]

    DO_APPROVE --> TRIGGER["Dispara queue.processNext()<br/>si no hay nada procesando"]

    style DENY fill:#f8d7da,stroke:#dc3545,color:#000
    style DO_APPROVE fill:#fff4dd,stroke:#d4a017,color:#000
    style DO_REJECT fill:#f8d7da,stroke:#dc3545,color:#000
    style ASK fill:#cce5ff,stroke:#007bff,color:#000
```

---

## 6. Detalle: `fullPrFlow` — ejecución en AWS Console

Este es el flujo que corre `AWSBrowser.fullPrFlow()` una vez que el PR pasó a `processing`. Cada paso emite un evento WS (`step`) con `in_progress` → `done`/`error`, y cualquier fallo corta el flujo inmediatamente (no continúa a los pasos siguientes).

```mermaid
sequenceDiagram
    participant Q as 📋 Queue
    participant B as 🖥️ AWSBrowser
    participant AWS as ☁️ AWS Console
    participant Debug as 🐛 PrDebugger

    Q->>B: fullPrFlow(prUrl, author, prNumber)
    B->>Debug: new PrDebugger(prNumber)<br/>crea data/pull-requests/{N}/

    rect rgb(220, 235, 255)
        Note over B,AWS: 1. Login
        B->>AWS: isLoggedIn()?
        alt No hay sesión
            B->>AWS: login() (+ MFA si aplica, ver sección 4)
            B->>B: saveSession()
        end
        Note over B: ❌ Si falla → screenshot "login_failed" + abort
    end

    rect rgb(220, 245, 220)
        Note over B,AWS: 2. Authorizer
        B->>AWS: switchRole(ROLE_AUTHORIZER_URL)
        Note over B: ❌ Si falla → screenshot "switch_authorizer_failed" + abort
        B->>AWS: approvePr(prUrl) — navega al PR,<br/>waitForButton("Approve") con polling,<br/>fallback a locators de Playwright
        Note over B: ❌ Si falla → screenshot "approve_authorizer_failed" + abort
    end

    rect rgb(220, 230, 250)
        Note over B,AWS: 3. Manager
        B->>AWS: switchRole(ROLE_MANAGER_URL)
        B->>AWS: approvePr(prUrl) — mismo mecanismo
        Note over B: ❌ Si falla en cualquier punto → abort
    end

    rect rgb(250, 235, 215)
        Note over B,AWS: 4. MergeMaster
        B->>AWS: switchRole(ROLE_MERGE_URL)
        B->>Debug: screenshot "before_merge"
        B->>AWS: mergePr(prUrl, author, debug):<br/>1. Click "Merge"<br/>2. Espera formulario (waitForMergeForm)<br/>3. Selecciona 3-way merge<br/>4. Llena Author name + Email<br/>5. Desmarca "Delete source branch"<br/>6. Click "Merge pull request"
        Note over B,AWS: ⚠️ ver plan-correcciones.md #2:<br/>no verifica que el merge se haya<br/>completado sin conflictos, solo<br/>que el click + carga de página ocurrieron
        Note over B: ❌ Si algún selector no aparece → screenshot + saveHtml + abort
    end

    rect rgb(230, 230, 230)
        Note over B: 5. Guardar sesión final
        B->>B: saveSession()
    end

    B-->>Q: PrFlowResult { success, steps[], error? }
    Q->>Debug: (ya se registró en data/pull-requests/{N}/debug.log)
```

**Notas del flujo:**
- Todo el flujo corre en la **misma página de Playwright** reutilizada entre pasos — no se abre una pestaña nueva por rol.
- Cada `switchRole()` navega a una URL de "switch role" propia por rol (`ROLE_AUTHORIZER_URL`, `ROLE_MANAGER_URL`, `ROLE_MERGE_URL`), configuradas en `.env`.
- `approvePr()` se llama dos veces con roles distintos — CodeCommit exige dos aprobaciones de roles diferentes antes de habilitar el merge.
- Cualquier excepción no capturada en el flujo cae en el `catch` general de `fullPrFlow`, que también intenta un screenshot de emergencia (`unexpected_error`) antes de reportar el fallo.

---

## 7. Eventos WebSocket emitidos

`prEmitter` (singleton en `src/ws/pr-emitter.ts`) retransmite todo esto a los clientes conectados en el puerto `WS_PORT` (default 9876) — hoy pensado para un widget de escritorio (roadmap, aún no construido).

```mermaid
flowchart LR
    subgraph Cola["Eventos de cola"]
        Q1["queue<br/>current + pending[]"]
    end

    subgraph IA["Eventos de análisis IA (AiStep)"]
        A1["ai_step: ai_login"]
        A2["ai_step: ai_scraping"]
        A3["ai_step: ai_analyzing"]
        A4["ai_result: success + summary + filesChanged"]
        A1 --> A2 --> A3 --> A4
    end

    subgraph Flujo["Eventos del flujo AWS (PrStep)"]
        S1["step: login"]
        S2["step: switch_authorizer"]
        S3["step: approve_authorizer"]
        S4["step: switch_manager"]
        S5["step: approve_manager"]
        S6["step: switch_merge"]
        S7["step: merge"]
        S8["step: save_session"]
        S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7 --> S8
    end

    subgraph Estado["Eventos de estado general"]
        ST1["status: processing"]
        ST2["status: completed"]
        ST3["status: error"]
    end

    ST1 -.-> Flujo
    Flujo -.-> ST2
    Flujo -.-> ST3
```

Cada `step`/`ai_step` lleva `status: "pending" | "in_progress" | "done" | "error"`. Al conectarse, un cliente nuevo recibe un evento `init` con el snapshot completo (estado actual, PR en curso, cola pendiente y todos los pasos con su estado) para poder reconstruir la UI sin haber visto los eventos anteriores.

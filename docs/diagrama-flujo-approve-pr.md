# Diagrama de Flujo — reclutalia-aws-pr-bot

## Arquitectura General

```mermaid
graph TB
    subgraph Telegram["☁️ Telegram"]
        TG_GROUP["👥 Grupo/Supergrupo<br/>(Topic: Pull Requests)"]
        TG_OWNER["👤 Owner (DM)"]
    end

    subgraph Bot["🤖 Bot de Telegram (Telegraf)"]
        LISTENER["📡 Listener de mensajes<br/>Filtra por topic y tipo de chat"]
        COMMANDS["⌨️ Comandos<br/>/status /queue /log /pr"]
        URL_PARSER["🔗 URL Parser<br/>extractAllPrUrls()"]
        APPROVAL["🔔 Capa de Aprobación<br/>si/no + #NUMERO"]
    end

    subgraph Queue["📋 Sistema de Cola"]
        PR_QUEUE["PrQueue<br/>(pr_queue.json)"]
        PROCESSOR["⚙️ Procesador secuencial<br/>1 PR a la vez"]
    end

    subgraph AWS["🌐 AWS Browser (Playwright)"]
        BROWSER["🖥️ Browser Chromium<br/>Lazy start / Auto close"]
        SESSION["💾 Sesión<br/>(aws_session.json)"]
        LOGIN["🔐 Login Flow"]
        ROLES["🎭 Switch de Roles"]
        APPROVE["✅ Approve PR"]
        MERGE["🔀 Merge PR"]
    end

    subgraph Files["📁 Archivos de Persistencia"]
        F_QUEUE["pr_queue.json"]
        F_SESSION["aws_session.json"]
        F_LOG["pr_bitacora.txt"]
    end

    TG_GROUP -->|"Mensaje con URL(s)<br/>de CodeCommit"| LISTENER
    LISTENER --> URL_PARSER
    URL_PARSER -->|"1 o más PRs"| PR_QUEUE
    PR_QUEUE -->|"awaiting_approval"| APPROVAL
    APPROVAL -->|"Usuario autorizado<br/>dice 'si'"| PROCESSOR
    COMMANDS -->|"/pr URL"| PR_QUEUE
    PROCESSOR --> BROWSER
    BROWSER --> SESSION
    BROWSER --> LOGIN
    LOGIN --> ROLES
    ROLES --> APPROVE
    APPROVE --> MERGE
    MERGE -->|"Resultado"| TG_GROUP
    MERGE -->|"Notificación"| TG_OWNER
    PROCESSOR -->|"Registra resultado"| F_LOG
    PR_QUEUE -.->|"Persiste cola"| F_QUEUE
    SESSION -.->|"Guarda/Carga"| F_SESSION
```

## Flujo Completo de un PR (con aprobación)

```mermaid
sequenceDiagram
    actor User as 👤 Usuario Telegram
    actor Auth as 👤 Usuario Autorizado
    participant TG as 🤖 Bot Telegram
    participant Parser as 🔗 URL Parser
    participant Queue as 📋 Cola
    participant Browser as 🖥️ Playwright
    participant AWS as ☁️ AWS Console
    participant Log as 📒 Bitácora

    User->>TG: Envía mensaje con URL(s) de PR
    TG->>TG: Filtra: solo grupo, solo topic correcto
    TG->>Parser: Extrae URLs de CodeCommit
    Parser-->>TG: Lista de PrInfo[]

    loop Por cada PR detectado
        TG->>Queue: enqueue(PR) → awaiting_approval
        TG->>User: 🔔 Solicitud de aprobación<br/>¿Aprobar PR #N?<br/>Responde si #N o no #N
    end

    Note over TG,Auth: ⏳ Esperando respuesta de usuario autorizado

    alt Usuario dice "si #29426"
        Auth->>TG: si #29426
        TG->>TG: Valida username en AUTHORIZED_USERS
        TG->>Queue: approve("29426") → pending
        TG->>User: ✅ PR #29426 aprobado por @usuario
    else Usuario dice "no #29426"
        Auth->>TG: no #29426
        TG->>Queue: reject("29426") → rejected
        TG->>User: 🚫 PR #29426 rechazado por @usuario
    else Solo 1 PR esperando, dice "si"
        Auth->>TG: si
        TG->>Queue: approve(único PR) → pending
    else Múltiples PRs, dice "si" sin número
        Auth->>TG: si
        TG->>User: ⚠️ Especifica cuál: si #NUMERO
    end

    Note over Queue: PR aprobado → procesamiento secuencial

    Queue->>TG: Notifica inicio
    TG->>User: ▶️ Procesando PR #N...

    Queue->>Browser: ensureStarted()
    Browser->>Browser: Abre Chromium + carga sesión

    Browser->>AWS: Navega a console.aws.amazon.com
    alt Sesión válida
        AWS-->>Browser: ✅ Logueado
    else Sesión expirada
        AWS-->>Browser: Redirect a signin
        Browser->>AWS: Llena usuario + contraseña + submit
        Note over Browser,AWS: ⏳ Espera MFA manual (30s)
        Browser->>AWS: Skip "Handle expiring password"
        Browser->>AWS: Acepta cookies
        Browser->>Browser: Guarda sesión
    end

    rect rgb(200, 230, 200)
        Note over Browser,AWS: Paso 1: Aprobación con Authorizer
        Browser->>AWS: Switch Role → devops/Authorizer
        Browser->>AWS: Navega al PR + waitForButton("Approve")
        Browser->>AWS: Click Approve ✅
    end

    rect rgb(200, 220, 240)
        Note over Browser,AWS: Paso 2: Aprobación con Manager
        Browser->>AWS: Switch Role → devops/Manager
        Browser->>AWS: Navega al PR + waitForButton("Approve")
        Browser->>AWS: Click Approve ✅
    end

    rect rgb(240, 220, 200)
        Note over Browser,AWS: Paso 3: Merge con MergeMaster
        Browser->>AWS: Switch Role → MergeMaster
        Browser->>AWS: Navega al PR + waitForButton("Merge")
        Browser->>AWS: Selecciona 3-way merge
        Browser->>AWS: Llena Author + Email
        Browser->>AWS: Desmarca "Delete source branch"
        Browser->>AWS: Click "Merge pull request" ✅
    end

    Browser->>Browser: Guarda sesión + cierra browser
    Queue->>Log: Registra en bitácora

    alt PR exitoso
        TG->>User: ✅ PR procesado exitosamente
        TG-->>Auth: ✅ DM al owner
    else PR con error
        TG->>User: ❌ Error, revisa manualmente
    end

    alt Hay más PRs aprobados en cola
        TG->>User: 📋 N PR(s) restantes...
        Note over Queue: Procesa el siguiente
    else Hay PRs esperando aprobación
        TG->>User: 🔔 N PR(s) esperando aprobación
    else Cola vacía
        Note over Queue: 📭 Esperando nuevos PRs
    end
```

## Flujo de Aprobación (detalle)

```mermaid
flowchart TD
    MSG["📩 Mensaje en topic"] --> HAS_URL{"¿Contiene URL(s)<br/>de CodeCommit?"}

    HAS_URL -->|Sí| PARSE["🔗 Extraer todas las URLs"]
    PARSE --> ENQUEUE["📋 Encolar cada PR<br/>status: awaiting_approval"]
    ENQUEUE --> ASK["🔔 Pedir aprobación<br/>por cada PR en el chat"]

    HAS_URL -->|No| IS_RESPONSE{"¿Es respuesta<br/>de aprobación?<br/>si/no/autorizar/denegar"}

    IS_RESPONSE -->|No| IGNORE["🔇 Ignorar"]
    IS_RESPONSE -->|Sí| IS_AUTH{"¿Usuario<br/>autorizado?"}

    IS_AUTH -->|No| DENY["⛔ No autorizado"]
    IS_AUTH -->|Sí| HAS_AWAITING{"¿Hay PRs esperando<br/>aprobación?"}

    HAS_AWAITING -->|No| NO_PR["ℹ️ No hay PRs pendientes"]
    HAS_AWAITING -->|Sí| HAS_NUMBER{"¿Especificó<br/>#NUMERO?"}

    HAS_NUMBER -->|Sí| FIND_PR["Buscar PR por número"]
    HAS_NUMBER -->|No| HOW_MANY{"¿Cuántos PRs<br/>esperando?"}

    HOW_MANY -->|1| AUTO_SELECT["Aplica al único PR"]
    HOW_MANY -->|Más de 1| ASK_WHICH["⚠️ Especifica cuál:<br/>si #NUMERO"]

    FIND_PR --> DECISION
    AUTO_SELECT --> DECISION

    DECISION{"¿Aprobó o rechazó?"}
    DECISION -->|si/autorizar| APPROVE["✅ approve()<br/>status → pending<br/>Inicia procesamiento"]
    DECISION -->|no/denegar| REJECT["🚫 reject()<br/>status → rejected"]

    style APPROVE fill:#d4edda,stroke:#28a745,color:#000
    style REJECT fill:#f8d7da,stroke:#dc3545,color:#000
    style DENY fill:#f8d7da,stroke:#dc3545,color:#000
    style ASK fill:#cce5ff,stroke:#007bff,color:#000
```

## Sistema de Cola (estados)

```mermaid
stateDiagram-v2
    [*] --> awaiting_approval: Llega URL de PR
    awaiting_approval --> pending: Usuario autorizado dice "si"
    awaiting_approval --> rejected: Usuario autorizado dice "no"
    pending --> processing: processNext()
    processing --> done: Éxito
    processing --> error: Fallo
    done --> [*]
    error --> [*]
    rejected --> [*]

    note right of awaiting_approval
        Bot pide aprobación en el chat.
        Respuestas válidas:
        si, sí, autorizar
        no, denegar
        + opcionalmente #NUMERO
    end note

    note right of processing
        Solo 1 PR a la vez.
        Browser se abre al iniciar
        y se cierra al terminar.
    end note
```

## Ciclo de Vida del Browser

```mermaid
flowchart LR
    A["✅ PR aprobado"] --> B["ensureStarted()"]
    B --> C{"¿Browser<br/>abierto?"}
    C -->|No| D["start()<br/>Abre Chromium<br/>Carga sesión"]
    C -->|Sí| E["Continúa"]
    D --> E
    E --> F["fullPrFlow()"]
    F --> G["close()<br/>Guarda sesión<br/>Cierra Chromium"]
    G --> H{"¿Más PRs<br/>aprobados?"}
    H -->|Sí| A
    H -->|No| I["💤 Espera"]

    style A fill:#4caf50,color:white
    style G fill:#f44336,color:white
    style I fill:#9e9e9e,color:white
```

## Navegación Robusta

```mermaid
flowchart TD
    A["navigateAndWait(url)"] --> B["goto(url, domcontentloaded)"]
    B --> C["waitForAwsLoaders()"]
    C --> D{"¿Hay spinners<br/>visibles?"}
    D -->|Sí| E["Espera 500ms"] --> D
    D -->|No| F["waitForDomStable()"]
    F --> G{"¿DOM sin<br/>mutaciones<br/>por 1s?"}
    G -->|No| H["Espera..."] --> G
    G -->|Sí| I["dismissPopups()"]
    I --> J["✅ Página lista"]

    style A fill:#4a9eff,color:white
    style J fill:#4caf50,color:white
```

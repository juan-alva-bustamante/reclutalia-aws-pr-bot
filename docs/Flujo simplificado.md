## Contexto/Funcionalidad

Este repositorio detalla el funcionamiento de un bot de Telegram diseñado para gestionar de forma automatizada la revisión y fusión de cambios en AWS CodeCommit. 

La herramienta opera mediante un sistema de cola de mensajes donde usuarios autorizados validan las solicitudes antes de que un navegador automatizado ejecute las acciones en la nube. 

Al recibir una orden, el software utiliza Playwright para simular la navegación humana, realizando los cambios de roles necesarios y completando el merge de código de manera secuencial. 

El sistema garantiza la seguridad y persistencia de los datos mediante el almacenamiento de sesiones, registros históricos y una configuración rigurosa de variables de entorno. 

Además, incluye mecanismos de notificación personalizada para informar a los desarrolladores sobre el estado final de sus integraciones tecnológicas. Su arquitectura permite manejar múltiples solicitudes simultáneas, organizándolas a través de diversos estados de procesamiento para evitar conflictos en el entorno de desarrollo.


## Diagrama de flujo

```mermaid
---
config:
  layout: elk
---
graph TD
    %% Estilos
    classDef startEnd fill:#f9f,stroke:#333,stroke-width:2px;
    classDef process fill:#fff,stroke:#333,stroke-width:1px;
    classDef decision fill:#fff4dd,stroke:#d4a017,stroke-width:1px;
    classDef aws fill:#e1f5fe,stroke:#01579b,stroke-width:1px;

    %% Fase 1: Entrada
    Start((📩 Mensaje con URL)) --> Detect[<b>Bot detecta PR</b><br/>Filtra por Grupo/Topic]
    Detect --> Queue[<b>Encolado</b><br/>Estado: awaiting_approval]

    %% Fase 2: Aprobación
    Queue --> Ask[🔔 Bot solicita aprobación en chat]
    Ask --> Auth{¿Usuario autorizado?}
    
    Auth -- No --> Ignore[Ignorar / Denegar]
    Auth -- Sí --> Decision{¿Responde 'si' o 'no'?}
    
    Decision -- "no" --> Rejected([🚫 PR Rechazado])
    Decision -- "si" --> Pending[<b>Estado: pending</b><br/>Listo para procesar]

    %% Fase 3: Ejecución (AWS)
    Pending --> Browser[🚀 Inicia Playwright<br/>Carga sesión de AWS]
    
    subgraph AWS_Automation [Proceso en AWS CodeCommit]
        direction TB
        Role1[🎭 Switch Role: <b>Authorizer</b><br/>Click Approve] --> Role2[🎭 Switch Role: <b>Manager</b><br/>Click Approve]
        Role2 --> Role3[🎭 Switch Role: <b>MergeMaster</b><br/>Ejecuta 3-way Merge]
    end

    Browser --> AWS_Automation
    
    %% Fase 4: Finalización
    AWS_Automation --> Result{¿Éxito?}
    
    Result -- Sí --> Done[✅ <b>Estado: done</b><br/>Notifica a Grupo y Owner]
    Result -- No --> Error[❌ <b>Estado: error</b><br/>Notifica fallo para revisión manual]

    Done --> End((🏁 Fin))
    Error --> End
    Rejected --> End

    %% Clases aplicadas
    class Start,End startEnd;
    class Decision,Auth,Result decision;
    class AWS_Automation aws;
```
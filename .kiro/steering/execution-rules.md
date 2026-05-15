---
inclusion: always
---

# Reglas de Ejecución

## Comandos de shell

- NO ejecutes comandos de build, test, lint ni install automáticamente.
- Después de hacer cambios, lista los comandos que el usuario debe correr para validar.
- Solo ejecuta comandos de shell si el usuario lo pide explícitamente en su mensaje.
- Para verificar errores de tipos, usa la herramienta `getDiagnostics` en lugar de ejecutar `tsc`.

## Lectura de archivos

- NO leas archivos en `node_modules/`, `dist/`, ni `.git/`.
- Si necesitas saber qué dependencias hay, lee `package.json` directamente.
- Si ya tienes contexto de la arquitectura por este steering, no releas archivos que ya conoces.
- Prioriza leer solo los archivos directamente relevantes a la tarea.

## Eficiencia

- Haz los cambios en la menor cantidad de pasos posible.
- Si un cambio afecta múltiples archivos, hazlos en paralelo cuando sean independientes.
- No explores el proyecto completo para tareas puntuales. Usa el steering de arquitectura como referencia.
- Si el usuario da contexto suficiente (archivo, línea, error), actúa directamente sin explorar.

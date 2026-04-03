# reclutalia-aws-pr-bot

Bot de Telegram que automatiza la aprobación y merge de PRs en AWS CodeCommit.

## Flujo

1. Detecta URLs de CodeCommit en canales/grupos de Telegram
2. Login automático en AWS (con MFA manual en el browser)
3. Switch de roles: Authorizer → Manager → MergeMaster
4. Aprueba el PR con cada rol y hace merge con 3-way merge

## Setup

```bash
npm install
cp .env.example .env
# Editar .env con tus credenciales
```

## Uso

```bash
# Desarrollo
npm run dev

# Producción
npm run build
npm start
```

## Comandos del bot

- `/status` — Ver estado del bot
- `/pr <url>` — Procesar PR manualmente (solo owner)

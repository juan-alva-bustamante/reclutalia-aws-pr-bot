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

## Despliegue con PM2

```bash
# Compilar y levantar
npm run build && pm2 start dist/main.js --name reclutalia-pr-auto-approver

# Reiniciar después de cambios
npm run build && pm2 restart reclutalia-pr-auto-approver
```

## Comandos del bot

- `/status` — Ver estado del bot
- `/pr <url>` — Procesar PR manualmente (solo owner)

### Ejecutar bot

PM2 (recomendado para desarrollo/producción en servidores Linux)

```bash
npm install -g pm2

PM2_HOME=~/.pm2

# iniciar con nombre y variables de entorno (ejemplo)
pm2 start dist/main.js --name reclutalia-pr-authorizer-bot --log-date-format "YYYY-MM-DD HH:mm:ss"

# Guardar la lista de procesos para arranque en boot:
pm2 save
pm2 startup   # te dará un comando para ejecutarlo como root para habilitarlo en system boot

# Ver logs / seguirlos:
pm2 logs reclutalia-pr-authorizer-bot         # ver logs en tiempo real
pm2 logs --lines 200                # ver últimas 200 líneas
pm2 monit                            # dashboard de métricas

# Parar instancia
pm2 stop 0
pm2 stop reclutalia-pr-authorizer-bot

# Reiniciar instancia
pm2 start 0
pm2 start reclutalia-pr-authorizer-bot
```

### Buscar e integrar versiones exactas

PM2 (recomendado para desarrollo/producción en servidores Linux)

```bash
# revisar versiones exactas instaladas en node_modules para fijarlas
node -e "const deps = ['dotenv','playwright','telegraf','winston','@types/node','tsx','typescript']; deps.forEach(d => { try { const p = require(d + '/package.json'); console.log(d + ': ' + p.version); } catch(e) { console.log(d + ': NOT FOUND'); } })"


node -e "const p = require('./node_modules/telegraf/package.json'); console.log(p.version);"

```

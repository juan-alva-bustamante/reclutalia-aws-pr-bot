# PR Automation Bot

End-to-end Pull Request approval and merge automation for AWS CodeCommit, orchestrated through Telegram. Reduces a 4-step manual process (login → switch role → approve × 2 → merge) to a single button click.

---

## Problem

Our team manages 30+ microservices in AWS CodeCommit. Each PR requires:
1. Login to AWS Console
2. Switch to `devops/Authorizer` role → Approve
3. Switch to `devops/Manager` role → Approve
4. Switch to `MergeMaster` role → Execute merge

This takes ~5 minutes per PR, repeated 10-15 times daily. The friction slows down deployments and creates bottlenecks when the TL is unavailable.

**This bot automates the entire flow** — a developer posts the PR URL in Telegram, an authorized user approves with one tap, and the bot handles the rest in ~90 seconds.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Telegram Group                                                  │
│  └─ Developer posts PR URL → Bot sends approval request         │
│  └─ Authorized user taps ✅ → Bot processes PR                  │
└──────────────────────────────────┬──────────────────────────────┘
                                   │ Telegraf (Bot API)
┌──────────────────────────────────▼──────────────────────────────┐
│  Node.js Process                                                 │
│  ├─ Queue (sequential, persistent)                               │
│  ├─ WebSocket server (real-time status for monitoring widget)    │
│  └─ Playwright browser automation ──┐                           │
└──────────────────────────────────────┼──────────────────────────┘
                                       │ Headless Chromium
┌──────────────────────────────────────▼──────────────────────────┐
│  AWS Console (CodeCommit)                                        │
│  ├─ Switch Role: devops/Authorizer → Approve                    │
│  ├─ Switch Role: devops/Manager → Approve                       │
│  └─ Switch Role: MergeMaster → 3-way Merge                     │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Browser automation over API**: CodeCommit's approval system isn't fully exposed via AWS SDK. Using Playwright gives us complete control over the console workflow, including role switching and MFA handling.
- **Sequential queue**: Only one browser instance runs at a time. PRs are queued and processed in order to avoid session conflicts.
- **Session persistence**: AWS session cookies are saved to disk, avoiding re-login and MFA on every PR (sessions last ~12 hours).
- **Retry with backoff**: AWS Console occasionally interrupts navigation during role switches. The bot retries automatically (2 attempts with exponential backoff).
- **Real-time WebSocket**: A local WS server emits step-by-step progress events for an optional desktop monitoring widget.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Runtime | Node.js + TypeScript (strict) | Type-safe automation |
| Browser | Playwright (Chromium) | AWS Console interaction |
| Bot | Telegraf | Telegram Bot API |
| Queue | Custom (JSON persistence) | Sequential PR processing |
| Real-time | ws (WebSocket) | Live progress events |
| Logging | Winston | Structured, timestamped logs |
| Process | PM2 | Production daemon management |

---

## Project Structure

```
src/
├── aws/
│   ├── browser.ts       # Lifecycle + fullPrFlow orchestration
│   ├── auth.ts          # Login, MFA, role switching
│   ├── pr-actions.ts    # Approve, merge, form interactions
│   ├── navigation.ts    # navigateAndWait with retry, DOM stability
│   └── popups.ts        # Auto-dismiss AWS modals/cookies
├── bot/
│   ├── telegram-bot.ts  # Bot creation + queue processor wiring
│   ├── commands.ts      # /status, /queue, /log, /pr
│   ├── handlers.ts      # Inline buttons + text approval
│   ├── helpers.ts       # sendToTopic, authorization
│   └── mfa-handler.ts   # MFA request/response via DM
├── queue/
│   └── pr-queue.ts      # Persistent sequential queue
├── ws/
│   ├── events.ts        # Event type definitions
│   ├── pr-emitter.ts    # Singleton event emitter
│   └── ws-server.ts     # WebSocket server (port 9876)
├── history/
│   ├── pr-debug.ts      # Per-PR screenshots + debug logs
│   └── pr-log.ts        # Historical result log
├── utils/
│   ├── url-parser.ts    # CodeCommit URL detection + normalization
│   └── selectors.ts     # Generic selector helper
├── types/               # Shared type definitions
├── config.ts            # Environment-based configuration
├── logger.ts            # Winston setup
└── main.ts              # Entry point
```

---

## Setup

```bash
# Clone
git clone <repo-url>
cd reclutalia-aws-pr-bot

# Install (also installs Chromium via Playwright)
npm install

# Configure
cp .env.example .env
# Edit .env with your credentials
```

### Environment Variables

```bash
# Telegram
TELEGRAM_BOT_TOKEN=         # From @BotFather
TELEGRAM_CHAT_ID=           # Group ID (negative number)
TELEGRAM_OWNER_USER_ID=     # Your numeric Telegram ID (receives MFA + alerts)
TELEGRAM_TOPIC_ID=          # Optional: topic thread ID
TELEGRAM_AUTHORIZED_USERS=  # Usernames allowed to approve (comma-separated, no @)

# User profiles for merge author attribution
USER_PROFILES=user1:Full Name:email@co.com,user2:Name:email@co.com

# AWS
AWS_LOGIN_URL=              # Your AWS Console login URL
AWS_ACCOUNT_ID=             # Account alias
AWS_USERNAME=               # IAM username
AWS_PASSWORD=               # IAM password
AWS_AUTHOR_NAME=            # Default merge author name
AWS_AUTHOR_EMAIL=           # Default merge author email
HEADLESS=true               # true = invisible browser

# Role switch URLs (required)
ROLE_AUTHORIZER_URL=        # Switch role URL for Authorizer
ROLE_MANAGER_URL=           # Switch role URL for Manager
ROLE_MERGE_URL=             # Switch role URL for MergeMaster
```

---

## Usage

### Run

```bash
npm run start          # Build + run
npm run dev            # Build + run with tsx
npm run validate       # Type-check without emitting
```

### Production (PM2)

```bash
npm run build
pm2 start dist/main.js --name pr-bot
pm2 startup && pm2 save   # Auto-start on reboot
```

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Bot health + queue summary |
| `/queue` | Current queue state |
| `/log` | Last 5 processed PRs |
| `/pr <url>` | Manually enqueue a PR |

### Approve Flow

1. Post a CodeCommit PR URL in the group
2. Bot sends inline buttons (✅ Approve / ❌ Reject)
3. Authorized user taps ✅
4. Bot processes: login → approve (×2 roles) → merge → report result

Alternative: reply with `si` or `si #29540` to approve by text.

---

## Engineering Practices

- **Modular architecture**: The original 1200-line monolith was refactored into 5 focused modules (~150-290 lines each)
- **Type safety**: Strict TypeScript, zero `any`, typed error handling (`catch (e: unknown)`)
- **Resilience**: Auto-retry on navigation interruptions, DOM stability checks, popup auto-dismiss
- **Observability**: Per-PR debug folders with timestamped screenshots + HTML snapshots at each step
- **Security**: All credentials in `.env`, no hardcoded secrets, session files in `.gitignore`
- **Real-time monitoring**: WebSocket server emits granular step events for external consumers
- **Queue persistence**: Survives process restarts, auto-recovers in-progress items

---

## Roadmap

- [ ] **Desktop widget** (Electron) — Real-time visual monitor showing pipeline progress (WS server already emits events)
- [ ] **Conflict detection** — Check PR merge status before attempting, skip if conflicts exist
- [ ] **Multi-account support** — Handle PRs across different AWS accounts/regions
- [ ] **Health check endpoint** — HTTP endpoint for uptime monitoring
- [ ] **Metrics** — Track success rate, average processing time, failure patterns
- [ ] **Scheduled session refresh** — Proactively renew AWS session before expiry

---

## Documentation

Open `docs/guia-instalacion.html` in a browser for a visual step-by-step installation guide (Spanish).

# Flitterbot — Features Overview

Orchestration layer above Pi-managed agent streams. A long-running control surface hosts concurrent Pi agent sessions — one default for triage, one orchestrator per active workstream — behind a configurable classifier. State in SQLite; user interaction via WhatsApp and web client (bidirectionally synced); Codex app-server workers perform delegated coding work; optional legacy Claude Code sessions can report back via hooks; OS-level cron injects periodic health checks.

## How It Works

### Message Flow

All inbound messages hit the control surface. Web and WhatsApp messages pass through the configured router classifier that matches against open streams in SQLite. The default install preserves the previous Groq classifier (`openai/gpt-oss-120b`), but config can switch classification to Pi provider auth, OpenAI-compatible models, or disable it. Hook events, cron prompts, and direct-targeted Pi-session messages bypass classification.

Routing after classification:
- **Matched stream** → that stream's orchestrator
- **New stream needed** → default agent (can call `create_stream` to spawn orchestrator)
- **Non-work / no match** → default agent
- **Hook events** → Pi session owning the Claude Code session (by `pi_session_id`, `stream_id`, worktree path, or default fallback)
- **Cron** → default agent

Router classifier context is deliberately small and visible in logs. For each run, the control surface logs the exact classifier system prompt and user prompt. The user prompt contains all open streams, the last 4 messages per open stream (no time-window filter), and the last 4 default-agent messages after the most recent stream creation boundary. That boundary prevents default-agent context that led to an already-created stream from leaking into later routing decisions. The current user message is always included separately.

Each Pi session has its own FIFO turn queue; all agents process concurrently.

### Workstream Lifecycle

Default agent creates streams via `create_stream` — inserts a SQLite row, spawns a bound orchestrator, and by default passes relevant user context through to the new stream. For normal single-stream creation, the runtime looks at up to 10 recent default-surface real user messages (`web`/`whatsapp`, `sender=user`, no `stream_id`) after the previous stream creation boundary, asks the configured relevance classifier which messages belong in the new stream, forces the current user message in if missing, and formats those messages as the orchestrator's initial prompt. The relevance classifier sees the stream name, the default agent's optional `message` as the stream purpose/agent context, and the candidate user messages; it is instructed to omit vague default-agent orchestration prompts unless that purpose makes the concrete task clear. If relevance classification fails, it falls back to the current user message only. `skipUserMessage=true` is reserved for batch-created streams where the default agent supplies a targeted full prompt in `message`; that mode skips user-message passthrough entirely.

The orchestrator enriches the stream (repo, git worktree via `set_up_worktree`), launches Codex app-server workers for delegated coding tasks, and coordinates waves through prompt-based delegation. Legacy tmux/Claude sessions remain available only when explicitly configured. On completion, `close_stream` merges to the confirmed base branch, pushes when permitted by the close flow, closes the row, and the runtime destroys the orchestrator.

Soft-deleted: `status` flips to `closed` with `closed_at`. Recently closed streams (7d) are stored for status reporting and reopening via API.

### Claude Code Feedback Loop

Hook scripts POST lifecycle events (`session-start`, `stop`, `session-end`) to the control surface. `session-start` registers the session in SQLite with Pi/workstream linkage. `stop` uses Claude Code's native `last_assistant_message` from the stop payload and enqueues it back to the owning Pi — closing the Pi → CC → Pi loop. `stop` also transitions the session to `idle`. `session-end` marks the session `ended`.

Only sessions with `FLITTERBOT_AGENT_MANAGED=1` are tracked — set automatically by `launch_claude_code`, or manually via `FLITTERBOT_AGENT_MANAGED=1 claude`. Hook errors log to `~/.flitterbot/logs/hooks-errors.log`; hooks silently skip when the control surface is down. `projectRoot` / `sourceRoot` in the runtime refer to this checkout, not the working directory of a managed Claude Code session.

### Output Surfacing

Pi's final text each turn auto-surfaces to WhatsApp and web — no tool call needed. Web messages mirror to WhatsApp (`*User (web):*` prefix); Pi responses appear as `*Flitterbot:*`. Replies from either surface reach both.

### Proactive Behavior (Cron)

OS-level timer (systemd on Linux, launchd on macOS, 10-min interval) POSTs to `/cron/tick`. The endpoint runs a 6-gate sequence:

1. Pi session ready — default session exists
2. Pi not busy — no duplicate prompts
3. Pi session object exists — not ended/crashed
4. WhatsApp connected — Pi can reach user
5. No active circuit breakers (`health_flags`)
6. Stale sessions → stale-check prompt; no working sessions → idle-check prompt

Separate 60s maintenance loop: pings blackboard, refreshes WhatsApp, marks stale sessions, kills 24h-old idle tmux sessions, detects stuck turns (sets `stuck_turn` health flag, 30-min TTL, WhatsApp alert).

## Architecture

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Web App    │  │  WhatsApp    │  │  Cron Timer  │
│  (browser)   │  │  Daemon      │  │  (OS-level)  │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ WS / HTTP        │ HTTP POST       │ HTTP POST
       ▼                  ▼                 ▼
┌───────────────────────────────────────────────────────────┐
│                Control Surface (:18820)                    │
│                                                           │
│  ┌───────────────────┐  Hook events ─────┐               │
│  │ Classifier        │  Cron prompts ────┤               │
│  │ Routes web/WA to  │                   │               │
│  │ workstream or     │                   │               │
│  │ default           │                   │               │
│  └────────┬──────────┘                   │               │
│           ▼                              ▼               │
│  ┌────────────────────────────────────────────────────┐  │
│  │              PiSessionManager                      │  │
│  │  Default agent (always-on singleton)               │  │
│  │  Orchestrators (per-workstream, ephemeral)         │  │
│  │  Each: TurnQueue · PiSessionState · Pi SDK session │  │
│  └────────────────────────────────────────────────────┘  │
│                                                           │
│  Blackboard (SQLite, WAL)  ·  WebSocketHub (RFC 6455)    │
│  Maintenance loop (60s)    ·  Bearer-token auth           │
└────────────────────┬──────────────────────────────────────┘
                     │
    ┌────────────────┼────────────────┐
    ▼                ▼                ▼
┌──────────┐  ┌──────────────┐  ┌─────────────────────┐
│ WhatsApp │  │  Blackboard  │  │ Claude Code (tmux)  │
│ Daemon   │  │  SQLite DB   │  │ Git Worktrees       │
│(Baileys) │  │  (v14)       │  │ Hook → POST         │
└──────────┘  └──────────────┘  └─────────────────────┘
```

## Components

### Control Surface

Node.js/TypeScript server on `127.0.0.1:18820`. Hosts `PiSessionManager`, configurable classifier, HTTP/WS API, maintenance loop. Single user, localhost only. Read-only `/api/*` unauthenticated; mutating endpoints require bearer token (auto-generated UUID).

Endpoints: `POST /message`, `/hook/:event`, `/cron/tick`, `/stop`, `/sessions/:id/message` (tmux inject), `/runtime/whatsapp/start|stop`, `/api/pi-sessions/:id/interrupt`, `/api/workstreams/:id/reopen`; `GET /status`, `/api/sessions[/:id[/transcript]]`, `/api/pi/history`, `/api/pi-sessions/:id/sessions`, `/api/pi-sessions/:id/workstream`, `/api/skills`, `/api/directory-completions`; `WS /ws`.

### Pi Agents

Stream-backed roles with tailored system prompts and role-gated tools:

**Default** — real always-on triage session. Created first at startup via `PiSessionManager.createDefault()` → `createFlitterbotAgent({ role: "default" })` → `buildDefaultAgentPrompt(...)`. Delegates engineering work via `create_stream` (spawns orchestrator, passes relevant user context unless explicitly skipped for batch creation); sends messages to orchestrators via `enqueue_message`. Cannot write code.

**Default streams** — per non-default WhatsApp user streams (`streams.type = "defaultStream"`). They use the same default-agent prompt and tools as the real default session, and new default streams are seeded with `defaultAgentFirstMessage`.

**Orchestrators** — ephemeral work sessions, one per work stream. Manage Codex worker sessions through `launch_codex_worker`, `get_codex_worker_status`, `send_codex_worker_followup`, and `cancel_codex_worker`. Tools also include `set_up_worktree` (inspect/apply stream worktree setup) and `close_stream` (confirmed merge/noop close flow, cleanup, self-destruct). Cannot write code directly.

Shared: `query_blackboard` (read-only SQL). SDK-provided: `read`, `bash`, `grep`. Hot-reload of skills/prompts/system-prompt is a user-facing `/reload` command (handled directly in `runtime.enqueue()`), not an LLM tool — routing reloads through the LLM wastes tokens.

Delivery: `followUp` (queue append) or `steer` (bypass queue, interrupt via `streamingBehavior: "steer"`; two-layer bypass at runtime and TurnQueue level).

On startup: creates the real default agent first, rehydrates open stream sessions as dormant shells (`session: null`), then ensures every non-default WhatsApp user has an open default stream. Live SDK agents are created lazily on first incoming message via `activateStreamSession()`, deriving the prompt/tool set from `streams.type`. Crashed stream sessions are excluded from rehydration and replaced with fresh ones. Closed workstreams can be reopened — flips status back to `open`, revives the pi_session, rehydrates the stream session.

### Blackboard (SQLite)

`~/.flitterbot/blackboard.db` — WAL, 5s busy timeout, foreign keys. Schema v14 (migrations v0→v14). Schema + row types + enums in `src/contracts/blackboard.ts`.

| Table | Purpose |
|-------|---------|
| `workstreams` | Units of work (open/closed), repo/worktree paths |
| `sessions` | Claude Code sessions: working → idle → stale → ended; linked to workstream + pi_session |
| `pi_sessions` | Pi runtime sessions: active / waiting_for_user / waiting_for_sessions / ended / crashed; `workstream_id` FK, `last_datetime_reported_at` |
| `messages` | Unified log (TEXT UUID PK); sources: whatsapp, web, hook, cron, init, agent, pi_outbound; `pi_session_id` FK (indexed) |
| `message_id_map` | Agent message ID → server UUID bridging for deduplication |
| `whatsapp_messages` | Delivery tracking (pending → sent → delivered \| failed), reply matching |
| `pending_actions` | Persistent user decisions: whatsapp_auth_expired, restart_session, approve_change, clarify |
| `health_flags` | Circuit-breaker flags with optional TTL |

Code: `query-*.ts` (reads), `write-*.ts` (mutations), `pi-sessions.ts` (adapter). No barrel file.

### WhatsApp Channel

Standalone Baileys daemon, detached process, Unix domain socket IPC (newline-delimited JSON). Control surface auto-starts on first command.

Outbound: DB record → typing indicator → send → mark sent/failed; delivery receipts → `delivered`. Inbound: unwrap wrappers → extract text/caption → echo filter (5s) → dedup (`wa_message_id`) → forward HTTP → persist. Reply matching: quoted message → latest pending action → latest outbound with context_ref.

Auth: QR or pairing code; credentials backed up on every update; expiry creates `whatsapp_auth_expired` pending action. Single recipient; text-only outbound; inbound extracts media captions (image, video, document).

### Web App

Thin browser client. TanStack Start (SSR + file-based routing), Tailwind v4 (oklch), Lit components for chat (`@mariozechner/pi-agent-core`), `marked` + `highlight.js`.

Routes: `/` (Input Surface — unified activity feed), `/pi` (agent tabs: default + per-orchestrator sessions, with downstream sessions panel), `/runtime` (status). Nested `/pi` layout: `/pi/default`, `/pi/$sessionId`.

State: TanStack Query as primary state layer with WS-driven cache invalidation via `ws-query-bridge.ts`. `SettingsStore` and theme use `useSyncExternalStore`. Imperative streaming store feeds Lit components directly for high-frequency deltas. WebSocket client: auto-reconnect with exponential backoff, heartbeat ping/pong, visibility-aware reconnect, circuit breaker.

Features: skill picker (`cmdk`), image attachments (paste/drop/pick, base64), path picker (`@`-triggered directory completions), origin badges, light/dark/system theme, WhatsApp controls, sidebar with workstream navigation. WS subscription filtering: clients subscribe to session IDs per route; server filters `broadcast()` per-subscription. WS events use server-assigned UUIDs for message deduplication; ping/pong heartbeat for connection health.

### Installer

Two standalone ESM scripts (`install.mjs`, `uninstall.mjs`), zero dependencies (`node:*` only). Deploys `~/.flitterbot/`, bootstraps Codex-first config, optionally installs Claude Code hooks in `~/.claude/settings.json` (`--with-claude-hooks`), and optionally installs OS scheduler (`--with-scheduler`). Every change manifest-tracked (SHA-256 checksums, drift detection). Each step shows diff, requires confirmation.

Installed tree under `~/.flitterbot/`: `config.json`, `blackboard.db`, `logs/`, `bin/`, `hooks/`, `scripts/`, `scheduler/`, `whatsapp/`.

Runtime scripts: hook dispatcher (`hook-post.mjs`), process manager (`flitterbot-up` — PID tracking, health checks, graceful shutdown cascade), WhatsApp CLI (`flitterbot-wa`), cron script, shared shell utilities.

`flitterbot-up stop` is permanent even when `--with-scheduler` is installed — the scheduler only POSTs a tick to an already-running runtime and cannot start a stopped one. To remove the scheduler, run the uninstaller.

Frozen vs live: the runtime tree under `~/.flitterbot/` is a *copy* of the repo files (`bin/`, `scripts/`, `hooks/`, `whatsapp/` non-server code, scheduler plist) — edits to these in the repo require re-running `installer/install.mjs` to propagate. The control surface server itself runs *live* from the repo via `.controlSurfaceCommand` in `~/.flitterbot/config.json` (seeded at install to `node --experimental-strip-types <repo>/src/server.ts`), so edits under `src/**` take effect on the next `flitterbot-up restart` without reinstalling.

## Source Organization

Domain-organized, max 2-level nesting (`src/domain/file.ts`):

```
src/
├── blackboard/      # SQLite wrapper, migrations, query-*/write-*
├── classifier/      # Configurable LLM routing and context relevance
├── claude-sessions/ # Tmux inspection + injection
├── config/          # FlitterbotConfig loader
├── contracts/       # Shared types, schema DDL, enums (SSOT), message.ts
├── custom-tools/    # close-workstream, set-up-worktree
├── pi/              # Session manager, turn queue, state, agent creation
├── prompts/         # System prompts (default, orchestrator, classifier)
├── routes/          # One file per endpoint
├── transcript/      # Paginated reader
├── whatsapp/        # Daemon, IPC, auth, send, receive, CLI
├── ws/              # WebSocketHub (raw RFC 6455)
├── runtime.ts       # ControlSurfaceRuntime
└── server.ts        # HTTP server, route dispatch, WS upgrade
```

## Features

This overview is the source of truth for feature inventory. Linked feature docs are retained only when they contain substantial design, implementation, or spec detail; overview-only entries intentionally have no separate stub doc.

| # | Feature | Purpose |
|---|---------|---------|
| 1 | Installer / Uninstaller | Permission-gated, manifest-tracked deployment of runtime tree and external config modifications |
| 2 | Blackboard | SQLite state layer (v14). Streams, Claude Code sessions, Pi sessions, unified messages, message ID mapping, WhatsApp tracking, pending actions, health flags |
| 3 | Control Surface | HTTP/WS server hosting PiSessionManager (default + orchestrators), configurable classifier, maintenance loop |
| 4 | WhatsApp Channel | Bidirectional Baileys daemon with IPC, echo/dedup filtering, reply matching, auth lifecycle |
| 5 | Web App | Browser client: Input Surface (activity feed), Pi chat with downstream sessions panel, runtime controls |
| 6 | Cron Scheduler | OS-level timer → health-gated periodic prompt injection for stale/idle session management |
| 7 | Pi Agent | Multi-agent Pi layer: default triage + per-stream orchestrators with role-gated custom tools |
| 8 | WebSocket Filtering | Per-client session subscriptions with server-side broadcast filtering |
| 9 | Restructure src/ | Domain-organized codebase with max 2-level nesting, prefix conventions, barrel exports |
| 10 | Bento Board | Bento-style variable-size stream/session grid for at-scale navigation |
| 11 | Chat Panel Streaming Order | Correct message ordering during streaming |
| 12 | Message Struct Unification | Unified message structures across surfaces |
| 13 | Performance Audit | Performance profiling and optimization |
| 14 | [At-Mention Directory Autocomplete](at-mention-directory-autocomplete/FEATURE.md) | `@`-triggered path picker with server-side directory completions and repo-aware fuzzy search |
| 15 | [Diff Viewer](diff-viewer/FEATURE.md) | Worktree diff panel rendered from server-side `git diff` output |
| 16 | [Input Draft Persistence](input-draft-persistence/FEATURE.md) | Preserve composer drafts across route navigation without React sync overhead |
| 17 | [Keyboard Shortcuts](shortcuts/FEATURE.md) | Action-based global shortcut system with configurable combo and sequential bindings |
| 18 | [WebSocket Client Sync](ws-client-sync/FEATURE.md) | Canonical server-event → WS → client-cache/streaming-store synchronization model |
| 19 | [TanStack Patterns](tanstack-patterns/FEATURE.md) | TanStack Query/Router patterns replacing imperative state; SSR-safe data loading guidance |
| 20 | [Pretext Text Rendering](pretext-text-rendering/FEATURE.md) | Text measurement, virtualization height prediction, cursor positioning, and path truncation |
| 21 | [Streaming Markdown Performance](streaming-markdown-perf/FEATURE.md) | Planned incremental markdown parsing, chunking, direct-DOM streaming block, and highlight caching |

## Dependency Order

```
Installer → Blackboard → WhatsApp Channel ──┐
                                             ├─→ Control Surface (+ Classifier)
                                   (none) ──┘            → Web App
                                                         → Cron Scheduler
```

## State Glossary

### Claude Code sessions

`working` → `idle` → `stale` → `ended`. No persisted `crashed`; unlaunched sessions have no row. Staleness: `last_event_at` > `stallMinutes` (15) AND no tool activity past `toolTimeoutMinutes` (4); marked by maintenance loop. 24h cleanup catches `working` and `stale` sessions (not just idle).

### Pi sessions

`active` (processing turn) · `waiting_for_user` (universal idle) · `waiting_for_sessions` (CC sessions running) · `ended` · `crashed`. All transitions runtime-managed.

### Workstreams

`open` (active, optional repo/worktree) · `closed` (soft-deleted with `closed_at`; retained 7d for status reporting and reopening).

## Design Principles

- **Multi-agent, single runtime** — one process, concurrent Pi sessions with independent turn queues
- **Classifier routes, Pi acts** — configurable classifier matches to workstreams; hooks and cron bypass classification
- **Workstreams are the unit of work** — each gets a worktree, CC sessions, dedicated orchestrator that self-destructs on completion
- **Unified comms** — Pi responses auto-surface to WhatsApp + web; messages from either surface mirror to both
- **Push-based** — all delivery event-driven; no polling for message discovery
- **Delivery before bookkeeping** — forward first, persist in try/catch after
- **Prompt-driven waves** — Pi coordinates CC session waves through instructions, not infrastructure
- **Todoist is human-owned** — Pi reads/annotates, never autonomously completes
- **Permission-gated** — Pi suggests, doesn't execute without approval
- **Minimal footprint** — fresh installs touch only `~/.flitterbot/`; `~/.claude/settings.json` and scheduler entries are opt-in
- **Uninstaller-first** — manifest-tracked, drift-detected removal before installation

## Quick Start

```bash
pnpm install
pnpm --dir web install
node installer/install.mjs
~/.flitterbot/bin/flitterbot-up start
# optional
pnpm --dir web dev
~/.flitterbot/bin/flitterbot-wa auth
```

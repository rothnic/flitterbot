# Codex Subscription Migration

Make Flitterbot usable from a Codex subscription without requiring Anthropic or
Claude Code as the primary agent path.

## Current State

Flitterbot resolves `openai-codex` models through the Pi SDK catalog. Fresh
installs seed `openai-codex/gpt-5.5` as the orchestration model and keep
Anthropic model entries as explicit legacy configuration. The current SDK
catalog resolves `openai-codex/gpt-5.5`.

Important tested limitation: Pi provider auth is not the same auth store as
Codex CLI auth. A clean Flitterbot runtime with `~/.codex/auth.json` copied in
can start and create a default Pi session for `openai-codex/gpt-5.5`, but a
real `/message` prompt fails with `No API key found for openai-codex` because
Pi reads `~/.pi/agent/auth.json` or
`~/.flitterbot/control-surface/agent/auth.json`.

That does not mean orchestrator prompts should bypass Pi. The intended split is:

- **Pi orchestrator prompts**: default agent, stream orchestrators, routing, and
  planning run through Pi provider auth. If these use `openai-codex`, Pi needs
  an authorized `openai-codex` provider credential backed by the user's
  OpenAI/Codex subscription.
- **Coding worker prompts**: delegated coding tasks run through real Codex CLI,
  SDK, or app-server auth on the worker host, backed by the same underlying
  OpenAI/Codex subscription but stored in Codex's credential layer.

The "just a Codex subscription" product goal therefore has two auth gates:
authorized Pi `openai-codex` for orchestration, and authorized Codex
CLI/app-server for coding workers.

Router classification is orchestrator-adjacent work, not a coding worker turn.
It is now configurable through `classifier` in `~/.flitterbot/config.json`:

- `provider: "pi"` sends classification prompts through Pi provider auth and
  can use a configured Pi model such as `openai-codex/gpt-5.5`.
- `provider: "groq"` preserves the previous default
  `openai/gpt-oss-120b` classifier through `GROQ_API_KEY`.
- `provider: "openai"` or `openai-compatible` uses the OpenAI SDK chat
  completions path and can point at direct API models such as `gpt-4.1` when
  an API key is available.
- `provider: "openai-compatible"` also covers proxy gateways such as 9router
  when a subscription-backed model is available through a Chat Completions
  compatible `/v1` endpoint.
- `provider: "disabled"` skips classifier calls and routes to the default
  fallback.

The remaining Claude-specific surface is legacy compatibility, not the default
main path:

- installer writes lifecycle hooks to `~/.claude/settings.json` only when
  `--with-claude-hooks` is passed or an existing managed hook install is being
  preserved
- tmux skill can launch `claude --dangerously-skip-permissions` when
  `tmuxEnabled` is explicitly enabled
- hook ingestion expects Claude Code payloads, including `last_assistant_message`
- tmux state detection treats the live process name `claude` as the agent
- docs and user prompts should describe Codex workers as the primary substrate
  and Claude/tmux as legacy opt-in compatibility

## Research Notes

- OpenAI's official `codex-plugin-cc` is useful reference code, but it runs
  Codex from inside Claude Code. It does not make Codex emit Claude Code hook
  payloads.
- `codex-plugin-cc` does include reusable patterns for background jobs, Codex
  app-server JSON-RPC, thread IDs, result retrieval, cancellation, and Claude
  transcript transfer.
- Codex hooks use a Claude-style configuration shape, but public issue tracking
  still describes full Claude Code hook parity as incomplete. Treat direct
  Claude hook compatibility as partial, not a stable adapter contract.
- `claude-adapter` keeps Claude Code as the harness and proxies model calls to
  OpenAI-compatible providers. That preserves Claude hooks, but it still
  requires Claude Code and API-key/proxy setup, so it does not meet the "just a
  Codex subscription" goal.
- `claude-to-codex` migrates repo artifacts such as `CLAUDE.md`, skills,
  commands, and agents. It is useful for setup migration, not for live hook or
  worker-session compatibility.

## Codex App-Server Notes

Use real Codex workers for coding tasks. Pi remains useful as the Flitterbot
orchestrator/router, but coding execution should run through Codex CLI, Codex
SDK, or Codex app-server.

`codex app-server` is the preferred worker interface for Flitterbot because it
is built for rich local clients that need authentication, conversation history,
approvals, streamed agent events, and resumable thread control.

Primary capabilities to build around:

- `thread/start`, `thread/resume`, and `thread/fork` map cleanly to Flitterbot
  downstream session creation, continuation, and branching.
- `turn/start` starts a coding turn with explicit `cwd`, model, effort,
  approval policy, and sandbox policy.
- `turn/steer` supports follow-up input to an in-flight worker without creating
  a separate turn.
- streamed notifications provide a replacement for Claude stop hooks and tmux
  screen scraping.
- WebSocket and Unix-socket transports make it possible to keep a long-lived
  Codex worker endpoint per host instead of spawning one process per message.

Flitterbot config now also carries Codex worker profiles. A profile names the
Codex app-server model, approval policy, sandbox mode, base/developer
instructions, profile context, and skill hints to inject when starting a
worker thread. Fresh installs include:

- `coding`: `gpt-5.5`, workspace-write, general implementation profile.
- `light`: `gpt-5.4-mini`, workspace-write, intended for simple edits,
  classification support, and quick repo inspection.

Use `codex exec --json` only as the fallback for simple one-shot jobs. It is not
the primary harness for interactive worker sessions.

## Target Architecture

Introduce a downstream runner boundary instead of continuing to encode Claude in
session, hook, and tmux helpers.

Runner modes:

- `codex-app-server`: launch or connect to a real Codex app-server, then manage
  Codex threads and turns through JSON-RPC.
- `codex-exec`: fallback one-shot runner using `codex exec --json`.
- `claude`: legacy compatibility mode for existing Claude Code installations.

The control surface should use neutral names internally where possible:

- downstream session instead of Claude session
- agent runner instead of Claude runner
- runner hook payload instead of Claude hook payload

## Blackboard Model

The existing `sessions` table is Claude/tmux-shaped and should remain a legacy
compatibility surface during migration. It is not the right source of truth for
Codex app-server work.

Schema v24 adds neutral worker tables:

- `worker_hosts`: local or remote machines that can run coding workers. It
  records connection mode, Codex credential location, capacity, health, and
  capabilities.
- `worker_sessions`: one delegated worker session, independent of runner. For
  Codex app-server this stores the Codex thread ID; for Claude compatibility it
  can reference the legacy session ID.
- `worker_turns`: one prompt/turn inside a worker session. For Codex app-server
  this stores the Codex turn ID and final output.
- `worker_events`: append-only runner event log for streamed notifications,
  tool summaries, errors, approvals, and final output.

The existing `pi_sessions` table continues to represent Pi orchestrator
sessions. Worker tables may link back to a Pi session when a worker was spawned
by an orchestrator, but Pi orchestration state should not be forced into the
worker-session model.

## Multi-Computer Design

Flitterbot should be able to manage coding tasks across multiple computers
without making a single laptop the execution bottleneck.

Topology:

- **Controller**: the Flitterbot control surface and blackboard. It owns stream
  routing, worker assignment, user interaction, durable state, and recovery.
- **Worker host**: any machine with the target repo, dependencies, `codex`, and
  authenticated Codex credentials. Examples: MacBook, `vps-dev`, `vps-gw`, or a
  future remote development host.
- **Worker endpoint**: a Codex app-server instance reachable by the controller
  through stdio-over-SSH, a Unix socket on the same host, or an authenticated
  WebSocket endpoint.

Host registry fields:

- stable `host_id`
- display name and optional role labels such as `local`, `high-memory`,
  `always-on`, `gateway`, or `gpu`
- connection mode: `local-stdio`, `ssh-stdio`, `unix-socket`, or
  `websocket-auth`
- SSH alias or app-server URL
- projects root and allowed workspace roots
- `CODEX_HOME` or credential strategy
- max concurrent Codex threads
- health status, last heartbeat, and current queue depth
- capabilities: operating system, installed tools, browser availability,
  network policy, and preferred repos

Connection policy:

- Prefer `ssh-stdio` for remote hosts at first: start `codex app-server` through
  SSH and keep JSON-RPC on the SSH stream. This avoids exposing app-server to
  the network and follows the same operational shape as Codex remote SSH flows.
- Use a Unix socket for same-host supervised daemons.
- Use WebSocket only for deliberate long-lived worker daemons, and require
  app-server WebSocket auth plus private networking or TLS termination. Do not
  expose unauthenticated non-loopback listeners.
- Treat each worker host's Codex credential store as host-local. For headless
  hosts, authenticate with device auth, copied `~/.codex/auth.json`, or
  `CODEX_ACCESS_TOKEN` depending on the host's trust level.

Scheduling rules:

- Assign each workstream to one worker host at a time unless the stream is
  explicitly split into separate branches/tasks.
- Never run two workers against the same branch/worktree. Use per-task
  worktrees or detached branches to avoid Git reference races.
- Record `host_id`, app-server endpoint identity, `thread_id`, `turn_id`,
  repo path, worktree path, branch, model, sandbox policy, and approval policy
  for every downstream worker.
- If a controller runtime is recreated, reload the worker session and call
  `thread/resume` before starting more work. Full process-level restart and
  remote-host restart proofs are tracked as follow-up gates.
- If a worker host disappears, mark its sessions as `unreachable` rather than
  failed. Resume on the same host when it returns, or explicitly migrate by
  creating a new worktree/thread on another host.

Recovery and observability:

- Workers should heartbeat with app-server availability, Codex auth readiness,
  current thread count, active turns, repo cleanliness, disk space, and basic
  toolchain checks.
- The blackboard should keep an append-only event log of app-server requests,
  streamed notifications, final assistant output, tool summaries, and terminal
  errors.
- Store enough data to show the user where a task is running and how to resume
  or inspect it manually, for example `ssh vps-dev` plus the worktree path and
  `codex resume <thread_id>`.

Security defaults:

- No public unauthenticated app-server listeners.
- Bearer token or signed-token auth for WebSocket mode.
- Least-privilege OS users on shared VPS hosts.
- Per-host writable-root allowlists.
- Explicit approval/sandbox policy stored with each worker session.
- No copying Codex auth files between hosts without an explicit operator action.

## Definition of Done

- Fresh install defaults to `openai-codex` and does not require
  `ANTHROPIC_API_KEY`.
- Setup checks Codex CLI/app-server auth and explains `codex login
  --device-auth`, `~/.codex/auth.json`, or `CODEX_ACCESS_TOKEN` for headless
  hosts.
- Default Pi orchestrators can run on any configured orchestration model, but
  coding workers run through real Codex app-server threads.
- Downstream Codex workers can launch, stream progress, complete, report
  final output, receive follow-up prompts, and be cancelled without Claude Code
  installed.
- The tmux skill is replaced by a Codex worker skill/tool that manages
  app-server threads and host assignment.
- The worker registry supports at least one local host and is shaped for
  multiple SSH/WebSocket worker hosts.
- Session records, web UI, and docs use neutral downstream-session terminology.
- Legacy Claude mode remains available only when explicitly configured.

## Validation

Run:

```bash
pnpm run audit
pnpm run doctor:codex-subscription-readiness -- --cwd "$PWD"
pnpm --dir web run build
pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD" --timeout-ms 180000
pnpm run e2e:codex-worker-restart-recovery -- --cwd "$PWD" --timeout-ms 180000
pnpm run e2e:codex-worker-server-restart -- --cwd "$PWD" --timeout-ms 180000
pnpm run e2e:codex-worker-restart-recovery -- --cwd "$PWD" --worker-host vps-gw --ssh-target vps-gw --worker-cwd /home/ubuntu/data/projects/assura-cold-audit --timeout-ms 180000
pnpm run e2e:live-pi-orchestrator-codex-worker -- --cwd "$PWD" --allow-missing-pi-auth
pnpm run e2e:worker-ui-visibility -- --cwd "$PWD"
pnpm run e2e:codex-worker-host-scheduler
pnpm run e2e:worker-host-configure
pnpm run e2e:codex-first-install-defaults
pnpm run e2e:classifier-provider-configs
pnpm run doctor:codex-subscription-auth -- --fresh-local --cwd "$PWD" --report-only
pnpm run doctor:codex-worker-hosts -- --fresh-local --cwd "$PWD"
node --input-type=module -e 'import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all"; if (!getBuiltinModel("openai-codex", "gpt-5.5")) process.exit(1)'
codex login status
codex debug app-server send-message-v2 "Summarize this repo."
```

Verified on 2026-07-04:

- `pnpm run audit` passes.
- `pnpm --dir web run build` passes, with the existing Vite large-chunk
  warning.
- Fresh installer output now includes the required `shortcuts: {}` config
  default.
- Installer-created blackboard databases now use schema v24, so runtime startup
  no longer re-applies stale migrations into duplicate columns.
- Schema v24 adds neutral worker host/session/turn/event tables while retaining
  the legacy Claude/tmux `sessions` table for compatibility.
- `codex login status` reports ChatGPT auth, and
  `codex debug app-server send-message-v2` can start a Codex thread and return
  a real assistant response from this repo.
- A clean Flitterbot runtime can start and serve `/status` with the default
  `openai-codex/gpt-5.5` Pi session.
- A clean Flitterbot `/message` prompt still fails at the Pi provider layer with
  `No API key found for openai-codex`; this is the next blocker for
  subscription-only operation.
- `pnpm run smoke:codex-worker -- --db <tmp-db> --cwd "$PWD"` can launch a
  local Codex app-server worker, return `flitterbot-worker-ok`, and persist the
  worker host/session/turn/event lifecycle into schema v24 tables.
- `pnpm run smoke:codex-worker -- --db <tmp-db> --cwd "$PWD" --profile light`
  can resolve the installed `light` Codex worker profile, start a real
  app-server thread with profile model/instructions, and persist the profile
  metadata with the worker session.

Verified on 2026-07-06:

- `pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD" --timeout-ms 180000`
  proves a clean temporary runtime can launch, inspect, follow up, cancel,
  persist, and route real Codex app-server worker output through the
  orchestrator tool surface.
- `pnpm run e2e:codex-worker-restart-recovery -- --cwd "$PWD" --timeout-ms 180000`
  proves a recreated runtime can load a persisted local worker session, call
  `thread/resume`, record the resume event, and complete a follow-up on the
  same Codex thread.
- `pnpm run e2e:codex-worker-server-restart -- --cwd "$PWD" --timeout-ms 180000`
  proves the bearer-protected HTTP worker control API can launch, inspect, and
  resume a Codex worker across a real `src/server.ts` process restart. It also
  verifies unauthorized launch rejection, oversized body rejection, and
  persisted active-session follow-up rejection after restart.
- `pnpm run e2e:codex-worker-restart-recovery -- --cwd "$PWD" --worker-host vps-gw --ssh-target vps-gw --worker-cwd /home/ubuntu/data/projects/assura-cold-audit --timeout-ms 180000`
  proves the same runtime-recreation recovery path against an SSH-backed
  `vps-gw` worker host.
- `pnpm run e2e:live-pi-orchestrator-codex-worker -- --cwd "$PWD" --allow-missing-pi-auth`
  proves the live Pi orchestrator harness and records the remaining external
  `openai-codex` Pi provider-auth gate.
  After Pi provider auth is present, rerun this command without
  `--allow-missing-pi-auth` for the full live subscription proof.
- `pnpm run e2e:worker-ui-visibility -- --cwd "$PWD"` proves the bearer
  worker API and rendered operator panel states for populated, resolved
  no-stream, and pending-worktree cases.
- `pnpm run e2e:codex-worker-host-scheduler` proves capacity-aware local/remote
  worker host selection, explicit host override, reservation, stale-heartbeat
  exclusion, and unreachable-host exclusion.
- `pnpm run e2e:worker-host-configure` proves the operator command for adding
  and updating `vps-dev`/`vps-gw` style SSH worker hosts without hand-editing
  `workerHosts` JSON.
- `pnpm run e2e:codex-first-install-defaults` proves fresh installs are
  Codex-first and Claude hooks are legacy opt-in or preserved only when already
  managed.
- `pnpm run e2e:classifier-provider-configs` proves classifier config/auth
  readiness reporting for `disabled`, `groq`, `openai`, `openai-compatible`,
  and `pi`.
- `pnpm run doctor:codex-subscription-readiness -- --cwd "$PWD"` reports all
  repeatable Codex-subscription proof gates in one JSON summary and points to
  the post-login strict mode needed for the final live Pi subscription proof.
  Report mode does not run the live Pi harness unless `--live-pi-harness` is
  passed.

Manual proof:

- install into a clean `~/.flitterbot`
- authenticate Codex with ChatGPT subscription auth
- start the control surface
- create a stream
- launch a downstream Codex app-server worker on the local host
- observe final worker output re-enter the owning orchestrator
- send a follow-up message to the worker
- recreate the runtime and resume the worker from stored `thread_id`
- cancel/interrupt a running worker
- register a second SSH worker host
- route a new stream to that host
- restart the controller process and resume the remote thread from stored
  `thread_id`

## First Slices

1. Codex-first model defaults and docs.
2. Installer/setup readiness checks for Codex CLI/app-server auth.
3. Runner abstraction around downstream session launch, status, follow-up, and
   cancellation.
4. Local Codex app-server runner over stdio or Unix socket. Initial smoke CLI
   is implemented; next step is wiring it into orchestrator-facing tools.
5. Worker host registry and SSH-backed app-server connection.
6. WebSocket-auth worker mode for deliberate always-on hosts.
7. Neutral terminology cleanup after behavior is proven.

## Goal Documents

- [001 Local Codex App-Server Runner](./001-local-codex-app-server-runner.md)
- [002 Orchestrator Codex Worker Control Plane](./002-orchestrator-codex-worker-control-plane.md)
- [003 Runtime E2E Fresh Install Proof](./003-runtime-e2e-fresh-install-proof.md)
- [004 Worker Host Registry And SSH Readiness](./004-worker-host-registry-ssh.md)
- [005 Worker UI Visibility](./005-worker-ui-visibility.md)
- [006 Subscription Auth Closure](./006-subscription-auth-closure.md)
- [007 Worker Host Scheduler](./007-worker-host-scheduler.md)
- [008 Codex-First Install Defaults](./008-codex-first-install-defaults.md)
- [009 Worker Restart Recovery](./009-worker-restart-recovery.md)

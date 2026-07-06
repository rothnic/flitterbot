# Orchestrator Codex Worker Control Plane

## Objective

Pi orchestrators can launch, follow up, cancel, and inspect real Codex
app-server worker tasks through Flitterbot tools, using configured Codex worker
profiles. Tmux remains an optional runner/supervision layer, not a Claude-only
concept and not the source of truth.

## Scope

- Add orchestrator-facing tools for Codex worker launch, follow-up, cancel, and
  status inspection.
- Run coding work through `codex app-server`, not Pi provider prompts and not
  Claude Code.
- Persist worker lifecycle in `worker_sessions`, `worker_turns`, and
  `worker_events`.
- Route final Codex worker output back into the owning stream so the
  orchestrator can act on it.
- Update orchestrator guidance so Codex workers are the default coding-worker
  path and tmux is optional terminal supervision.

## Out Of Scope

- Remote SSH worker hosts.
- Web UI rendering for Codex worker sessions.
- Full worker retry/resume after controller restart.
- Removing legacy Claude/tmux compatibility.

## Definition Of Done

- `launch_codex_worker` starts a real Codex app-server thread with a configured
  profile, prompt, cwd/repo, and stream binding.
- `send_codex_worker_followup` resumes the stored Codex thread and starts a new
  turn on the same worker session.
- `cancel_codex_worker` interrupts an active Codex turn when the runtime still
  owns the app-server client and records canceled state.
- `get_codex_worker_status` reports session, turn, and active-runtime state.
- Worker host/session/turn/event rows are written for launch and follow-up.
- Final Codex output is enqueued into the owning orchestrator stream and
  persisted as a system message.
- Orchestrator prompt wording no longer makes Claude/tmux the default
  sub-agent path.

## Validation

```bash
pnpm run audit
pnpm run smoke:codex-worker -- --db /tmp/flitterbot-worker-smoke.db --cwd "$PWD" --profile light
```

Manual proof:

1. Start a fresh runtime.
2. Create a stream.
3. From the orchestrator, call `launch_codex_worker` with `profile: "light"`.
4. Confirm `worker_sessions` has `runner_type=codex_app_server`, `stream_id`,
   profile metadata, and Codex thread ID.
5. Send a follow-up with `send_codex_worker_followup`.
6. Cancel or complete the worker.
7. Confirm final output is routed back into the stream.

## Verified Evidence

2026-07-06 local run:

- `pnpm run audit` passed.
- `pnpm run smoke:codex-worker -- --db <tmp-db> --cwd "$PWD" --profile light --timeout-ms 120000`
  returned `finalOutput: "flitterbot-worker-ok"` with Codex thread
  `019f34bc-9aa6-7f30-b4a9-10d83ff7f1fa`.
- Direct tool smoke through `ControlSurfaceRuntime.createCustomTools("orchestrator")`
  launched `launch_codex_worker` with profile `light`, completed with
  `flitterbot-tool-ok`, and wrote a `codex_app_server` worker session using
  `gpt-5.4-mini`.
- The same tool smoke called `get_codex_worker_status`, then
  `send_codex_worker_followup`, and the follow-up completed with
  `flitterbot-followup-ok`.
- The tool smoke persisted 94 worker events and two stream messages; the latest
  routed message started with `Codex worker completed`.
- Active cancel smoke called `cancel_codex_worker` against a running worker and
  left both `worker_sessions.status` and the latest `worker_turns.status` as
  `canceled`.

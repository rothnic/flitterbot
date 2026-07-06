# Local Codex App-Server Runner

## Objective

Prove one local Codex coding worker can run through `codex app-server`, persist
its lifecycle into the v24 worker tables, and return final output without using
Claude Code or Pi provider auth for worker execution.

## Scope

- Spawn `codex app-server` over stdio.
- Initialize the app-server client.
- Start one Codex thread in a requested cwd.
- Optionally resolve a configured Codex worker profile and inject its model,
  approval/sandbox policy, base/developer instructions, context, and skill
  hints into the app-server thread.
- Start one turn with the smoke prompt.
- Capture streamed app-server notifications.
- Persist worker host, worker session, worker turn, and worker events.
- Return the final assistant answer.

## Out Of Scope

- Replacing the Pi orchestrator message path.
- Replacing Claude/tmux worker tools.
- Remote SSH worker hosts.
- Web UI rendering for worker sessions.
- Approval handling beyond using `approvalPolicy: "never"` for the smoke.

## Definition Of Done

- `src/blackboard/query-workers.ts` can write/read the v24 worker tables.
- A local Codex app-server runner can return exactly `flitterbot-worker-ok`.
- The smoke run writes rows to `worker_hosts`, `worker_sessions`,
  `worker_turns`, and `worker_events`.
- A profile-backed smoke run stores profile metadata on `worker_sessions`.
- `pnpm run audit` passes.
- A fresh install runtime still starts and serves `/status`.

## Validation

```bash
pnpm run smoke:codex-worker -- --db /tmp/flitterbot-worker-smoke.db --cwd "$PWD"
pnpm run smoke:codex-worker -- --db /tmp/flitterbot-worker-smoke.db --cwd "$PWD" --profile light
sqlite3 /tmp/flitterbot-worker-smoke.db "SELECT runner_type, status, external_thread_id FROM worker_sessions;"
sqlite3 /tmp/flitterbot-worker-smoke.db "SELECT status, external_turn_id, final_output FROM worker_turns;"
sqlite3 /tmp/flitterbot-worker-smoke.db "SELECT COUNT(*) FROM worker_events;"
pnpm run audit
```

## Verified Evidence

2026-07-05 local run:

- `pnpm run smoke:codex-worker -- --db /tmp/flitterbot-codex-worker-smoke.hnSVcz --cwd "$PWD" --timeout-ms 120000`
- Returned `finalOutput: "flitterbot-worker-ok"`.
- Wrote a completed `codex_app_server` row to `worker_sessions` with Codex
  thread `019f3433-d053-7fb0-bd2d-e6dec62c32e6`.
- Wrote a completed row to `worker_turns` with Codex turn
  `019f3433-d2e9-7c52-82e7-4052bc45ccad`.
- Wrote 45 rows to `worker_events`.

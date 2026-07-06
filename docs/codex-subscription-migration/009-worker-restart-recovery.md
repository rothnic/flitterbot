# Worker Runtime-Recreation Recovery

## Objective

Prove Codex app-server worker sessions can survive Flitterbot runtime
recreation and process restart over the same blackboard: the recreated runtime
must load the persisted worker session, call `thread/resume` with the stored
Codex thread ID, complete a follow-up turn on the same recorded worker session,
and reconcile interrupted active sessions into an explicit resumable state.

## Scope

- Add an automated restart boundary to the Codex worker control-plane E2E.
- Stop the first `ControlSurfaceRuntime` after the initial Codex worker turn
  completes.
- Create a new `ControlSurfaceRuntime` in the same Node process against the
  same config and blackboard.
- Start the real `src/server.ts` process, launch a worker through the
  bearer-protected HTTP worker API, stop the process, start a second process,
  and resume the stored Codex thread through HTTP.
- Verify the restarted runtime sees no in-memory active worker handle but does
  see the stored `external_thread_id`.
- Mark persisted active Codex app-server worker sessions as `unreachable` on
  runtime startup when no active app-server client exists for them.
- Mark the latest active turn for those sessions as `failed`, emit a
  `worker/recovery/interrupted` event, and allow explicit follow-up resume
  through the stored Codex thread ID.
- Send `send_codex_worker_followup` from the restarted runtime.
- Verify the follow-up completes on the same worker session and host.

## Out Of Scope

- Recovering partial output from an in-flight turn that was interrupted by
  process death.
- Running SSH/remote-host restart recovery by default.
- Migrating a worker session to a different host.
- Long-lived WebSocket or Unix-socket worker daemons.

## Validation

```bash
pnpm run e2e:codex-worker-restart-recovery -- --cwd "$PWD" --timeout-ms 180000
pnpm run doctor:codex-subscription-readiness -- --cwd "$PWD" --restart-recovery
pnpm run e2e:codex-worker-server-restart -- --cwd "$PWD" --timeout-ms 180000
pnpm run doctor:codex-subscription-readiness -- --cwd "$PWD" --server-restart-recovery
pnpm run e2e:codex-worker-restart-recovery -- --cwd "$PWD" --worker-host vps-gw --ssh-target vps-gw --worker-cwd /home/ubuntu/data/projects/assura-cold-audit --timeout-ms 180000
pnpm run doctor:codex-subscription-readiness -- --cwd "$PWD" --restart-recovery --restart-recovery-worker-host vps-gw --restart-recovery-ssh-target vps-gw --restart-recovery-worker-cwd /home/ubuntu/data/projects/assura-cold-audit
pnpm run audit
```

## Definition Of Done

- The restart recovery E2E launches a real Codex app-server worker.
- The initial turn completes and routes output back to the stream.
- The first runtime stops before the follow-up begins.
- The second runtime opens the same blackboard and reads the persisted worker
  session.
- The second runtime resumes the stored Codex thread and completes a follow-up.
- The server-process E2E proves launch/status/follow-up through the
  bearer-protected HTTP worker API across a real `src/server.ts` process
  restart.
- The HTTP worker API rejects unauthorized launch requests and oversized worker
  control bodies.
- Runtime startup reconciles persisted active Codex app-server sessions to
  `unreachable`, marks their latest active turn `failed`, records a
  `worker/recovery/interrupted` event, and then permits explicit follow-up
  resume through the stored thread ID.
- Duplicate controller startup exits on the PID guard before reconciliation, so
  a second process cannot mark the live controller's active workers
  `unreachable` while the original process is still running.
- The worker session keeps the same `worker_session_id`, `host_id`, and Codex
  thread ID across restart and follow-up.
- `worker_events` contains app-server initialization, resume, and turn events.

## Future Extensions

- Preserve partial streamed output from in-flight turns interrupted by
  controller process death.

## Verified Evidence

2026-07-06 local and SSH runs:

- `pnpm run e2e:codex-worker-restart-recovery -- --cwd "$PWD" --timeout-ms 180000`
  passed against a local Codex app-server worker.
- `pnpm run doctor:codex-subscription-readiness -- --cwd "$PWD" --restart-recovery --timeout-ms 180000`
  included the local runtime-recreation recovery proof in the aggregate
  readiness report.
- `pnpm run e2e:codex-worker-server-restart -- --cwd "$PWD" --timeout-ms 180000`
  started the real control-surface server process, launched a worker through
  `POST /api/workers`, stopped the process, started a second server process,
  resumed the worker through `POST /api/workers/:workerSessionId/followup`,
  verified bearer auth on worker launch, rejected an oversized launch body,
  proved duplicate startup fails the PID guard without reconciling live active
  worker rows, reconciled a synthetic persisted active worker session to
  `unreachable` with a failed turn and `worker/recovery/interrupted` event, and
  resumed that interrupted session through the stored Codex thread ID.
- `pnpm run e2e:codex-worker-restart-recovery -- --cwd "$PWD" --worker-host vps-gw --ssh-target vps-gw --worker-cwd /home/ubuntu/data/projects/assura-cold-audit --timeout-ms 180000`
  passed against the SSH-backed `vps-gw` worker host.
- The SSH proof launched the initial turn on `vps-gw`, recreated the runtime,
  resumed the stored Codex thread, completed a follow-up, and preserved the
  worker session, host, and thread IDs.

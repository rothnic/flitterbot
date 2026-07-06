# Worker Runtime-Recreation Recovery

## Objective

Prove a completed Codex app-server worker session can survive Flitterbot runtime
recreation over the same blackboard: the recreated runtime must load the
persisted worker session, call `thread/resume` with the stored Codex thread ID,
and complete a follow-up turn on the same recorded worker session.

## Scope

- Add an automated restart boundary to the Codex worker control-plane E2E.
- Stop the first `ControlSurfaceRuntime` after the initial Codex worker turn
  completes.
- Create a new `ControlSurfaceRuntime` in the same Node process against the
  same config and blackboard.
- Verify the restarted runtime sees no in-memory active worker handle but does
  see the stored `external_thread_id`.
- Send `send_codex_worker_followup` from the restarted runtime.
- Verify the follow-up completes on the same worker session and host.

## Out Of Scope

- Resuming an in-flight turn that was interrupted by process death.
- Proving a full control-surface process restart through the CLI/service layer.
- Proving SSH/remote-host restart recovery by default.
- Migrating a worker session to a different host.
- Long-lived WebSocket or Unix-socket worker daemons.

## Validation

```bash
pnpm run e2e:codex-worker-restart-recovery -- --cwd "$PWD" --timeout-ms 180000
pnpm run doctor:codex-subscription-readiness -- --cwd "$PWD" --restart-recovery
pnpm run audit
```

## Definition Of Done

- The restart recovery E2E launches a real Codex app-server worker.
- The initial turn completes and routes output back to the stream.
- The first runtime stops before the follow-up begins.
- The second runtime opens the same blackboard and reads the persisted worker
  session.
- The second runtime resumes the stored Codex thread and completes a follow-up.
- The worker session keeps the same `worker_session_id`, `host_id`, and Codex
  thread ID across restart and follow-up.
- `worker_events` contains app-server initialization, resume, and turn events.

## Future Extensions

- Run the same recovery proof against a configured SSH worker host, for example
  with `--worker-host vps-gw --ssh-target vps-gw --worker-cwd <remote-path>`.
- Add a subprocess-level control-surface restart proof that exercises PID,
  server, and command-wrapper lifecycle.
- Add recovery for in-flight turns interrupted by controller process death.

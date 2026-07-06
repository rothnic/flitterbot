# Worker Host Scheduler

## Objective

Move Codex worker launches from manual host selection toward a capacity-aware
multi-computer scheduler while keeping operator-pinned host selection intact.

## Scope

- Count active worker sessions per host from neutral `worker_sessions` rows.
- Select a host when `launch_codex_worker` omits `worker_host`.
- Prefer local execution when local has capacity.
- Select remote hosts only when they are ready, under capacity, and explicitly
  opt into automatic scheduling.
- Preserve explicit `worker_host` behavior even when a host is over capacity or
  not auto-selectable.
- Keep follow-up turns on the worker session's recorded host.

## Auto-Selection Contract

Remote hosts are not scheduled by default. A non-local host must opt in with one
of:

```json
{
  "capabilities": {
    "autoSelect": true
  }
}
```

or:

```json
{
  "capabilities": {
    "scheduler": "auto"
  }
}
```

The first scheduler policy is intentionally conservative:

- explicit `worker_host` always wins;
- omitted `worker_host` uses local first;
- remote auto-selection requires `worker_hosts.status` to be `ready` or `busy`;
- active capacity counts sessions in `starting`, `running`, or
  `waiting_for_user`;
- in-flight launches reserve host capacity until the worker session row exists,
  so concurrent no-host launches do not all select the same open slot;
- remote auto-selection requires a fresh host heartbeat from the last ten
  minutes;
- `idle`, `completed`, `failed`, `canceled`, and `unreachable` sessions do not
  consume active capacity.

## Out Of Scope

- Repo/worktree affinity across machines.
- Host queueing or pending worker jobs.
- Restart recovery and app-server reconnect.
- WebSocket or Unix-socket worker daemons.

## Validation

```bash
pnpm run e2e:codex-worker-host-scheduler
pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD" --timeout-ms 180000
pnpm run audit
```

Remote smoke after a ready SSH host is configured:

```bash
pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD" --worker-host vps-gw --ssh-target vps-gw --worker-cwd /home/ubuntu/data/projects/assura-cold-audit --timeout-ms 180000 --skip-cancel
```

## Definition Of Done

- No-host `launch_codex_worker` calls use scheduler selection rather than an
  implicit unconfigured local fallback.
- Local host selection works without a health doctor run.
- A full local host causes the scheduler to choose a ready remote host only when
  that remote host opted into auto-selection.
- A reserved local launch slot is treated as consumed while the worker is
  starting.
- Stale or unreachable remote hosts are not auto-selected.
- Manual remote hosts are never auto-selected.
- Explicit `worker_host` still launches the requested host.
- Scheduler behavior has a repeatable blackboard-backed proof.
- `pnpm run audit` passes.

## Verified Evidence

2026-07-06 local run:

- `pnpm run e2e:codex-worker-host-scheduler` passed against a temporary
  blackboard and proved local defaulting, ready remote auto-selection when local
  is full, explicit manual host override, explicit over-capacity local override,
  reserved local capacity handling, capacity exhaustion failure, stale remote
  exclusion, and unreachable remote exclusion.
- `pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD" --timeout-ms 180000 --omit-worker-host`
  passed against a temporary runtime and real Codex app-server worker. The
  launch omitted `worker_host`, selected `local`, completed the initial worker
  turn, persisted `host_id=local`, completed a follow-up on the same recorded
  host, routed two stream messages, wrote 93 worker events, and canceled an
  active worker turn.
- `pnpm run audit` passed.

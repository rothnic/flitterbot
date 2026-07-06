# Worker Host Registry And SSH Readiness

## Objective

Make Flitterbot's worker control plane aware of local and remote machines that
can run Codex coding workers, with enough durable state to support future
multi-computer task routing.

## Scope

- Add `workerHosts` to Flitterbot config.
- Sync configured hosts into `worker_hosts` on runtime startup.
- Support local and SSH stdio host readiness checks.
- Launch Codex app-server workers through SSH stdio for configured SSH hosts.
- Resume follow-up turns on the same recorded worker host.
- Record host status, heartbeat time, Codex version, auth status, projects
  root, credential location, and capabilities in the blackboard.
- Keep the registry compatible with future Unix-socket and authenticated
  WebSocket worker endpoints.

## Out Of Scope

- Scheduling work across multiple hosts.
- Long-lived remote WebSocket daemons.
- Copying Codex credentials between machines.

## Config Shape

Fresh installs include a local host:

```json
{
  "workerHosts": [
    {
      "id": "local",
      "displayName": "Local machine",
      "connectionMode": "local-stdio",
      "projectsRoot": "~/development",
      "codexHome": "~/.codex",
      "maxConcurrentWorkers": 1,
      "capabilities": {
        "role": "local"
      }
    }
  ]
}
```

Example SSH host:

```json
{
  "id": "vps-dev",
  "displayName": "vps-dev",
  "connectionMode": "ssh-stdio",
  "connectionTarget": "vps-dev",
  "projectsRoot": "~/data/projects",
  "codexHome": "~/.codex",
  "maxConcurrentWorkers": 4,
  "capabilities": {
    "role": "high-memory",
    "preferredFor": ["parallel-development"]
  }
}
```

## Validation

```bash
pnpm run e2e:worker-host-configure
pnpm run worker-host:configure -- --id vps-dev --ssh-target vps-dev --projects-root ~/data/projects --max-concurrent-workers 4 --role high-memory --auto-select
pnpm run worker-host:configure -- --id vps-gw --ssh-target vps-gw --projects-root ~/data/projects --role gateway
pnpm run doctor:codex-worker-hosts -- --fresh-local --cwd "$PWD"
pnpm run doctor:codex-worker-hosts
pnpm run doctor:codex-worker-hosts -- --allow-unreachable
pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD" --worker-host vps-gw --ssh-target vps-gw --worker-cwd /home/ubuntu/data/projects/assura-cold-audit --timeout-ms 180000 --skip-cancel
sqlite3 ~/.flitterbot/blackboard.db "SELECT host_id, connection_mode, status, last_heartbeat_at FROM worker_hosts;"
pnpm run audit
```

## Definition Of Done

- `workerHosts` is accepted and validated by config loading.
- `pnpm run worker-host:configure` can add or update local/SSH worker hosts in
  config without hand-editing JSON.
- Installer-created configs include a local worker host.
- Runtime startup syncs configured hosts into `worker_hosts`.
- `pnpm run doctor:codex-worker-hosts` checks local `codex --version` and
  `codex login status`.
- SSH hosts use `ssh <connectionTarget> sh -lc '<codex checks>'`.
- `launch_codex_worker` accepts `worker_host` and can start a Codex app-server
  worker through SSH stdio.
- `send_codex_worker_followup` resumes the same stored Codex thread on the
  worker session's recorded host.
- Unreachable hosts are marked `unreachable`; ready hosts are marked `ready`.
- `pnpm run audit` passes.

## Future Extension

The first scheduling slice is tracked in
[`007-worker-host-scheduler.md`](007-worker-host-scheduler.md). Local restart
recovery is tracked in
[`009-worker-restart-recovery.md`](009-worker-restart-recovery.md). Remaining
remote execution extensions are repo/worktree mapping, remote restart proof,
and recovery for in-flight turns interrupted by controller process death.

## Verified Evidence

2026-07-06 local run:

- `pnpm run doctor:codex-worker-hosts -- --fresh-local --cwd "$PWD"` passed
  against a temporary `HOME` and fresh blackboard.
- The command synced the configured local host into `worker_hosts`.
- The command marked `local` as `ready` and detected `codex-cli 0.142.5`.
- `pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD" --worker-host vps-gw --ssh-target vps-gw --worker-cwd /home/ubuntu/data/projects/assura-cold-audit --timeout-ms 180000 --skip-cancel`
  passed against `vps-gw`.
- The SSH run started Codex app-server through SSH stdio, completed launch and
  follow-up turns, wrote 42 worker events, and routed two worker completion
  messages back into the local stream.
- `pnpm run e2e:worker-host-configure` passed against a temporary config and
  proved adding `vps-dev`, adding `vps-gw`, updating `vps-dev` capacity and
  scheduler flags, preserving existing capabilities, dry-run non-persistence,
  and `loadConfig()` compatibility for the resulting `workerHosts`.

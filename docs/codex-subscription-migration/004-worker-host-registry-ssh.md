# Worker Host Registry And SSH Readiness

## Objective

Make Flitterbot's worker control plane aware of local and remote machines that
can run Codex coding workers, with enough durable state to support future
multi-computer task routing.

## Scope

- Add `workerHosts` to Flitterbot config.
- Sync configured hosts into `worker_hosts` on runtime startup.
- Support local and SSH stdio host readiness checks.
- Record host status, heartbeat time, Codex version, auth status, projects
  root, credential location, and capabilities in the blackboard.
- Keep the registry compatible with future Unix-socket and authenticated
  WebSocket worker endpoints.

## Out Of Scope

- Scheduling work across multiple hosts.
- Running a full Codex app-server turn over SSH stdio.
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
pnpm run doctor:codex-worker-hosts -- --fresh-local --cwd "$PWD"
pnpm run doctor:codex-worker-hosts
pnpm run doctor:codex-worker-hosts -- --allow-unreachable
sqlite3 ~/.flitterbot/blackboard.db "SELECT host_id, connection_mode, status, last_heartbeat_at FROM worker_hosts;"
pnpm run audit
```

## Definition Of Done

- `workerHosts` is accepted and validated by config loading.
- Installer-created configs include a local worker host.
- Runtime startup syncs configured hosts into `worker_hosts`.
- `pnpm run doctor:codex-worker-hosts` checks local `codex --version` and
  `codex login status`.
- SSH hosts use `ssh <connectionTarget> sh -lc '<codex checks>'`.
- Unreachable hosts are marked `unreachable`; ready hosts are marked `ready`.
- `pnpm run audit` passes.

## Future Extension

The next remote execution slice should reuse this registry to choose a host,
start `codex app-server` through SSH stdio, persist the selected `host_id`, and
resume stored `thread_id` values on the same host after controller restart.

## Verified Evidence

2026-07-06 local run:

- `pnpm run doctor:codex-worker-hosts -- --fresh-local --cwd "$PWD"` passed
  against a temporary `HOME` and fresh blackboard.
- The command synced the configured local host into `worker_hosts`.
- The command marked `local` as `ready` and detected `codex-cli 0.142.5`.

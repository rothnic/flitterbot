# Runtime E2E Fresh Install Proof

## Objective

Prove a clean Flitterbot runtime can use the orchestrator Codex-worker control
plane to launch, inspect, follow up, cancel, persist, and route real Codex
app-server worker output without requiring Claude Code.

## Scope

- Create a temporary `HOME` with a fresh `~/.flitterbot/config.json`.
- Disable classifier calls so the proof does not depend on Groq, OpenAI API
  keys, 9router, or Pi provider auth.
- Reuse the operator's Codex credential store through `CODEX_HOME`.
- Create a fresh blackboard and stream.
- Drive `ControlSurfaceRuntime.createCustomTools("orchestrator", streamId)`.
- Launch a real Codex app-server worker with a configured worker profile.
- Wait for final output and verify it was persisted back into the stream.
- Inspect worker status through the runtime tool.
- Resume the same Codex thread with a follow-up turn.
- Cancel an active Codex worker turn through the runtime tool.

## Out Of Scope

- Proving Pi provider auth can send the orchestrator prompt. That remains Goal
  006 because Pi `openai-codex` auth and Codex CLI/app-server auth are currently
  separate stores.
- Remote SSH worker hosts.
- Web UI visibility.
- Removing legacy Claude/tmux compatibility.

## Definition Of Done

- `pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD"` passes from a clean
  temp config and blackboard.
- The command writes at least one `worker_hosts`, `worker_sessions`,
  `worker_turns`, and `worker_events` row.
- The launched worker session is linked to the created stream.
- The first worker turn completes with `flitterbot-e2e-ok`.
- The worker completion is persisted as a stream message.
- `get_codex_worker_status` reports the completed worker.
- `send_codex_worker_followup` completes a second turn with
  `flitterbot-e2e-followup-ok`.
- `cancel_codex_worker` cancels an active worker turn.
- `pnpm run audit` passes.

## Validation

```bash
pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD"
pnpm run e2e:live-pi-orchestrator-codex-worker -- --cwd "$PWD"
pnpm run audit
```

Useful debug mode:

```bash
pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD" --keep
```

Remote SSH worker proof:

```bash
pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD" --worker-host vps-gw --ssh-target vps-gw --worker-cwd /home/ubuntu/data/projects/assura-cold-audit --skip-cancel
```

The command prints the temp home, config path, blackboard path, stream id,
Codex thread id, worker session id, worker turn ids, event count, routed message
count, and cancel proof.

Live Pi orchestrator proof:

```bash
pnpm run e2e:live-pi-orchestrator-codex-worker -- --cwd "$PWD"
```

This creates a fresh temporary install, copies an existing Pi `openai-codex`
auth file into the temporary Flitterbot control-surface auth path for the run,
creates a real stream orchestrator, sends a user prompt through the Pi queue,
and verifies the orchestrator calls `launch_codex_worker`. If Pi
`openai-codex` auth is absent, use `--allow-missing-pi-auth` to record the
auth gate without failing local report-only validation.

## Product Note

This proof intentionally bypasses live Pi LLM prompting by calling the
orchestrator tool surface directly. It proves the Flitterbot runtime can execute
the user-facing worker path once an orchestrator chooses the tool. The remaining
subscription-only auth question is whether Pi orchestration and classifier calls
can authenticate through the same subscription-backed provider path, or whether
classification should use an OpenAI-compatible proxy such as 9router.

## Verified Evidence

2026-07-06 local run:

- `pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD" --timeout-ms 180000`
  passed against a temporary `HOME` and fresh blackboard.
- The command launched a real Codex app-server worker through
  `launch_codex_worker`, completed with `flitterbot-e2e-ok`, and routed the
  worker completion back into the stream.
- The command resumed the same Codex thread through
  `send_codex_worker_followup` and completed with
  `flitterbot-e2e-followup-ok`.
- The command launched a second active Codex worker and canceled it through
  `cancel_codex_worker`.
- The completed worker wrote 96 `worker_events` rows and two routed stream
  messages.
- `pnpm run audit` passed.

2026-07-06 live Pi orchestrator proof harness:

- Added `pnpm run e2e:live-pi-orchestrator-codex-worker`.
- `pnpm run e2e:live-pi-orchestrator-codex-worker -- --cwd "$PWD" --allow-missing-pi-auth`
  completed as a skipped report because `~/.pi/agent/auth.json` does not
  contain `openai-codex` auth on this machine.
- The remaining live proof is to complete `pnpm exec pi` → `/login` →
  `ChatGPT Plus/Pro (Codex)`, then rerun the same E2E without
  `--allow-missing-pi-auth`.

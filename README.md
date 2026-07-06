# Flitterbot

Orchestration runtime for Pi-managed streams with Codex coding workers. Routes WhatsApp/web messages to concurrent Pi orchestrators and, while the downstream runner migration is in progress, can supervise Claude Code sessions in git worktrees.

Architecture: [`docs/overview.md`](docs/overview.md). Deep dives: [`docs/<feature>/FEATURE.md`](docs/).

## Prerequisites

Node.js 22+, pnpm, tmux, Codex CLI signed in with ChatGPT/Codex subscription auth, sqlite3.

Claude Code CLI is still required only for the current downstream tmux worker loop. The Codex-native worker migration is tracked in [`docs/codex-subscription-migration/FEATURE.md`](docs/codex-subscription-migration/FEATURE.md).

## Install

```bash
pnpm install && pnpm --dir web install
cp .env.example .env                    # optional: set GROQ_API_KEY for default classifier
codex login                             # ChatGPT/Codex subscription auth
node installer/install.mjs              # deploys ~/.flitterbot/, wires hooks
~/.flitterbot/bin/flitterbot-up start
~/.flitterbot/bin/flitterbot-wa auth    # optional: WhatsApp
pnpm --dir web dev                      # optional: web UI (:3188)
```

Installer flags: `--dry-run` preview, `--with-scheduler` launchd/systemd cron.

## Config

`.env`: `GROQ_API_KEY` is only required for the default Groq classifier. The
router classifier is configurable in `~/.flitterbot/config.json` through
`classifier.provider` (`groq`, `openai`, `openai-compatible`, `pi`, or
`disabled`) and `classifier.model`. Use `provider: "pi"` when router prompts
should consume Pi provider auth, including `openai-codex` models.
Use `provider: "openai-compatible"` for proxy gateways such as 9router:

```json
"classifier": {
  "provider": "openai-compatible",
  "model": "openai-codex/gpt-5.4-mini",
  "apiKeyEnv": "NINEROUTER_API_KEY",
  "baseURL": "https://your-9router-endpoint/v1",
  "maxTokens": 1024
}
```

Fresh installs seed an `openai-codex/gpt-5.5` Pi model entry, but Pi's auth
store is separate from Codex CLI auth. Coding worker execution uses real Codex
CLI/SDK/app-server auth. `ANTHROPIC_API_KEY` is optional for legacy Claude
model entries.

Runtime tuning: edit `~/.flitterbot/config.json` — keys are self-describing. The user-facing prompt knobs are:

- `defaultAgentFirstMessage` — first instruction queued when the default agent starts.
- `newStreamFirstMessageFooter` — footer appended to the first prompt sent to every new stream orchestrator.
- `tmuxEnabled` — include tmux sub-agent orchestration instructions in orchestrator prompts.
- `extraSkillPaths` — additional skill directories loaded after bundled Flitterbot skills.
- `learningsNotePath` — Markdown document used by the bundled `learnings` skill.
- `codexWorkerProfiles` — named Codex app-server worker profiles with model,
  sandbox/approval policy, injected context, developer instructions, and skill
  hints. The default install includes `coding` (`gpt-5.5`) and `light`
  (`gpt-5.4-mini`).
- `workerHosts` — local or remote machines that can run Codex workers. Start
  with `local-stdio`; add `ssh-stdio` hosts such as `vps-dev` when the remote
  machine has the repo, dependencies, `codex`, and Codex auth.

Skills load from `~/.claude/skills`, `~/.agents/skills`, bundled `~/.flitterbot/skills`, then `extraSkillPaths`. Flitterbot agent instructions load from `~/.flitterbot/control-surface/agent/AGENTS.md`; the installer creates this file if missing and leaves user edits intact. Tasks are managed through Flitterbot's bundled task API at `~/.flitterbot/data/tasks`; local notes live under `~/.flitterbot/data/notes`.

## Commands

```bash
~/.flitterbot/bin/flitterbot-up   start | status | stop | restart
~/.flitterbot/bin/flitterbot-wa   start | status | stop | auth
pnpm --dir web dev                          # web UI
pnpm run control-surface                    # run from source
pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD"
pnpm run doctor:codex-worker-hosts -- --fresh-local --cwd "$PWD"
pnpm run doctor:codex-subscription-auth -- --fresh-local --cwd "$PWD" --report-only
node ~/.flitterbot/uninstall.mjs [--meta]   # remove hooks+scheduler (+~/.flitterbot/)
```

## Troubleshooting

- *`flitterbot-up start` fails* — check `~/.flitterbot/config.json`, `control-surface.log`; verify `node`/`claude`/`tmux`/`sqlite3` on PATH.
- *`openai-codex` Pi prompts fail with "No API key found"* — Pi does not read `~/.codex/auth.json`; use Pi provider login for orchestrator prompts. Codex app-server worker execution can still use Codex CLI subscription auth.
- *WhatsApp auth errors* — re-run `flitterbot-wa auth`.
- *Hooks not firing* — check `~/.claude/settings.json`, `~/.flitterbot/logs/hooks-errors.log`. Async, 15s timeout.
- *Runtime restarts after stop* — scheduler installed; run uninstaller.

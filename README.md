# Flitterbot

Orchestration runtime for Pi-managed streams with Codex coding workers. Routes WhatsApp/web messages to concurrent Pi orchestrators and can optionally ingest legacy Claude Code hook events.

Architecture: [`docs/overview.md`](docs/overview.md). Deep dives: [`docs/<feature>/FEATURE.md`](docs/).

## Prerequisites

Node.js 22+, pnpm, Codex CLI signed in with ChatGPT/Codex subscription auth, sqlite3.

Claude Code CLI and tmux are optional legacy integrations. The primary coding-worker path uses Codex app-server.

## Install

```bash
pnpm install && pnpm --dir web install
cp .env.example .env                    # optional: set GROQ_API_KEY for default classifier
codex login                             # Codex worker subscription auth
pnpm exec pi                            # optional: /login -> ChatGPT Plus/Pro (Codex)
node installer/install.mjs              # deploys ~/.flitterbot/
~/.flitterbot/bin/flitterbot-up start
~/.flitterbot/bin/flitterbot-wa auth    # optional: WhatsApp
pnpm --dir web dev                      # optional: web UI (:3188)
```

Installer flags: `--dry-run` preview, `--with-scheduler` launchd/systemd cron, `--with-claude-hooks` legacy Claude Code hook ingestion.

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
store is separate from Codex CLI auth. Use interactive `pi`, then `/login`, then
select `ChatGPT Plus/Pro (Codex)` when Pi orchestrator prompts should use the
same subscription-backed provider. Flitterbot prefers a populated
`~/.flitterbot/control-surface/agent/auth.json` for the target provider, then a
populated `~/.pi/agent/auth.json` for that provider; empty or unrelated auth
entries do not shadow populated fallback files. Coding worker execution uses
real Codex CLI/SDK/app-server auth. Add Anthropic models and `ANTHROPIC_API_KEY`
only for explicit legacy Claude orchestration.

Runtime tuning: edit `~/.flitterbot/config.json` — keys are self-describing. The user-facing prompt knobs are:

- `defaultAgentFirstMessage` — first instruction queued when the default agent starts.
- `newStreamFirstMessageFooter` — footer appended to the first prompt sent to every new stream orchestrator.
- `tmuxEnabled` — include legacy tmux sub-agent orchestration instructions in orchestrator prompts. Fresh installs leave this disabled.
- `extraSkillPaths` — additional skill directories loaded after bundled Flitterbot skills.
- `learningsNotePath` — Markdown document used by the bundled `learnings` skill.
- `codexWorkerProfiles` — named Codex app-server worker profiles with model,
  sandbox/approval policy, injected context, developer instructions, and skill
  hints. The default install includes `coding` (`gpt-5.5`) and `light`
  (`gpt-5.4-mini`).
- `workerHosts` — local or remote machines that can run Codex workers. Start
  with `local-stdio`; add `ssh-stdio` hosts such as `vps-dev` when the remote
  machine has the repo, dependencies, `codex`, and Codex auth.

Skills load from `~/.claude/skills`, `~/.agents/skills`, bundled `~/.flitterbot/skills`, then `extraSkillPaths`. The `~/.claude/skills` path is legacy compatibility and is not required for Codex workers. Flitterbot agent instructions load from `~/.flitterbot/control-surface/agent/AGENTS.md`; the installer creates this file if missing and leaves user edits intact. Tasks are managed through Flitterbot's bundled task API at `~/.flitterbot/data/tasks`; local notes live under `~/.flitterbot/data/notes`.

## Commands

```bash
~/.flitterbot/bin/flitterbot-up   start | status | stop | restart
~/.flitterbot/bin/flitterbot-wa   start | status | stop | auth
pnpm --dir web dev                          # web UI
pnpm run control-surface                    # run from source
pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD"
pnpm run doctor:codex-worker-hosts -- --fresh-local --cwd "$PWD"
pnpm run doctor:codex-subscription-auth -- --fresh-local --cwd "$PWD" --report-only
node ~/.flitterbot/uninstall.mjs [--meta]   # remove managed hooks+scheduler (+~/.flitterbot/)
```

## Troubleshooting

- *`flitterbot-up start` fails* — check `~/.flitterbot/config.json`, `control-surface.log`; verify `node`, `codex`, and `sqlite3` on PATH.
- *`openai-codex` Pi prompts fail with "No API key found"* — Pi does not read `~/.codex/auth.json`; run `pnpm exec pi`, enter `/login`, and select `ChatGPT Plus/Pro (Codex)`. Codex app-server worker execution can still use Codex CLI subscription auth.
- *WhatsApp auth errors* — re-run `flitterbot-wa auth`.
- *Legacy Claude hooks not firing* — install with `--with-claude-hooks`, then check `~/.claude/settings.json` and `~/.flitterbot/logs/hooks-errors.log`. Async, 15s timeout.
- *Runtime restarts after stop* — scheduler installed; run uninstaller.

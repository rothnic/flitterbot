# Codex-First Install Defaults

## Objective

Make fresh Flitterbot installs use the Codex/OpenAI subscription path as the
primary path and keep Claude/tmux surfaces as explicit legacy opt-ins.

## Scope

- Seed only the `openai-codex/gpt-5.5` orchestration model by default.
- Keep Codex worker profiles and local Codex worker host defaults.
- Disable `tmuxEnabled` on fresh installs.
- Leave `newStreamFirstMessageFooter` empty on fresh installs so new stream
  orchestrators are not told to load the tmux skill.
- Skip Claude Code hook installation by default.
- Add `--with-claude-hooks` for explicit legacy hook ingestion.
- Preserve existing managed Claude hook installs on reinstall.
- Keep legacy config keys such as `claudeCliCommand` available for users who
  opt into Claude/tmux compatibility.

## Out Of Scope

- Removing legacy hook ingestion code.
- Removing legacy `sessions` or `claude-sessions` tables/modules.
- Removing `~/.claude/skills` from the skill search path.

## Validation

```bash
pnpm run e2e:codex-first-install-defaults
pnpm run audit
```

## Definition Of Done

- Fresh installer config has `defaultModel: "gpt-5.5"`.
- Fresh installer config has no Anthropic model entries.
- Fresh installer config has `tmuxEnabled: false`.
- Fresh installer config has an empty `newStreamFirstMessageFooter`.
- Fresh installer config still has `coding` and `light` Codex worker profiles.
- Fresh installer config still has a local Codex worker host.
- Default install does not create `~/.claude/settings.json`.
- Default install does not record `~/.claude/settings.json` in the manifest.
- `--with-claude-hooks` creates the legacy hook settings and records the
  manifest target.
- `pnpm run audit` passes.

## Verified Evidence

2026-07-06 local run:

- `pnpm run e2e:codex-first-install-defaults` passed against two temporary
  homes.
- The default install generated config with `defaultModel: "gpt-5.5"`,
  `tmuxEnabled: false`, empty `newStreamFirstMessageFooter`, and only the
  `openai-codex` model provider.
- The default install generated a local `local-stdio` Codex worker host with
  `codexHome: "~/.codex"`.
- The default install did not create `~/.claude/settings.json` or record a
  `~/.claude/settings.json` manifest target.
- The `--with-claude-hooks` install generated the same Codex-first config and
  did create the legacy Claude hook settings plus manifest target.
- A later default reinstall in the same home preserved the existing managed
  Claude hook install.

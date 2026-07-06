#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeFakeProjectRoot(baseDir) {
  const projectRoot = path.join(baseDir, "project-root");
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "web"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "package.json"), '{"name":"flitterbot-install-proof"}\n');
  fs.writeFileSync(path.join(projectRoot, "src", "server.ts"), "console.log('proof');\n");
  return projectRoot;
}

function runInstall(home, projectRoot, extraArgs = []) {
  execFileSync("node", ["installer/install.mjs", "--yes", ...extraArgs], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HOME: home,
      FLITTERBOT_INSTALL_PROJECT_ROOT: projectRoot,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hookCommands(settings) {
  const hooks = settings.hooks ?? {};
  return Object.values(hooks).flatMap((groups) =>
    Array.isArray(groups)
      ? groups.flatMap((group) =>
          Array.isArray(group?.hooks)
            ? group.hooks
                .map((hook) => hook?.command)
                .filter((command) => typeof command === "string")
            : [],
        )
      : [],
  );
}

function assertCodexFirstConfig(config) {
  assert(config.defaultModel === "gpt-5.5", `unexpected defaultModel ${config.defaultModel}`);
  assert(config.tmuxEnabled === false, "fresh install should not enable tmux");
  assert(config.newStreamFirstMessageFooter === "", "fresh install should not seed tmux footer");
  assert(Array.isArray(config.models), "models should be an array");
  assert(
    config.models.some((model) => model.provider === "openai-codex" && model.modelId === "gpt-5.5"),
    "fresh install should seed openai-codex/gpt-5.5",
  );
  assert(
    !config.models.some((model) => model.provider === "anthropic"),
    "fresh install should not seed Anthropic models",
  );
  assert(
    Array.isArray(config.codexWorkerProfiles) &&
      config.codexWorkerProfiles.some((profile) => profile.id === "coding") &&
      config.codexWorkerProfiles.some((profile) => profile.id === "light"),
    "fresh install should seed Codex worker profiles",
  );
  assert(
    Array.isArray(config.workerHosts) &&
      config.workerHosts.some(
        (host) =>
          host.id === "local" &&
          host.connectionMode === "local-stdio" &&
          host.codexHome === "~/.codex",
      ),
    "fresh install should seed a local Codex worker host",
  );
}

function assertNoClaudeHookInstall(home) {
  const settingsPath = path.join(home, ".claude", "settings.json");
  assert(!fs.existsSync(settingsPath), "default install should not write ~/.claude/settings.json");
  const manifest = readJson(path.join(home, ".flitterbot", "manifest.json"));
  assert(
    !manifest.targets?.["~/.claude/settings.json"],
    "default install should not record Claude hook target in manifest",
  );
}

function assertClaudeHookOptIn(home) {
  const settingsPath = path.join(home, ".claude", "settings.json");
  assert(fs.existsSync(settingsPath), "--with-claude-hooks should write ~/.claude/settings.json");
  const settings = readJson(settingsPath);
  const commands = hookCommands(settings);
  assert(
    commands.some((command) => command.includes(".flitterbot/hooks/hook-post.mjs")),
    "Claude hook settings should call Flitterbot hook dispatcher",
  );
  const manifest = readJson(path.join(home, ".flitterbot", "manifest.json"));
  assert(
    manifest.targets?.["~/.claude/settings.json"],
    "--with-claude-hooks should record Claude hook target in manifest",
  );
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-codex-first-install-"));
  const defaultHome = path.join(tempDir, "default-home");
  const hooksHome = path.join(tempDir, "hooks-home");
  const projectRoot = makeFakeProjectRoot(tempDir);
  fs.mkdirSync(defaultHome, { recursive: true });
  fs.mkdirSync(hooksHome, { recursive: true });

  try {
    runInstall(defaultHome, projectRoot);
    const defaultConfig = readJson(path.join(defaultHome, ".flitterbot", "config.json"));
    assertCodexFirstConfig(defaultConfig);
    assertNoClaudeHookInstall(defaultHome);

    runInstall(hooksHome, projectRoot, ["--with-claude-hooks"]);
    const hooksConfig = readJson(path.join(hooksHome, ".flitterbot", "config.json"));
    assertCodexFirstConfig(hooksConfig);
    assertClaudeHookOptIn(hooksHome);

    runInstall(hooksHome, projectRoot);
    const preservedHooksConfig = readJson(path.join(hooksHome, ".flitterbot", "config.json"));
    assertCodexFirstConfig(preservedHooksConfig);
    assertClaudeHookOptIn(hooksHome);

    console.log(
      JSON.stringify(
        {
          ok: true,
          defaultConfig: {
            defaultModel: defaultConfig.defaultModel,
            tmuxEnabled: defaultConfig.tmuxEnabled,
            newStreamFirstMessageFooter: defaultConfig.newStreamFirstMessageFooter,
            modelProviders: defaultConfig.models.map((model) => model.provider),
            workerHosts: defaultConfig.workerHosts.map((host) => ({
              id: host.id,
              connectionMode: host.connectionMode,
            })),
          },
          claudeHooksDefault: false,
          claudeHooksOptIn: true,
          claudeHooksPreservedOnReinstall: true,
        },
        null,
        2,
      ),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

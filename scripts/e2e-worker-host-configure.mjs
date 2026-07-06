#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeConfig(home) {
  const flitterbotDir = path.join(home, ".flitterbot");
  fs.mkdirSync(flitterbotDir, { recursive: true });
  const configPath = path.join(flitterbotDir, "config.json");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        controlSurfaceHost: "127.0.0.1",
        controlSurfacePort: 0,
        controlSurfaceToken: "worker-host-config-e2e-token",
        models: [
          {
            id: "codex",
            label: "Codex",
            provider: "openai-codex",
            modelId: "gpt-5.5",
          },
        ],
        defaultModel: "codex",
        defaultThinkingLevel: "medium",
        classifier: {
          provider: "disabled",
          model: "openai/gpt-oss-120b",
          apiKeyEnv: "GROQ_API_KEY",
          maxTokens: 1024,
        },
        defaultCodexWorkerProfile: "light",
        codexWorkerProfiles: [
          {
            id: "light",
            label: "Light coding worker",
            model: "gpt-5.4-mini",
            approvalPolicy: "never",
            sandbox: "workspace-write",
            skillNames: [],
            skillPaths: [],
          },
        ],
        workerHosts: [
          {
            id: "local",
            displayName: "Local machine",
            connectionMode: "local-stdio",
            projectsRoot: process.cwd(),
            codexHome: "~/.codex",
            maxConcurrentWorkers: 1,
            capabilities: { role: "local" },
          },
        ],
        piTransport: "auto",
        stallMinutes: 30,
        toolTimeoutMinutes: 30,
        blackboardPath: "~/.flitterbot/blackboard.db",
        whatsappAuthDir: "~/.flitterbot/whatsapp-auth",
        whatsappSocketPath: "~/.flitterbot/whatsapp.sock",
        whatsappPidPath: "~/.flitterbot/whatsapp.pid",
        whatsappCliPath: "flitterbot-wa",
        whatsappDaemonPath: "flitterbot-wa-daemon",
        claudeCliCommand: "claude",
        projectsDir: process.cwd(),
        wipeStreamsOnStart: false,
        whatsappEnabled: false,
        shortcuts: {},
        defaultAgentFirstMessage: "",
        newStreamFirstMessageFooter: "",
        tmuxEnabled: false,
        extraSkillPaths: [],
        learningsNotePath: "~/.flitterbot/data/notes/learnings.md",
      },
      null,
      2,
    )}\n`,
  );
  return configPath;
}

function runConfigure(args) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(process.cwd(), "scripts", "configure-codex-worker-host.mjs"), ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(stdout);
}

function expectConfigureFailure(args, expectedText) {
  try {
    runConfigure(args);
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? "";
    const stdout = error?.stdout?.toString?.() ?? "";
    const message = `${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`;
    assert(message.includes(expectedText), `expected failure to include ${expectedText}, got ${message}`);
    return;
  }
  throw new Error(`expected configure command to fail with ${expectedText}`);
}

function loadConfigSummary(home) {
  const stdout = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `const { loadConfig } = await import(${JSON.stringify(path.join(process.cwd(), "src/config/load-config.ts"))}); const config = loadConfig(); console.log(JSON.stringify({ workerHosts: config.workerHosts }));`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(stdout);
}

function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-worker-host-config-"));
  try {
    const configPath = writeConfig(home);
    const vpsDev = runConfigure([
      "--config",
      configPath,
      "--id",
      "vps-dev",
      "--ssh-target",
      "vps-dev",
      "--projects-root",
      "~/data/projects",
      "--max-concurrent-workers",
      "4",
      "--role",
      "high-memory",
      "--auto-select",
      "--capability",
      "preferredFor=parallel-development",
    ]);
    assert(vpsDev.action === "added", "vps-dev should be added");
    assert(vpsDev.host.connectionMode === "ssh-stdio", "vps-dev should use ssh-stdio");
    assert(vpsDev.host.connectionTarget === "vps-dev", "vps-dev target mismatch");
    assert(vpsDev.host.capabilities.autoSelect === true, "vps-dev should opt into auto selection");

    const vpsGw = runConfigure([
      "--config",
      configPath,
      "--id",
      "vps-gw",
      "--ssh-target",
      "vps-gw",
      "--projects-root",
      "~/data/projects",
      "--role",
      "gateway",
    ]);
    assert(vpsGw.action === "added", "vps-gw should be added");
    assert(vpsGw.host.capabilities.autoSelect !== true, "vps-gw should remain manual by default");

    const desktopLocal = runConfigure([
      "--config",
      configPath,
      "--id",
      "desktop",
      "--connection-mode",
      "local-stdio",
      "--projects-root",
      process.cwd(),
      "--role",
      "desktop",
    ]);
    assert(desktopLocal.host.connectionMode === "local-stdio", "desktop should start as local");
    const desktopSsh = runConfigure([
      "--config",
      configPath,
      "--id",
      "desktop",
      "--ssh-target",
      "desktop",
      "--projects-root",
      "~/data/projects",
    ]);
    assert(desktopSsh.action === "updated", "desktop should be updated");
    assert(desktopSsh.host.connectionMode === "ssh-stdio", "--ssh-target should imply ssh-stdio on update");
    assert(desktopSsh.host.connectionTarget === "desktop", "desktop SSH target should be stored");
    const desktopBackToLocal = runConfigure([
      "--config",
      configPath,
      "--id",
      "desktop",
      "--connection-mode",
      "local-stdio",
      "--projects-root",
      process.cwd(),
    ]);
    assert(desktopBackToLocal.host.connectionMode === "local-stdio", "desktop should convert back to local");
    assert(!desktopBackToLocal.host.connectionTarget, "desktop local conversion should drop SSH target");
    const desktopBackToSsh = runConfigure([
      "--config",
      configPath,
      "--id",
      "desktop",
      "--ssh-target",
      "desktop",
      "--projects-root",
      "~/data/projects",
    ]);
    assert(desktopBackToSsh.host.connectionMode === "ssh-stdio", "desktop should convert back to SSH");
    assert(desktopBackToSsh.host.connectionTarget === "desktop", "desktop reconverted target should be stored");

    expectConfigureFailure(
      [
        "--config",
        configPath,
        "--id",
        "bad-fractional-capacity",
        "--ssh-target",
        "bad-fractional-capacity",
        "--max-concurrent-workers",
        "0.5",
      ],
      "--max-concurrent-workers must be a positive integer",
    );
    expectConfigureFailure(
      [
        "--config",
        configPath,
        "--id",
        "bad-target",
        "--connection-mode",
        "local-stdio",
        "--ssh-target",
        "bad-target",
      ],
      "--ssh-target cannot be used with local-stdio worker hosts",
    );

    const vpsDevUpdate = runConfigure([
      "--config",
      configPath,
      "--id",
      "vps-dev",
      "--max-concurrent-workers",
      "6",
      "--scheduler-auto",
    ]);
    assert(vpsDevUpdate.action === "updated", "vps-dev should be updated");
    assert(vpsDevUpdate.host.connectionMode === "ssh-stdio", "vps-dev update should preserve ssh-stdio");
    assert(vpsDevUpdate.host.connectionTarget === "vps-dev", "vps-dev update should preserve SSH target");
    assert(vpsDevUpdate.host.maxConcurrentWorkers === 6, "vps-dev capacity should update");
    assert(
      vpsDevUpdate.host.capabilities.preferredFor === "parallel-development",
      "vps-dev update should preserve existing capabilities",
    );
    assert(vpsDevUpdate.host.capabilities.scheduler === "auto", "vps-dev scheduler flag missing");

    const dryRun = runConfigure([
      "--config",
      configPath,
      "--id",
      "vps-dry-run",
      "--ssh-target",
      "vps-dry-run",
      "--dry-run",
    ]);
    assert(dryRun.dryRun === true, "dry-run should report dryRun true");

    const summary = loadConfigSummary(home);
    const ids = summary.workerHosts.map((host) => host.id);
    assert(ids.includes("local"), "loaded config missing local host");
    assert(ids.includes("vps-dev"), "loaded config missing vps-dev");
    assert(ids.includes("vps-gw"), "loaded config missing vps-gw");
    assert(ids.includes("desktop"), "loaded config missing desktop");
    assert(!ids.includes("vps-dry-run"), "dry-run host should not be persisted");
    assert(!ids.includes("bad-fractional-capacity"), "failed fractional-capacity host should not be persisted");
    assert(!ids.includes("bad-target"), "failed target host should not be persisted");
    const loadedVpsDev = summary.workerHosts.find((host) => host.id === "vps-dev");
    assert(loadedVpsDev.connectionMode === "ssh-stdio", "loaded vps-dev connection mode mismatch");
    assert(loadedVpsDev.connectionTarget === "vps-dev", "loaded vps-dev target mismatch");
    assert(loadedVpsDev.maxConcurrentWorkers === 6, "loaded vps-dev capacity mismatch");
    assert(loadedVpsDev.capabilities.autoSelect === true, "loaded vps-dev autoSelect mismatch");
    assert(loadedVpsDev.capabilities.scheduler === "auto", "loaded vps-dev scheduler mismatch");
    const loadedDesktop = summary.workerHosts.find((host) => host.id === "desktop");
    assert(loadedDesktop.connectionMode === "ssh-stdio", "loaded desktop should have converted to SSH");
    assert(loadedDesktop.connectionTarget === "desktop", "loaded desktop target mismatch");

    console.log(
      JSON.stringify(
        {
          ok: true,
          configPath,
          workerHosts: summary.workerHosts.map((host) => ({
            id: host.id,
            connectionMode: host.connectionMode,
            connectionTarget: host.connectionTarget,
            maxConcurrentWorkers: host.maxConcurrentWorkers,
            capabilities: host.capabilities,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main();

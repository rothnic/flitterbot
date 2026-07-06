#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_HOME = os.homedir();

function parseArgs(argv) {
  const opts = { allowUnreachable: false, cwd: process.cwd(), freshLocal: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--allow-unreachable") {
      opts.allowUnreachable = true;
    } else if (arg === "--fresh-local") {
      opts.freshLocal = true;
    } else if (arg === "--cwd" && next) {
      opts.cwd = path.resolve(next);
      i += 1;
    } else if (arg === "--home" && next) {
      opts.home = path.resolve(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: pnpm run doctor:codex-worker-hosts [-- --allow-unreachable]

Syncs configured workerHosts into the blackboard and checks Codex CLI readiness
on local-stdio and ssh-stdio hosts.

The command exits nonzero when any configured host is unreachable unless
--allow-unreachable is passed.

Options:
  --fresh-local           Create a temporary HOME/config with only local host
  --cwd <path>            projectsDir/projectsRoot for --fresh-local
  --home <path>           Use an explicit HOME before loading Flitterbot config`);
}

function writeFreshLocalConfig(home, cwd) {
  const flitterbotDir = path.join(home, ".flitterbot");
  fs.mkdirSync(flitterbotDir, { recursive: true });
  const configPath = path.join(flitterbotDir, "config.json");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        controlSurfaceHost: "127.0.0.1",
        controlSurfacePort: 0,
        controlSurfaceToken: "doctor-token",
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
            projectsRoot: cwd,
            codexHome: process.env.CODEX_HOME || path.join(ORIGINAL_HOME, ".codex"),
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
        projectsDir: cwd,
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let tempHome;
  if (opts.freshLocal) {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-host-doctor-"));
    process.env.HOME = tempHome;
    writeFreshLocalConfig(tempHome, opts.cwd);
  } else if (opts.home) {
    process.env.HOME = opts.home;
  }
  const [{ openBlackboard }, { loadConfig }, { checkConfiguredWorkerHosts }] = await Promise.all([
    import("../src/blackboard/db.ts"),
    import("../src/config/load-config.ts"),
    import("../src/workers/worker-hosts.ts"),
  ]);
  const config = loadConfig();
  const db = openBlackboard(config.blackboardPath);
  try {
    const results = checkConfiguredWorkerHosts(db, config);
    console.log(
      JSON.stringify(
        {
          ok: results.every((result) => result.status === "ready"),
          home: process.env.HOME,
          blackboardPath: config.blackboardPath,
          results,
        },
        null,
        2,
      ),
    );
    if (!opts.allowUnreachable && results.some((result) => result.status !== "ready")) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

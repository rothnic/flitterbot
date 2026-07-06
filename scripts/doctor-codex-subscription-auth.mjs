#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_HOME = os.homedir();

function parseArgs(argv) {
  const opts = { freshLocal: false, cwd: process.cwd(), reportOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--fresh-local") {
      opts.freshLocal = true;
    } else if (arg === "--cwd" && next) {
      opts.cwd = path.resolve(next);
      i += 1;
    } else if (arg === "--home" && next) {
      opts.home = path.resolve(next);
      i += 1;
    } else if (arg === "--report-only") {
      opts.reportOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: pnpm run doctor:codex-subscription-auth [-- --report-only]

Reports the auth state for the Codex subscription migration:
- Codex CLI/app-server auth for coding workers
- Pi provider auth for orchestrator prompts
- Classifier auth path

Options:
  --fresh-local           Create a temporary HOME/config for repeatable checks
  --cwd <path>            projectsDir for --fresh-local
  --home <path>           Use an explicit HOME before loading Flitterbot config
  --report-only           Always exit zero after printing the report`);
}

function writeFreshLocalConfig(home, cwd) {
  const flitterbotDir = path.join(home, ".flitterbot");
  fs.mkdirSync(flitterbotDir, { recursive: true });
  fs.writeFileSync(
    path.join(flitterbotDir, "config.json"),
    `${JSON.stringify(
      {
        controlSurfaceHost: "127.0.0.1",
        controlSurfacePort: 0,
        controlSurfaceToken: "auth-doctor-token",
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
        whatsappAuthDir: "~/.flitterbot/wa-auth",
        whatsappSocketPath: "~/.flitterbot/wa.sock",
        whatsappPidPath: "~/.flitterbot/wa.pid",
        whatsappCliPath: "wa",
        whatsappDaemonPath: "wa-daemon",
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
}

function run(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readJsonShape(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, topLevelKeys: [], providerKeys: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const topLevelKeys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
    const providerKeys =
      parsed?.providers && typeof parsed.providers === "object" ? Object.keys(parsed.providers) : [];
    return { exists: true, topLevelKeys, providerKeys };
  } catch (error) {
    return {
      exists: true,
      topLevelKeys: [],
      providerKeys: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function hasPiProviderAuth(shapes, provider) {
  return shapes.some((shape) => {
    const keys = [...shape.topLevelKeys, ...shape.providerKeys].map((key) => key.toLowerCase());
    return keys.some((key) => key === provider.toLowerCase() || key.includes(provider.toLowerCase()));
  });
}

function defaultModelProvider(config) {
  const configured = config.models.find((model) => model.id === config.defaultModel);
  if (configured) return configured.provider;
  const [provider] = config.defaultModel.split("/", 1);
  return provider || null;
}

function classifierStatus(config, piReady) {
  const classifier = config.classifier;
  if (classifier.provider === "disabled") {
    return {
      provider: classifier.provider,
      ready: true,
      reason: "classifier disabled",
    };
  }
  if (classifier.provider === "pi") {
    return {
      provider: classifier.provider,
      model: classifier.model,
      ready: piReady,
      reason: piReady ? "Pi provider auth present" : "Pi provider auth missing",
    };
  }
  const hasKey = Boolean(process.env[classifier.apiKeyEnv]);
  return {
    provider: classifier.provider,
    model: classifier.model,
    apiKeyEnv: classifier.apiKeyEnv,
    baseURL: classifier.baseURL,
    ready: hasKey,
    reason: hasKey ? "API key env present" : `missing ${classifier.apiKeyEnv}`,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let tempHome;
  if (opts.freshLocal) {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-auth-doctor-"));
    process.env.HOME = tempHome;
    writeFreshLocalConfig(tempHome, opts.cwd);
  } else if (opts.home) {
    process.env.HOME = opts.home;
  }

  const { loadConfig } = await import("../src/config/load-config.ts");
  const config = loadConfig();
  const codexVersion = run("codex", ["--version"]);
  const codexLogin = run("codex", ["login", "status"], {
    env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME || path.join(ORIGINAL_HOME, ".codex") },
  });
  const codexWorkerReady = codexVersion.ok && codexLogin.ok;
  const piAuthPaths = [
    path.join(ORIGINAL_HOME, ".pi", "agent", "auth.json"),
    path.join(config.controlSurfaceAgentDir, "auth.json"),
  ];
  const piAuthFiles = piAuthPaths.map((filePath) => ({
    path: filePath,
    ...readJsonShape(filePath),
  }));
  const orchestratorProvider = defaultModelProvider(config);
  const piProviderReady =
    orchestratorProvider === "openai-codex"
      ? hasPiProviderAuth(piAuthFiles, "openai-codex")
      : true;
  const classifier = classifierStatus(config, piProviderReady);
  const report = {
    ok: codexWorkerReady && piProviderReady && classifier.ready,
    codexWorkers: {
      ready: codexWorkerReady,
      version: codexVersion.stdout,
      loginStatus: codexLogin.stdout,
      codexHome: process.env.CODEX_HOME || path.join(ORIGINAL_HOME, ".codex"),
    },
    piOrchestrator: {
      provider: orchestratorProvider,
      ready: piProviderReady,
      authFiles: piAuthFiles,
      reason: piProviderReady
        ? "Pi provider auth present or default provider does not require openai-codex Pi auth"
        : "Pi openai-codex provider auth is missing; Codex CLI auth does not satisfy Pi provider auth",
    },
    classifier,
    decision: {
      codingWorkers: "Use Codex CLI/app-server auth.",
      orchestrator:
        "Use Pi provider auth for orchestrator prompts; openai-codex needs a Pi-visible provider credential.",
      classifier:
        "Use classifier.provider=pi only after Pi provider auth is present; otherwise use disabled, direct API, or openai-compatible proxy such as 9router.",
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (!opts.reportOnly && !report.ok) process.exitCode = 1;
  if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

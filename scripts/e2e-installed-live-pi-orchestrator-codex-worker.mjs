#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 240_000;
const EXPECTED_WORKER_TEXT = "flitterbot-installed-live-pi-worker-ok";
const TOKEN = "installed-live-pi-e2e-token";

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    profile: "light",
    workerHost: "local",
    keep: false,
    allowMissingPiAuth: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--cwd" && next) {
      opts.cwd = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      opts.timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--profile" && next) {
      opts.profile = next;
      i += 1;
    } else if (arg === "--worker-host" && next) {
      opts.workerHost = next;
      i += 1;
    } else if (arg === "--ssh-target" && next) {
      opts.sshTarget = next;
      i += 1;
    } else if (arg === "--worker-cwd" && next) {
      opts.workerCwd = next;
      i += 1;
    } else if (arg === "--pi-auth-source" && next) {
      opts.piAuthSource = path.resolve(next);
      i += 1;
    } else if (arg === "--allow-missing-pi-auth") {
      opts.allowMissingPiAuth = true;
    } else if (arg === "--keep") {
      opts.keep = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }

  opts.cwd = path.resolve(opts.cwd);
  if (!opts.workerCwd) opts.workerCwd = opts.cwd;
  if (opts.workerHost !== "local" && !opts.sshTarget) {
    throw new Error("--ssh-target is required when --worker-host is not local");
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: pnpm run e2e:installed-live-pi-orchestrator-codex-worker -- [--cwd <path>]

Installs Flitterbot into a temporary HOME, starts the installed flitterbot-up
control surface, creates a stream through HTTP, sends a real prompt through the
Pi orchestrator, and verifies that the orchestrator calls launch_codex_worker so
Codex app-server performs the delegated worker task.

Options:
  --profile <id>              Codex worker profile to request. Default: light
  --worker-host <id>          Worker host id to target. Default: local
  --ssh-target <host>         SSH target for non-local worker host ids
  --worker-cwd <path>         Worker cwd on the target host. Default: --cwd
  --pi-auth-source <path>     Pi auth source to copy into temp control-surface auth
  --timeout-ms <ms>           Completion timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --allow-missing-pi-auth     Exit zero with a skipped report after install/start/stream proof
  --keep                      Keep the temp HOME for inspection`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  fs.chmodSync(filePath, 0o600);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (!port) reject(new Error("Failed to allocate a free port"));
        else resolve(port);
      });
    });
  });
}

function makeFakeInstallProjectRoot(home) {
  const root = path.join(home, "install-project-root");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "web"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"flitterbot-installed-e2e"}\n');
  fs.writeFileSync(path.join(root, "src", "server.ts"), "console.log('install proof only');\n");
  return root;
}

function runInstaller(home, projectRoot, env) {
  execFileSync("node", ["installer/install.mjs", "--yes"], {
    cwd: env.REPO_CWD,
    env: {
      ...process.env,
      HOME: home,
      FLITTERBOT_HOME: path.join(home, ".flitterbot"),
      FLITTERBOT_INSTALL_PROJECT_ROOT: projectRoot,
      CODEX_HOME: env.CODEX_HOME,
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function configureInstalledRuntime(home, opts, originalHome, port) {
  const flitterbotDir = path.join(home, ".flitterbot");
  const configPath = path.join(flitterbotDir, "config.json");
  const config = readJson(configPath);
  const serverPath = path.join(opts.cwd, "src", "server.ts");
  const codexHome = process.env.CODEX_HOME || path.join(originalHome, ".codex");
  const workerHosts = [
    {
      id: "local",
      displayName: "Local machine",
      connectionMode: "local-stdio",
      projectsRoot: opts.cwd,
      codexHome,
      maxConcurrentWorkers: 1,
      capabilities: { role: "local" },
    },
  ];
  if (opts.workerHost !== "local") {
    workerHosts.push({
      id: opts.workerHost,
      displayName: opts.workerHost,
      connectionMode: "ssh-stdio",
      connectionTarget: opts.sshTarget,
      projectsRoot: opts.workerCwd,
      codexHome: "~/.codex",
      maxConcurrentWorkers: 1,
      capabilities: { role: "remote-ssh" },
    });
  }

  Object.assign(config, {
    controlSurfaceHost: "127.0.0.1",
    controlSurfacePort: port,
    controlSurfaceToken: TOKEN,
    controlSurfaceCommand: `cd ${shellQuote(opts.cwd)} && exec ${shellQuote(process.execPath)} --experimental-strip-types ${shellQuote(serverPath)}`,
    projectRoot: opts.cwd,
    sourceRoot: opts.cwd,
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
        developerInstructions:
          "Use this profile for simple proof tasks. Reply exactly when asked for an exact token.",
        skillNames: [],
        skillPaths: [],
      },
    ],
    workerHosts,
    projectsDir: opts.cwd,
    whatsappEnabled: false,
    defaultAgentFirstMessage: "",
    newStreamFirstMessageFooter: "",
    tmuxEnabled: false,
  });
  writeJson(configPath, config);
  return {
    configPath,
    controlSurfaceAgentDir: path.join(flitterbotDir, "control-surface", "agent"),
    flitterbotUp: path.join(flitterbotDir, "bin", "flitterbot-up"),
    pidPath: path.join(flitterbotDir, "control-surface", "server.pid"),
    statePath: path.join(flitterbotDir, "control-surface", "last-start.json"),
    baseUrl: `http://127.0.0.1:${port}`,
    blackboardPath: config.blackboardPath.replace(/^~/, home),
  };
}

function hasProvider(shape, provider) {
  return shape.credentialProviderKeys.some((key) => key.toLowerCase() === provider.toLowerCase());
}

async function preparePiAuth(options, originalHome, controlSurfaceAgentDir) {
  const { readPiAuthFileShape } = await import("../src/pi-auth.ts");
  const source = options.piAuthSource ?? path.join(originalHome, ".pi", "agent", "auth.json");
  const target = path.join(controlSurfaceAgentDir, "auth.json");
  const shape = readPiAuthFileShape(source);
  if (!hasProvider(shape, "openai-codex")) {
    return { ready: false, source, target, error: shape.error };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o600);
  return { ready: true, source, target };
}

function profileIdFromMetadata(metadataJson) {
  if (!metadataJson) return null;
  try {
    const metadata = JSON.parse(metadataJson);
    return typeof metadata?.profile?.id === "string" ? metadata.profile.id : null;
  } catch {
    return null;
  }
}

function startInstalledRuntime(flitterbotUp, env) {
  return execFileSync(flitterbotUp, ["start"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000,
  }).trim();
}

function readManagedPid(install) {
  try {
    if (fs.existsSync(install.pidPath)) {
      const pid = Number(fs.readFileSync(install.pidPath, "utf8").trim());
      if (Number.isFinite(pid)) return pid;
    }
  } catch {}
  try {
    if (fs.existsSync(install.statePath)) {
      const state = readJson(install.statePath);
      if (Number.isFinite(state.pid)) return state.pid;
    }
  } catch {}
  return null;
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForServerDown(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/status`);
      if (!response.ok) return true;
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function stopInstalledRuntime(install) {
  try {
    await requestWithAuth(install.baseUrl, "POST", "/stop");
  } catch {}
  if (await waitForServerDown(install.baseUrl, 10_000)) return;
  const pid = readManagedPid(install);
  if (pid && isPidRunning(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await waitForServerDown(install.baseUrl, 5_000);
  if (pid && isPidRunning(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

async function requestWithAuth(baseUrl, method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { response, json, text };
}

async function requestJson(baseUrl, method, pathname, body) {
  const { response, json, text } = await requestWithAuth(baseUrl, method, pathname, body);
  if (!response.ok) {
    throw new Error(`${method} ${pathname} returned ${response.status}: ${text}`);
  }
  return json;
}

async function waitFor(description, timeoutMs, fn) {
  const startedAt = Date.now();
  let lastValue;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(lastValue)}`);
}

function latest(rows) {
  return rows[rows.length - 1];
}

async function waitForServer(baseUrl, timeoutMs) {
  return waitFor("installed control-surface server readiness", timeoutMs, async () => {
    try {
      const response = await fetch(`${baseUrl}/status`);
      return response.ok ? response : null;
    } catch {
      return null;
    }
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const originalHome = os.homedir();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-installed-live-pi-"));
  const port = await getFreePort();
  const env = {
    ...process.env,
    HOME: tempHome,
    FLITTERBOT_HOME: path.join(tempHome, ".flitterbot"),
    CODEX_HOME: process.env.CODEX_HOME || path.join(originalHome, ".codex"),
    REPO_CWD: opts.cwd,
  };
  process.env.HOME = tempHome;
  process.env.FLITTERBOT_HOME = env.FLITTERBOT_HOME;
  process.env.CODEX_HOME = env.CODEX_HOME;

  let install;
  let started = false;
  try {
    const fakeProjectRoot = makeFakeInstallProjectRoot(tempHome);
    runInstaller(tempHome, fakeProjectRoot, env);
    install = configureInstalledRuntime(tempHome, opts, originalHome, port);
    const piAuth = await preparePiAuth(opts, originalHome, install.controlSurfaceAgentDir);

    const startResult = startInstalledRuntime(install.flitterbotUp, env);
    started = true;
    await waitForServer(install.baseUrl, opts.timeoutMs);
    const stream = await requestJson(install.baseUrl, "POST", "/api/streams", {
      name: `installed-live-pi-e2e-${Date.now().toString(36)}`,
      cwd: opts.cwd,
    });

    if (!piAuth.ready) {
      const report = {
        ok: false,
        skipped: true,
        reason: "Pi openai-codex provider auth is missing",
        installedRuntimeStarted: true,
        startResult,
        tempHome,
        configPath: install.configPath,
        blackboardPath: install.blackboardPath,
        streamId: stream.streamId,
        piSessionId: stream.piSessionId,
        piAuthSource: piAuth.source,
        ...(piAuth.error ? { piAuthError: piAuth.error } : {}),
        requiredAction:
          "Run pnpm exec pi, use /login, select ChatGPT Plus/Pro (Codex), then rerun this E2E.",
      };
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = opts.allowMissingPiAuth ? 0 : 2;
      return;
    }

    await requestJson(install.baseUrl, "POST", "/message", {
      source: "web",
      targetPiSessionId: stream.piSessionId,
      text: [
        "This is a Flitterbot installed-runtime live Pi orchestrator E2E proof.",
        "Call launch_codex_worker exactly once.",
        `Use profile ${opts.profile}.`,
        `Use worker_host ${opts.workerHost}.`,
        `Use cwd ${opts.workerCwd}.`,
        `Give the worker this exact prompt: Reply exactly: ${EXPECTED_WORKER_TEXT}`,
        "Do not answer from memory; the proof requires the Codex worker result.",
      ].join("\n"),
      metadata: {
        stream_id: stream.streamId,
        stream_name: stream.streamName,
        router_action: "matched",
        e2e: "installed-live-pi-orchestrator-codex-worker",
      },
    });

    const [{ openBlackboard }, messages, workers, { loadConfig }] = await Promise.all([
      import("../src/blackboard/db.ts"),
      import("../src/blackboard/query-messages.ts"),
      import("../src/blackboard/query-workers.ts"),
      import("../src/config/load-config.ts"),
    ]);
    const config = loadConfig();

    const workerSession = await waitFor(
      "installed-runtime orchestrator-created Codex worker session",
      opts.timeoutMs,
      () => {
        const db = openBlackboard(config.blackboardPath);
        try {
          const rows = workers.listWorkerSessionsByStream(db, stream.streamId, 10);
          return rows.find((row) => row.runner_type === "codex_app_server") ?? null;
        } finally {
          db.close();
        }
      },
    );

    const completedWorker = await waitFor(
      "installed-runtime orchestrator-created Codex worker completion",
      opts.timeoutMs,
      () => {
        const db = openBlackboard(config.blackboardPath);
        try {
          const row = workers.getWorkerSession(db, workerSession.worker_session_id);
          return row?.status === "completed" ? row : null;
        } finally {
          db.close();
        }
      },
    );

    const db = openBlackboard(config.blackboardPath);
    try {
      const turns = workers.listWorkerTurnsBySession(db, workerSession.worker_session_id);
      const workerSessions = workers
        .listWorkerSessionsByStream(db, stream.streamId, 10)
        .filter((row) => row.runner_type === "codex_app_server");
      assert(workerSessions.length === 1, `expected exactly one Codex worker, got ${workerSessions.length}`);
      assert(
        completedWorker.host_id === opts.workerHost,
        `worker host mismatch: expected ${opts.workerHost}, got ${completedWorker.host_id}`,
      );
      assert(
        completedWorker.cwd === opts.workerCwd,
        `worker cwd mismatch: expected ${opts.workerCwd}, got ${completedWorker.cwd}`,
      );
      assert(
        profileIdFromMetadata(completedWorker.metadata_json) === opts.profile,
        `worker profile mismatch: expected ${opts.profile}, got ${profileIdFromMetadata(completedWorker.metadata_json)}`,
      );
      assert(turns.length > 0, "worker session has no turns");
      assert(
        latest(turns).final_output?.trim() === EXPECTED_WORKER_TEXT,
        `unexpected worker final output: ${latest(turns).final_output}`,
      );
      const routedWorkerMessage = await waitFor("routed worker output message", opts.timeoutMs, () => {
        const rows = messages.getMessagesByWorkstream(db, stream.streamId, 50);
        return rows.find((row) => row.content.includes(EXPECTED_WORKER_TEXT)) ?? null;
      });

      const result = {
        ok: true,
        tempHome,
        configPath: install.configPath,
        blackboardPath: config.blackboardPath,
        streamId: stream.streamId,
        piSessionId: stream.piSessionId,
        workerHost: completedWorker.host_id,
        workerCwd: completedWorker.cwd,
        workerSessionId: completedWorker.worker_session_id,
        threadId: completedWorker.external_thread_id,
        workerTurnId: latest(turns).worker_turn_id,
        routedMessageId: routedWorkerMessage.id,
        routedMessages: messages.getMessagesByWorkstream(db, stream.streamId, 50).length,
      };
      console.log(JSON.stringify(result, null, 2));
    } finally {
      db.close();
    }
  } finally {
    if (install && started) await stopInstalledRuntime(install);
    if (!opts.keep) fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

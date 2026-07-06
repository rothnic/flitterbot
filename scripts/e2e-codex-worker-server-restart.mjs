#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 180_000;
const TOKEN = "server-restart-e2e-token";

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    profile: "light",
    workerHost: "local",
    keep: false,
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
  console.log(`Usage: pnpm run e2e:codex-worker-server-restart -- [--cwd <path>]

Starts the real control-surface server process, launches a Codex worker through
the HTTP worker API, stops the process, starts a second server process against
the same blackboard, then resumes the stored Codex thread through HTTP.

Options:
  --profile <id>       Codex worker profile to use. Default: light
  --worker-host <id>   Worker host id to target. Default: local
  --ssh-target <host>  SSH target for non-local worker host ids
  --worker-cwd <path>  Worker cwd on the target host. Default: --cwd
  --timeout-ms <ms>    Completion timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --keep               Keep the temp HOME for inspection`);
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

function writeFreshConfig(home, options) {
  const workerHosts = [
    {
      id: "local",
      displayName: "Local machine",
      connectionMode: "local-stdio",
      projectsRoot: options.cwd,
      codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      maxConcurrentWorkers: 1,
      capabilities: { role: "local" },
    },
  ];
  if (options.workerHost !== "local") {
    workerHosts.push({
      id: options.workerHost,
      displayName: options.workerHost,
      connectionMode: "ssh-stdio",
      connectionTarget: options.sshTarget,
      projectsRoot: options.workerCwd,
      codexHome: "~/.codex",
      maxConcurrentWorkers: 1,
      capabilities: { role: "remote-ssh" },
    });
  }

  const flitterbotDir = path.join(home, ".flitterbot");
  fs.mkdirSync(flitterbotDir, { recursive: true });
  const configPath = path.join(flitterbotDir, "config.json");
  const config = {
    controlSurfaceHost: "127.0.0.1",
    controlSurfacePort: options.port,
    controlSurfaceToken: TOKEN,
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
        developerInstructions:
          "Use this profile for simple proof tasks. Reply exactly when asked for an exact token.",
        skillNames: [],
        skillPaths: [],
      },
    ],
    workerHosts,
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
    projectsDir: options.cwd,
    wipeStreamsOnStart: false,
    whatsappEnabled: false,
    shortcuts: {},
    defaultAgentFirstMessage: "",
    newStreamFirstMessageFooter: "",
    tmuxEnabled: false,
    extraSkillPaths: [],
    learningsNotePath: "~/.flitterbot/data/notes/learnings.md",
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function spawnServer(env) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/server.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout = `${output.stdout}${chunk.toString()}`.slice(-8000);
  });
  child.stderr.on("data", (chunk) => {
    output.stderr = `${output.stderr}${chunk.toString()}`.slice(-8000);
  });
  return { child, output };
}

async function stopServer(handle) {
  if (handle.child.exitCode !== null || handle.child.signalCode) return;
  handle.child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      handle.child.kill("SIGKILL");
      reject(new Error("server did not stop after SIGTERM"));
    }, 10_000);
    handle.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForServerExit(handle, timeoutMs) {
  if (handle.child.exitCode !== null || handle.child.signalCode) {
    return { code: handle.child.exitCode, signal: handle.child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    handle.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function requestJson(baseUrl, method, pathname, body) {
  const { response, json, text } = await requestWithAuth(baseUrl, method, pathname, body);
  if (!response.ok) {
    throw new Error(`${method} ${pathname} returned ${response.status}: ${text}`);
  }
  return json;
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

async function requestWithoutAuth(baseUrl, method, pathname) {
  return fetch(`${baseUrl}${pathname}`, { method });
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer(baseUrl, handle, timeoutMs) {
  await waitFor("control-surface server readiness", timeoutMs, async () => {
    if (handle.child.exitCode !== null) {
      throw new Error(`server exited early: ${handle.output.stderr || handle.output.stdout}`);
    }
    try {
      const response = await fetch(`${baseUrl}/status`);
      return response.ok ? response : null;
    } catch {
      return null;
    }
  });
}

async function waitForWorkerOutput(baseUrl, workerSessionId, expectedText, timeoutMs) {
  return waitFor(`worker output ${expectedText}`, timeoutMs, async () => {
    const status = await requestJson(
      baseUrl,
      "GET",
      `/api/workers/${encodeURIComponent(workerSessionId)}`,
    );
    const turn = latest(status.turns ?? []);
    return status.session?.status === "completed" && turn?.final_output?.includes(expectedText)
      ? status
      : null;
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const originalHome = os.homedir();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-server-restart-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    HOME: tempHome,
    FLITTERBOT_HOME: tempHome,
    CODEX_HOME: process.env.CODEX_HOME || path.join(originalHome, ".codex"),
  };
  process.env.HOME = tempHome;
  process.env.FLITTERBOT_HOME = tempHome;
  process.env.CODEX_HOME = env.CODEX_HOME;
  const configPath = writeFreshConfig(tempHome, { ...opts, port });
  let firstServer;
  let duplicateServer;
  let secondServer;

  try {
    firstServer = spawnServer(env);
    await waitForServer(baseUrl, firstServer, opts.timeoutMs);
    const unauthorizedLaunch = await requestWithoutAuth(baseUrl, "POST", "/api/workers");
    assert(unauthorizedLaunch.status === 401, "unauthorized worker launch should return 401");
    const oversizedLaunch = await requestWithAuth(baseUrl, "POST", "/api/workers", {
      prompt: "x".repeat(300 * 1024),
    });
    assert(
      oversizedLaunch.response.status === 400,
      `oversized worker launch should return 400, got ${oversizedLaunch.response.status}`,
    );
    assert(
      String(oversizedLaunch.json?.error ?? "").includes("exceeds"),
      `oversized worker launch returned unexpected error: ${oversizedLaunch.text}`,
    );

    const launch = await requestJson(baseUrl, "POST", "/api/workers", {
      profile: opts.profile,
      cwd: opts.workerCwd,
      worker_host: opts.workerHost,
      prompt: "Reply exactly: flitterbot-server-restart-ok",
      context: "This is the process-level Codex worker server restart proof.",
    });
    assert(launch.ok === true, "launch response was not ok");
    await waitForWorkerOutput(
      baseUrl,
      launch.workerSessionId,
      "flitterbot-server-restart-ok",
      opts.timeoutMs,
    );

    const [{ loadConfig }, { openBlackboard }, workers] = await Promise.all([
      import("../src/config/load-config.ts"),
      import("../src/blackboard/db.ts"),
      import("../src/blackboard/query-workers.ts"),
    ]);
    const config = loadConfig();
    const db = openBlackboard(config.blackboardPath);
    let interruptedSessionId;
    let interruptedTurnId;
    try {
      interruptedSessionId = workers.insertWorkerSession(db, {
        runnerType: "codex_app_server",
        status: "running",
        hostId: launch.workerHostId,
        cwd: opts.workerCwd,
        externalThreadId: launch.threadId,
      }).worker_session_id;
      interruptedTurnId = workers.insertWorkerTurn(db, {
        workerSessionId: interruptedSessionId,
        status: "running",
        prompt: "Simulated interrupted worker turn before server process restart.",
      }).worker_turn_id;
    } finally {
      db.close();
    }

    duplicateServer = spawnServer(env);
    const duplicateExit = await waitForServerExit(duplicateServer, 10_000);
    assert(
      duplicateExit.code !== 0,
      `duplicate server should fail the pid guard, got exit ${JSON.stringify(duplicateExit)}`,
    );
    assert(
      duplicateServer.output.stderr.includes("already running"),
      `duplicate server did not report pid guard failure: ${duplicateServer.output.stderr || duplicateServer.output.stdout}`,
    );
    const verifyDuplicateDb = openBlackboard(config.blackboardPath);
    try {
      const duplicateSession = workers.getWorkerSession(verifyDuplicateDb, interruptedSessionId);
      const duplicateTurn = workers.getWorkerTurn(verifyDuplicateDb, interruptedTurnId);
      const duplicateRecoveryEvent = verifyDuplicateDb.get(
        "SELECT event_type FROM worker_events WHERE worker_session_id = ? AND event_type = 'worker/recovery/interrupted' LIMIT 1",
        interruptedSessionId,
      );
      assert(
        duplicateSession?.status === "running",
        `duplicate startup should not reconcile active session before pid guard, got ${duplicateSession?.status}`,
      );
      assert(
        duplicateTurn?.status === "running",
        `duplicate startup should not fail active turn before pid guard, got ${duplicateTurn?.status}`,
      );
      assert(
        !duplicateRecoveryEvent,
        "duplicate startup should not append worker/recovery/interrupted before pid guard",
      );
    } finally {
      verifyDuplicateDb.close();
    }

    await stopServer(firstServer);

    secondServer = spawnServer(env);
    await waitForServer(baseUrl, secondServer, opts.timeoutMs);
    const recovered = await requestJson(
      baseUrl,
      "GET",
      `/api/workers/${encodeURIComponent(launch.workerSessionId)}`,
    );
    assert(recovered.active === false, "second server should not have an active worker handle");
    assert(
      recovered.session?.external_thread_id === launch.threadId,
      "second server did not read the persisted Codex thread id",
    );
    const interruptedRecovered = await requestJson(
      baseUrl,
      "GET",
      `/api/workers/${encodeURIComponent(interruptedSessionId)}`,
    );
    assert(
      interruptedRecovered.session?.status === "unreachable",
      `interrupted worker session should be unreachable after startup reconciliation, got ${interruptedRecovered.session?.status}`,
    );
    assert(
      latest(interruptedRecovered.turns ?? [])?.status === "failed",
      `interrupted worker turn should be failed after startup reconciliation, got ${latest(interruptedRecovered.turns ?? [])?.status}`,
    );

    const verifyInterruptedDb = openBlackboard(config.blackboardPath);
    try {
      const recoveryEvent = verifyInterruptedDb.get(
        "SELECT event_type FROM worker_events WHERE worker_session_id = ? AND event_type = 'worker/recovery/interrupted' LIMIT 1",
        interruptedSessionId,
      );
      assert(
        recoveryEvent?.event_type === "worker/recovery/interrupted",
        "missing worker/recovery/interrupted event",
      );
    } finally {
      verifyInterruptedDb.close();
    }

    const persistedRunningFollowup = await requestWithAuth(
      baseUrl,
      "POST",
      `/api/workers/${encodeURIComponent(interruptedSessionId)}/followup`,
      {
        prompt: "Reply exactly: flitterbot-server-interrupted-recovered-ok",
      },
    );
    assert(
      persistedRunningFollowup.response.status === 200,
      `interrupted follow-up should return 200, got ${persistedRunningFollowup.response.status}: ${persistedRunningFollowup.text}`,
    );
    assert(
      persistedRunningFollowup.json?.threadId === launch.threadId,
      "interrupted follow-up did not resume the stored thread id",
    );
    await waitForWorkerOutput(
      baseUrl,
      interruptedSessionId,
      "flitterbot-server-interrupted-recovered-ok",
      opts.timeoutMs,
    );

    const followup = await requestJson(
      baseUrl,
      "POST",
      `/api/workers/${encodeURIComponent(launch.workerSessionId)}/followup`,
      {
        prompt: "Reply exactly: flitterbot-server-restart-followup-ok",
      },
    );
    assert(followup.ok === true, "follow-up response was not ok");
    assert(followup.threadId === launch.threadId, "follow-up did not resume the stored thread id");
    const finalStatus = await waitForWorkerOutput(
      baseUrl,
      launch.workerSessionId,
      "flitterbot-server-restart-followup-ok",
      opts.timeoutMs,
    );
    const verifyDb = openBlackboard(config.blackboardPath);
    try {
      const resumeEvent = verifyDb.get(
        "SELECT event_type FROM worker_events WHERE worker_session_id = ? AND event_type = 'thread/resume/result' LIMIT 1",
        launch.workerSessionId,
      );
      assert(resumeEvent?.event_type === "thread/resume/result", "missing thread/resume/result event");
    } finally {
      verifyDb.close();
    }

    const result = {
      ok: true,
      tempHome,
      configPath,
      baseUrl,
      blackboardPath: config.blackboardPath,
      workerHost: launch.workerHostId,
      workerCwd: opts.workerCwd,
      workerSessionId: launch.workerSessionId,
      threadId: launch.threadId,
      initialTurnId: launch.workerTurnId,
      followupTurnId: followup.workerTurnId,
      turnCount: finalStatus.turns.length,
      unauthorizedLaunchStatus: unauthorizedLaunch.status,
      oversizedLaunchStatus: oversizedLaunch.response.status,
      duplicateServerExit: duplicateExit,
      interruptedSessionId,
      interruptedTurnId,
      interruptedRecoveryStatus: interruptedRecovered.session.status,
      interruptedTurnRecoveryStatus: latest(interruptedRecovered.turns).status,
      interruptedFollowupStatus: persistedRunningFollowup.response.status,
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (secondServer) await stopServer(secondServer).catch(() => {});
    if (duplicateServer) await stopServer(duplicateServer).catch(() => {});
    if (firstServer) await stopServer(firstServer).catch(() => {});
    if (!opts.keep) fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

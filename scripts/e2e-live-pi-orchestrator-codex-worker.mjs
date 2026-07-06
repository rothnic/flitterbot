#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 240_000;
const EXPECTED_WORKER_TEXT = "flitterbot-live-pi-worker-ok";

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
  console.log(`Usage: pnpm run e2e:live-pi-orchestrator-codex-worker -- [--cwd <path>]

Creates a temporary HOME with a fresh Flitterbot config and blackboard, starts a
real Pi orchestrator session, sends a user prompt through the orchestrator queue,
and verifies that the orchestrator calls launch_codex_worker so Codex app-server
does real coding-worker execution.

Options:
  --profile <id>              Codex worker profile to request. Default: light
  --worker-host <id>          Worker host id to target. Default: local
  --ssh-target <host>         SSH target for non-local worker host ids
  --worker-cwd <path>         Worker cwd on the target host. Default: --cwd
  --pi-auth-source <path>     Pi auth source to copy into temp control-surface auth
  --timeout-ms <ms>           Completion timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --allow-missing-pi-auth     Exit zero with a skipped report if Pi openai-codex auth is absent
  --keep                      Keep the temp HOME for inspection`);
}

function writeFreshConfig(home, options, originalHome) {
  const cwd = options.cwd;
  const workerHosts = [
    {
      id: "local",
      displayName: "Local machine",
      connectionMode: "local-stdio",
      projectsRoot: cwd,
      codexHome: process.env.CODEX_HOME || path.join(originalHome, ".codex"),
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
    controlSurfacePort: 0,
    controlSurfaceToken: "live-pi-e2e-token",
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
    projectsDir: cwd,
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
  return { configPath, controlSurfaceAgentDir: path.join(flitterbotDir, "control-surface", "agent") };
}

function hasProvider(shape, provider) {
  return shape.credentialProviderKeys.some((key) => key.toLowerCase() === provider.toLowerCase());
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const originalHome = os.homedir();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-live-pi-e2e-home-"));
  const { configPath, controlSurfaceAgentDir } = writeFreshConfig(tempHome, opts, originalHome);
  process.env.HOME = tempHome;
  process.env.FLITTERBOT_HOME = tempHome;
  process.env.CODEX_HOME = process.env.CODEX_HOME || path.join(originalHome, ".codex");
  let runtime;
  try {
    const piAuth = await preparePiAuth(opts, originalHome, controlSurfaceAgentDir);

    if (!piAuth.ready) {
      const report = {
        ok: false,
        skipped: true,
        reason: "Pi openai-codex provider auth is missing",
        piAuthSource: piAuth.source,
        ...(piAuth.error ? { piAuthError: piAuth.error } : {}),
        requiredAction:
          "Run pnpm exec pi, use /login, select ChatGPT Plus/Pro (Codex), then rerun this E2E.",
      };
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = opts.allowMissingPiAuth ? 0 : 2;
      return;
    }

    const [{ ControlSurfaceRuntime }, messages, workers, { loadConfig }] = await Promise.all([
      import("../src/runtime.ts"),
      import("../src/blackboard/query-messages.ts"),
      import("../src/blackboard/query-workers.ts"),
      import("../src/config/load-config.ts"),
    ]);

    runtime = new ControlSurfaceRuntime(loadConfig());
    const stream = await runtime.createStreamProgrammatic({
      name: `live-pi-e2e-${Date.now().toString(36)}`,
      cwd: opts.cwd,
    });
    const managed = runtime.sessionManager.getByStream(stream.streamId);
    assert(managed, "stream orchestrator was not registered in session manager");

    managed.queue.enqueue({
      id: `live-pi-e2e-${Date.now().toString(36)}`,
      source: "web",
      sender: "user",
      text: [
        "This is a Flitterbot live Pi orchestrator E2E proof.",
        "Call launch_codex_worker exactly once.",
        `Use profile ${opts.profile}.`,
        `Use worker_host ${opts.workerHost}.`,
        `Use cwd ${opts.workerCwd}.`,
        `Give the worker this exact prompt: Reply exactly: ${EXPECTED_WORKER_TEXT}`,
        "Do not answer from memory; the proof requires the Codex worker result.",
      ].join("\n"),
      receivedAt: new Date().toISOString(),
      streamId: stream.streamId,
      streamName: stream.streamName,
      metadata: {
        stream_id: stream.streamId,
        router_action: "matched",
        e2e: "live-pi-orchestrator-codex-worker",
      },
    });

    const workerSession = await waitFor("orchestrator-created Codex worker session", opts.timeoutMs, () => {
      const rows = workers.listWorkerSessionsByStream(runtime.blackboard, stream.streamId, 10);
      return rows.find((row) => row.runner_type === "codex_app_server") ?? null;
    });

    const completedWorker = await waitFor("orchestrator-created Codex worker completion", opts.timeoutMs, () => {
      const row = workers.getWorkerSession(runtime.blackboard, workerSession.worker_session_id);
      return row?.status === "completed" ? row : null;
    });

    const turns = workers.listWorkerTurnsBySession(runtime.blackboard, workerSession.worker_session_id);
    const workerSessions = workers
      .listWorkerSessionsByStream(runtime.blackboard, stream.streamId, 10)
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
      const rows = messages.getMessagesByWorkstream(runtime.blackboard, stream.streamId, 50);
      return rows.find((row) => row.content.includes(EXPECTED_WORKER_TEXT)) ?? null;
    });

    const result = {
      ok: true,
      tempHome,
      configPath,
      blackboardPath: runtime.config.blackboardPath,
      streamId: stream.streamId,
      piSessionId: stream.piSessionId,
      workerHost: completedWorker.host_id,
      workerCwd: completedWorker.cwd,
      workerSessionId: completedWorker.worker_session_id,
      threadId: completedWorker.external_thread_id,
      workerTurnId: latest(turns).worker_turn_id,
      routedMessageId: routedWorkerMessage.id,
      routedMessages: messages.getMessagesByWorkstream(runtime.blackboard, stream.streamId, 50).length,
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await runtime?.stop("live pi e2e complete");
    if (!opts.keep) fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

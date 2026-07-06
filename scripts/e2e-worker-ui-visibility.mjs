#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--cwd" && next) {
      opts.cwd = path.resolve(next);
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
  opts.cwd = path.resolve(opts.cwd);
  return opts;
}

function printHelp() {
  console.log(`Usage: pnpm run e2e:worker-ui-visibility -- [--cwd <path>]

Creates a temporary Flitterbot runtime, seeds a completed Codex worker session,
calls the browser worker-session API route, and verifies the web side panel
source still renders Codex worker profile, host, thread, and final output fields.`);
}

function writeFreshConfig(home, cwd) {
  const flitterbotDir = path.join(home, ".flitterbot");
  fs.mkdirSync(flitterbotDir, { recursive: true });
  const configPath = path.join(flitterbotDir, "config.json");
  const config = {
    controlSurfaceHost: "127.0.0.1",
    controlSurfacePort: 0,
    controlSurfaceToken: "worker-ui-e2e-token",
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
        codexHome: path.join(os.homedir(), ".codex"),
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
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSourceContains(filePath, patterns) {
  const content = fs.readFileSync(filePath, "utf8");
  for (const pattern of patterns) {
    assert(content.includes(pattern), `${filePath} no longer contains ${pattern}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-worker-ui-e2e-home-"));
  process.env.HOME = tempHome;
  process.env.FLITTERBOT_HOME = tempHome;
  const configPath = writeFreshConfig(tempHome, opts.cwd);

  const [{ ControlSurfaceRuntime }, { createServer }, streams, workers, { loadConfig }] =
    await Promise.all([
    import("../src/runtime.ts"),
    import("../src/server.ts"),
    import("../src/blackboard/query-streams.ts"),
    import("../src/blackboard/query-workers.ts"),
    import("../src/config/load-config.ts"),
  ]);

  const runtime = new ControlSurfaceRuntime(loadConfig());
  const server = createServer(runtime);
  runtime.attachServer(server);
  try {
    const stream = streams.insertStream(runtime.blackboard, "worker-ui-e2e", "work");
    streams.enrichStream(runtime.blackboard, stream.id, opts.cwd);
    workers.upsertWorkerHost(runtime.blackboard, {
      hostId: "local",
      displayName: "Local machine",
      connectionMode: "local-stdio",
      projectsRoot: opts.cwd,
      codexHome: path.join(tempHome, ".codex"),
      maxConcurrentWorkers: 1,
      status: "ready",
      capabilities: { role: "local" },
    });
    const session = workers.insertWorkerSession(runtime.blackboard, {
      runnerType: "codex_app_server",
      status: "completed",
      hostId: "local",
      streamId: stream.id,
      cwd: opts.cwd,
      modelProvider: "openai-codex",
      modelId: "gpt-5.4-mini",
      externalThreadId: "thread-worker-ui-e2e",
      approvalPolicy: "never",
      sandboxPolicy: "workspace-write",
      metadata: {
        profile: {
          id: "light",
          label: "Light coding worker",
          model: "gpt-5.4-mini",
          skillNames: [],
          skillPaths: [],
        },
      },
    });
    const turn = workers.insertWorkerTurn(runtime.blackboard, {
      workerSessionId: session.worker_session_id,
      externalTurnId: "turn-worker-ui-e2e",
      status: "completed",
      prompt: "Reply exactly: worker-ui-ok",
      finalOutput: "worker-ui-ok",
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address === "object", "server did not expose a TCP address");
    const apiUrl = `http://127.0.0.1:${address.port}/api/streams/${encodeURIComponent(stream.id)}/workers`;
    const unauthorized = await fetch(apiUrl);
    assert(unauthorized.status === 401, `unauthorized GET ${apiUrl} returned ${unauthorized.status}`);
    const response = await fetch(apiUrl, {
      headers: { Authorization: "Bearer worker-ui-e2e-token" },
    });
    assert(response.status === 200, `GET ${apiUrl} returned ${response.status}`);
    assert(
      response.headers.get("content-type") === "application/json; charset=utf-8",
      "worker sessions route did not return JSON",
    );
    const body = await response.json();
    assert(Array.isArray(body.items), "worker sessions route did not return items array");
    assert(body.items.length === 1, `expected one worker session, got ${body.items.length}`);
    const item = body.items[0];
    assert(item.workerSessionId === session.worker_session_id, "worker session id mismatch");
    assert(item.runnerType === "codex_app_server", "runner type mismatch");
    assert(item.status === "completed", "worker status mismatch");
    assert(item.hostId === "local", "host id mismatch");
    assert(item.hostDisplayName === "Local machine", "host display name mismatch");
    assert(item.profileId === "light", "profile id mismatch");
    assert(item.modelId === "gpt-5.4-mini", "model id mismatch");
    assert(item.externalThreadId === "thread-worker-ui-e2e", "thread id mismatch");
    assert(item.turns.length === 1, `expected one worker turn, got ${item.turns.length}`);
    assert(item.turns[0].workerTurnId === turn.worker_turn_id, "worker turn id mismatch");
    assert(item.turns[0].finalOutput === "worker-ui-ok", "final output mismatch");

    assertSourceContains(path.join(process.cwd(), "web/src/components/downstream-sessions-panel.tsx"), [
      "Codex Workers",
      "worker.hostDisplayName",
      "worker.externalThreadId",
      "workerLabel(worker)",
      "latestTurn.finalOutput",
    ]);
    assertSourceContains(path.join(process.cwd(), "web/src/components/downstream-sessions-panel.tsx"), [
      "worker.profileId && worker.modelId",
      "worker.profileId ?? worker.modelId",
    ]);
    assertSourceContains(path.join(process.cwd(), "web/src/server/streams.ts"), [
      "fetchWorkerSessions",
      "/api/streams/${encodeURIComponent(data.streamId)}/workers",
    ]);

    console.log(
      JSON.stringify(
        {
          ok: true,
          tempHome,
          configPath,
          blackboardPath: runtime.config.blackboardPath,
          apiUrl,
          unauthorizedStatus: unauthorized.status,
          streamId: stream.id,
          workerSessionId: session.worker_session_id,
          workerTurnId: turn.worker_turn_id,
          apiItems: body.items.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await runtime.stop("worker ui e2e complete");
    if (!opts.keep) fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

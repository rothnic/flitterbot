#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

function assertInOrder(content, patterns, label) {
  let cursor = -1;
  for (const pattern of patterns) {
    const index = content.indexOf(pattern, cursor + 1);
    assert(index !== -1, `${label} does not contain ${pattern} after index ${cursor}`);
    cursor = index;
  }
}

async function importFromWeb(webRoot, specifier) {
  const webRequire = createRequire(path.join(webRoot, "package.json"));
  return import(pathToFileURL(webRequire.resolve(specifier)).href);
}

async function assertRenderedPanelOrder(opts) {
  const webRoot = path.join(opts.cwd, "web");
  const [{ createServer: createViteServer }, React, ReactDomServer] = await Promise.all([
    importFromWeb(webRoot, "vite"),
    importFromWeb(webRoot, "react"),
    importFromWeb(webRoot, "react-dom/server"),
  ]);

  const vite = await createViteServer({
    root: webRoot,
    configFile: path.join(webRoot, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });

  try {
    const [{ DownstreamSessionsPanel }, queries, ReactQuery] = await Promise.all([
      vite.ssrLoadModule("/src/components/downstream-sessions-panel.tsx"),
      vite.ssrLoadModule("/src/lib/queries.ts"),
      vite.ssrLoadModule("@tanstack/react-query"),
    ]);

    const piSessionId = "pi-worker-ui-e2e";
    const streamId = "stream-worker-ui-e2e";
    const queryClient = new ReactQuery.QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    queryClient.setQueryData(queries.streamsWorktreeQueryOptions(piSessionId).queryKey, {
      streamId,
      name: "worker-ui-e2e",
      repoPath: opts.cwd,
      repo: "flitterbot",
      worktreePath: opts.cwd,
      branch: "codex-subscription-e2e",
      baseBranch: "main",
      cwd: opts.cwd,
      cwdAbsolute: opts.cwd,
      copyPaths: [],
      postCreate: [],
      configuredBaseRef: null,
    });
    queryClient.setQueryData(queries.streamsWorkerSessionsQueryOptions(streamId).queryKey, [
      {
        workerSessionId: "worker-ui-session-rendered",
        runnerType: "codex_app_server",
        status: "completed",
        hostId: "local",
        hostDisplayName: "Local machine",
        connectionMode: "local-stdio",
        cwd: opts.cwd,
        repoPath: opts.cwd,
        worktreePath: opts.cwd,
        branch: "codex-subscription-e2e",
        modelProvider: "openai-codex",
        modelId: "gpt-5.4-mini",
        profileId: "light",
        externalThreadId: "thread-worker-ui-e2e",
        externalSessionId: null,
        approvalPolicy: "never",
        sandboxPolicy: "workspace-write",
        startedAt: "2026-07-06T00:00:00.000Z",
        lastEventAt: "2026-07-06T00:00:01.000Z",
        completedAt: "2026-07-06T00:00:01.000Z",
        errorMessage: null,
        turns: [
          {
            workerTurnId: "turn-worker-ui-e2e",
            externalTurnId: "external-turn-worker-ui-e2e",
            status: "completed",
            prompt: "Reply exactly: worker-ui-ok",
            finalOutput: "worker-ui-ok",
            startedAt: "2026-07-06T00:00:00.000Z",
            completedAt: "2026-07-06T00:00:01.000Z",
            errorMessage: null,
          },
        ],
      },
    ]);
    queryClient.setQueryData(queries.streamsDownstreamSessionsQueryOptions(piSessionId).queryKey, [
      {
        sessionId: "legacy-tmux-session-rendered",
        status: "idle",
        streamId,
        streamName: "worker-ui-e2e",
        tmuxSession: "legacy-tmux",
        cwd: opts.cwd,
        taskDescription: "legacy tmux worker",
        project: "flitterbot",
      },
    ]);

    const html = ReactDomServer.renderToString(
      React.createElement(
        ReactQuery.QueryClientProvider,
        { client: queryClient },
        React.createElement(DownstreamSessionsPanel, {
          piSessionId,
          piSessionStatus: "waiting_for_sessions",
        }),
      ),
    );

    assertInOrder(
      html,
      ["Worker Activity", "Codex Workers", "worker-ui-ok", "Legacy Sessions", "legacy-tmux"],
      "rendered side panel",
    );
    assert(
      !html.includes("No Codex workers or legacy sessions."),
      "rendered side panel showed an empty state while worker and legacy sessions existed",
    );

    const emptyPiSessionId = "pi-worker-ui-empty-e2e";
    const emptyQueryClient = new ReactQuery.QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    emptyQueryClient.setQueryData(
      queries.streamsWorktreeQueryOptions(emptyPiSessionId).queryKey,
      {
        streamId: null,
        name: "worker-ui-empty-e2e",
        repoPath: null,
        repo: null,
        worktreePath: null,
        branch: null,
        baseBranch: null,
        cwd: null,
        cwdAbsolute: null,
        copyPaths: [],
        postCreate: [],
        configuredBaseRef: null,
      },
    );
    emptyQueryClient.setQueryData(
      queries.streamsDownstreamSessionsQueryOptions(emptyPiSessionId).queryKey,
      [],
    );
    const emptyHtml = ReactDomServer.renderToString(
      React.createElement(
        ReactQuery.QueryClientProvider,
        { client: emptyQueryClient },
        React.createElement(DownstreamSessionsPanel, {
          piSessionId: emptyPiSessionId,
          piSessionStatus: "waiting_for_sessions",
        }),
      ),
    );
    assertInOrder(
      emptyHtml,
      ["Worker Activity", "No Codex workers or legacy sessions."],
      "rendered no-stream empty side panel",
    );
    assert(
      !emptyHtml.includes("Loading Codex workers"),
      "rendered no-stream empty side panel showed Codex worker loading copy",
    );

    const pendingWorktreePiSessionId = "pi-worker-ui-pending-worktree-e2e";
    const pendingWorktreeQueryClient = new ReactQuery.QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    pendingWorktreeQueryClient.setQueryData(
      queries.streamsDownstreamSessionsQueryOptions(pendingWorktreePiSessionId).queryKey,
      [],
    );
    const pendingWorktreeHtml = ReactDomServer.renderToString(
      React.createElement(
        ReactQuery.QueryClientProvider,
        { client: pendingWorktreeQueryClient },
        React.createElement(DownstreamSessionsPanel, {
          piSessionId: pendingWorktreePiSessionId,
          piSessionStatus: "waiting_for_sessions",
        }),
      ),
    );
    assertInOrder(
      pendingWorktreeHtml,
      ["Worker Activity", "Loading worker context"],
      "rendered pending-worktree side panel",
    );
    assert(
      !pendingWorktreeHtml.includes("No Codex workers or legacy sessions."),
      "rendered pending-worktree side panel showed the empty state before worktree resolved",
    );

    return html.length + emptyHtml.length + pendingWorktreeHtml.length;
  } finally {
    await vite.close();
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
      "Worker Activity",
      "Codex Workers",
      "Legacy Sessions",
      "No Codex workers or legacy sessions.",
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
    const renderedPanelBytes = await assertRenderedPanelOrder(opts);

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
          renderedPanelBytes,
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

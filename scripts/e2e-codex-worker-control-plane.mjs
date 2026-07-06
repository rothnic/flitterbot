#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    profile: "light",
    keep: false,
    includeCancel: true,
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
    } else if (arg === "--keep") {
      opts.keep = true;
    } else if (arg === "--skip-cancel") {
      opts.includeCancel = false;
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
  return opts;
}

function printHelp() {
  console.log(`Usage: pnpm run e2e:codex-worker-control-plane -- [--cwd <path>]

Creates a temporary HOME with a fresh Flitterbot config and blackboard, then
drives the runtime's orchestrator Codex-worker tools against real Codex
app-server auth. This proves the fresh runtime control-plane path without
requiring Pi provider auth for the coding worker.

Options:
  --profile <id>       Codex worker profile to use. Default: light
  --timeout-ms <ms>    Completion timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --skip-cancel        Skip active cancel proof
  --keep               Keep the temp HOME for inspection`);
}

function writeFreshConfig(home, cwd) {
  const flitterbotDir = path.join(home, ".flitterbot");
  fs.mkdirSync(flitterbotDir, { recursive: true });
  const configPath = path.join(flitterbotDir, "config.json");
  const config = {
    controlSurfaceHost: "127.0.0.1",
    controlSurfacePort: 0,
    controlSurfaceToken: "e2e-token",
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
        id: "coding",
        label: "Coding worker",
        model: "gpt-5.5",
        approvalPolicy: "never",
        sandbox: "workspace-write",
        developerInstructions:
          "You are a Flitterbot coding worker. Focus on the delegated task and report concise final output.",
        skillNames: [],
        skillPaths: [],
      },
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

function requireTool(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing runtime tool: ${name}`);
  return tool;
}

async function executeTool(tool, params) {
  const result = await tool.execute(`e2e-${tool.name}`, params);
  if (result.details?.error) {
    const text = result.content?.map((item) => item.text).join("\n") || "tool failed";
    throw new Error(text);
  }
  return result;
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function latest(rows) {
  return rows[rows.length - 1];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const originalHome = os.homedir();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-e2e-home-"));

  process.env.HOME = tempHome;
  process.env.FLITTERBOT_HOME = tempHome;
  process.env.CODEX_HOME = process.env.CODEX_HOME || path.join(originalHome, ".codex");
  const configPath = writeFreshConfig(tempHome, opts.cwd);

  const [{ ControlSurfaceRuntime }, streams, messages, workers, { loadConfig }] = await Promise.all([
    import("../src/runtime.ts"),
    import("../src/blackboard/query-streams.ts"),
    import("../src/blackboard/query-messages.ts"),
    import("../src/blackboard/query-workers.ts"),
    import("../src/config/load-config.ts"),
  ]);

  const runtime = new ControlSurfaceRuntime(loadConfig());
  try {
    const stream = streams.insertStream(
      runtime.blackboard,
      `codex-e2e-${Date.now().toString(36)}`,
      "work",
    );
    streams.enrichStream(runtime.blackboard, stream.id, opts.cwd);

    const tools = runtime.createCustomTools("orchestrator", stream.id);
    const launch = requireTool(tools, "launch_codex_worker");
    const status = requireTool(tools, "get_codex_worker_status");
    const followup = requireTool(tools, "send_codex_worker_followup");
    const cancel = requireTool(tools, "cancel_codex_worker");

    const launchResult = await executeTool(launch, {
      profile: opts.profile,
      cwd: opts.cwd,
      prompt: "Reply exactly: flitterbot-e2e-ok",
      context: "This is the fresh runtime Codex worker control-plane proof.",
    });
    const launched = launchResult.details;
    assert(launched?.workerSessionId, "launch_codex_worker did not return workerSessionId");

    await waitFor("initial Codex worker completion", opts.timeoutMs, () => {
      const session = workers.getWorkerSession(runtime.blackboard, launched.workerSessionId);
      return session?.status === "completed" ? session : null;
    });

    const initialSession = workers.getWorkerSession(runtime.blackboard, launched.workerSessionId);
    const initialTurns = workers.listWorkerTurnsBySession(
      runtime.blackboard,
      launched.workerSessionId,
    );
    assert(initialSession?.stream_id === stream.id, "worker session is not linked to the stream");
    assert(initialSession?.runner_type === "codex_app_server", "worker did not use app-server");
    assert(initialTurns.length === 1, "initial worker should have exactly one turn");
    assert(
      latest(initialTurns).final_output?.trim() === "flitterbot-e2e-ok",
      `unexpected initial final output: ${latest(initialTurns).final_output}`,
    );

    const routedInitial = await waitFor("routed initial worker message", opts.timeoutMs, () => {
      const rows = messages.getMessagesByWorkstream(runtime.blackboard, stream.id, 50);
      return rows.find((row) => row.content.includes("flitterbot-e2e-ok")) ?? null;
    });
    assert(routedInitial.source === "agent", "routed worker message source should be agent");

    const statusResult = await executeTool(status, {
      worker_session_id: launched.workerSessionId,
    });
    assert(statusResult.details?.session?.status === "completed", "status tool did not see completed worker");

    const followupResult = await executeTool(followup, {
      worker_session_id: launched.workerSessionId,
      prompt: "Reply exactly: flitterbot-e2e-followup-ok",
    });
    assert(followupResult.details?.workerTurnId, "follow-up did not return workerTurnId");

    await waitFor("follow-up Codex worker completion", opts.timeoutMs, () => {
      const turns = workers.listWorkerTurnsBySession(runtime.blackboard, launched.workerSessionId);
      const turn = latest(turns);
      return turn?.status === "completed" && turn.final_output?.includes("flitterbot-e2e-followup-ok")
        ? turn
        : null;
    });

    await waitFor("routed follow-up worker message", opts.timeoutMs, () => {
      const rows = messages.getMessagesByWorkstream(runtime.blackboard, stream.id, 50);
      return rows.find((row) => row.content.includes("flitterbot-e2e-followup-ok")) ?? null;
    });

    let cancelProof = null;
    if (opts.includeCancel) {
      const cancelLaunchResult = await executeTool(launch, {
        profile: opts.profile,
        cwd: opts.cwd,
        prompt:
          'Run this shell command first, then reply exactly: flitterbot-e2e-cancel-missed\n\nnode -e "setTimeout(() => {}, 60000)"',
        context: "This worker exists only to prove active cancellation through the runtime tool.",
      });
      const cancelTarget = cancelLaunchResult.details;
      assert(cancelTarget?.workerSessionId, "cancel launch did not return workerSessionId");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const cancelResult = await executeTool(cancel, {
        worker_session_id: cancelTarget.workerSessionId,
      });
      assert(cancelResult.details?.canceled === true, `cancel tool did not cancel: ${JSON.stringify(cancelResult.details)}`);
      const canceledSession = await waitFor("canceled worker state", opts.timeoutMs, () => {
        const session = workers.getWorkerSession(runtime.blackboard, cancelTarget.workerSessionId);
        return session?.status === "canceled" ? session : null;
      });
      const canceledTurns = workers.listWorkerTurnsBySession(
        runtime.blackboard,
        cancelTarget.workerSessionId,
      );
      assert(latest(canceledTurns)?.status === "canceled", "latest canceled worker turn is not canceled");
      await waitFor("canceled worker cleanup", opts.timeoutMs, async () => {
        const activeStatus = await executeTool(status, {
          worker_session_id: cancelTarget.workerSessionId,
        });
        return activeStatus.details?.active === false ? activeStatus.details : null;
      });
      cancelProof = {
        workerSessionId: canceledSession.worker_session_id,
        workerTurnId: latest(canceledTurns).worker_turn_id,
      };
    }

    const eventCountRow = runtime.blackboard.get(
      "SELECT COUNT(*) AS count FROM worker_events WHERE worker_session_id = ?",
      launched.workerSessionId,
    );
    assert((eventCountRow?.count ?? 0) > 0, "worker_events did not record app-server events");

    const finalTurns = workers.listWorkerTurnsBySession(runtime.blackboard, launched.workerSessionId);
    const result = {
      ok: true,
      tempHome,
      configPath,
      blackboardPath: runtime.config.blackboardPath,
      streamId: stream.id,
      workerSessionId: launched.workerSessionId,
      threadId: launched.threadId,
      initialTurnId: initialTurns[0].worker_turn_id,
      followupTurnId: latest(finalTurns).worker_turn_id,
      eventCount: eventCountRow.count,
      routedMessages: messages.getMessagesByWorkstream(runtime.blackboard, stream.id, 50).length,
      cancelProof,
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await runtime.stop("e2e complete");
    if (!opts.keep) fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

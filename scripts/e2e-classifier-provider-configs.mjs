#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeConfig(home, classifier) {
  const flitterbotDir = path.join(home, ".flitterbot");
  fs.mkdirSync(flitterbotDir, { recursive: true });
  const config = {
    controlSurfaceHost: "127.0.0.1",
    controlSurfacePort: 0,
    controlSurfaceToken: "classifier-provider-e2e-token",
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
    classifier,
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
    projectsDir: process.cwd(),
    wipeStreamsOnStart: false,
    whatsappEnabled: false,
    shortcuts: {},
    defaultAgentFirstMessage: "",
    newStreamFirstMessageFooter: "",
    tmuxEnabled: false,
    extraSkillPaths: [],
    learningsNotePath: "~/.flitterbot/data/notes/learnings.md",
  };
  fs.writeFileSync(path.join(flitterbotDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function writePiProviderAuth(home, provider = "openai-codex") {
  const authPath = path.join(home, ".flitterbot", "control-surface", "agent", "auth.json");
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(
    authPath,
    `${JSON.stringify({ providers: { [provider]: { accessToken: "fake-e2e-token" } } }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function runDoctor(home, env = {}) {
  const stdout = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(process.cwd(), "scripts", "doctor-codex-subscription-auth.mjs"),
      "--home",
      home,
      "--report-only",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(stdout);
}

function runCase(name, classifier, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `flitterbot-classifier-${name}-`));
  try {
    writeConfig(home, classifier);
    if (options.piAuth) writePiProviderAuth(home);
    return { home, report: runDoctor(home, options.env) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function main() {
  const disabled = runCase("disabled", {
    provider: "disabled",
    model: "openai/gpt-oss-120b",
    apiKeyEnv: "GROQ_API_KEY",
    maxTokens: 1024,
  }).report;
  assert(disabled.classifier.provider === "disabled", "disabled provider was not reported");
  assert(disabled.classifier.ready === true, "disabled classifier should be ready");
  assert(disabled.classifier.reason === "classifier disabled", "disabled reason mismatch");

  const groqMissing = runCase("groq-missing", {
    provider: "groq",
    model: "openai/gpt-oss-120b",
    apiKeyEnv: "CLASSIFIER_E2E_GROQ_KEY",
    maxTokens: 1024,
  }).report;
  assert(groqMissing.classifier.provider === "groq", "groq provider was not reported");
  assert(groqMissing.classifier.ready === false, "groq without key should not be ready");
  assert(
    groqMissing.classifier.reason === "missing CLASSIFIER_E2E_GROQ_KEY",
    "groq missing-key reason mismatch",
  );

  const groqReady = runCase(
    "groq-ready",
    {
      provider: "groq",
      model: "openai/gpt-oss-120b",
      apiKeyEnv: "CLASSIFIER_E2E_GROQ_KEY",
      maxTokens: 1024,
    },
    { env: { CLASSIFIER_E2E_GROQ_KEY: "fake-groq-key" } },
  ).report;
  assert(groqReady.classifier.ready === true, "groq with key should be ready");
  assert(
    groqReady.classifier.baseURL === "https://api.groq.com/openai/v1",
    "groq should default to the Groq OpenAI-compatible base URL",
  );

  const openaiReady = runCase(
    "openai-ready",
    {
      provider: "openai",
      model: "gpt-4.1",
      apiKeyEnv: "CLASSIFIER_E2E_OPENAI_KEY",
      maxTokens: 256,
    },
    { env: { CLASSIFIER_E2E_OPENAI_KEY: "fake-openai-key" } },
  ).report;
  assert(openaiReady.classifier.provider === "openai", "openai provider was not reported");
  assert(openaiReady.classifier.model === "gpt-4.1", "openai model mismatch");
  assert(openaiReady.classifier.ready === true, "openai with key should be ready");
  assert(openaiReady.classifier.baseURL === undefined, "openai provider should not require baseURL");

  const compatibleReady = runCase(
    "openai-compatible-ready",
    {
      provider: "openai-compatible",
      model: "openai-codex/gpt-5.4-mini",
      apiKeyEnv: "CLASSIFIER_E2E_9ROUTER_KEY",
      baseURL: "https://example.9router.invalid/v1",
      maxTokens: 512,
    },
    { env: { CLASSIFIER_E2E_9ROUTER_KEY: "fake-9router-key" } },
  ).report;
  assert(
    compatibleReady.classifier.provider === "openai-compatible",
    "openai-compatible provider was not reported",
  );
  assert(compatibleReady.classifier.ready === true, "openai-compatible with key should be ready");
  assert(
    compatibleReady.classifier.baseURL === "https://example.9router.invalid/v1",
    "openai-compatible baseURL mismatch",
  );

  const piMissing = runCase("pi-missing", {
    provider: "pi",
    model: "codex",
    apiKeyEnv: "IGNORED_FOR_PI",
    maxTokens: 1024,
  }).report;
  assert(piMissing.classifier.provider === "pi", "pi provider was not reported");
  assert(piMissing.classifier.ready === false, "pi classifier should require Pi provider auth");
  assert(piMissing.classifier.reason === "Pi provider auth missing", "pi missing reason mismatch");

  const piReady = runCase(
    "pi-ready",
    {
      provider: "pi",
      model: "codex",
      apiKeyEnv: "IGNORED_FOR_PI",
      maxTokens: 1024,
    },
    { piAuth: true },
  ).report;
  assert(piReady.piOrchestrator.ready === true, "fake Pi auth should satisfy orchestrator doctor");
  assert(piReady.classifier.ready === true, "pi classifier should be ready when Pi auth is present");
  assert(piReady.classifier.reason === "Pi provider auth present", "pi ready reason mismatch");

  console.log(
    JSON.stringify(
      {
        ok: true,
        cases: {
          disabled: disabled.classifier,
          groqMissing: groqMissing.classifier,
          groqReady: groqReady.classifier,
          openaiReady: openaiReady.classifier,
          openaiCompatibleReady: compatibleReady.classifier,
          piMissing: piMissing.classifier,
          piReady: piReady.classifier,
        },
      },
      null,
      2,
    ),
  );
}

main();

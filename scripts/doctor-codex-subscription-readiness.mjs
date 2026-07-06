#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    strict: false,
    fullLocalWorker: false,
    livePiHarness: false,
    audit: false,
    webBuild: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--cwd" && next) {
      opts.cwd = path.resolve(next);
      i += 1;
    } else if (arg === "--strict") {
      opts.strict = true;
    } else if (arg === "--full-local-worker") {
      opts.fullLocalWorker = true;
    } else if (arg === "--live-pi-harness") {
      opts.livePiHarness = true;
    } else if (arg === "--audit") {
      opts.audit = true;
    } else if (arg === "--web-build") {
      opts.webBuild = true;
    } else if (arg === "--timeout-ms" && next) {
      opts.timeoutMs = Number(next);
      i += 1;
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
  return opts;
}

function printHelp() {
  console.log(`Usage: pnpm run doctor:codex-subscription-readiness -- [options]

Runs the Codex-subscription readiness checks and prints one JSON report.
Default mode runs repeatable local checks and records the known Pi provider-auth
gate without failing. Use --strict after Pi /login to require the full live Pi
orchestrator proof.

Options:
  --cwd <path>             Project cwd for runtime proofs. Default: current dir
  --strict                 Fail when the full live Pi subscription proof is not ready
  --full-local-worker      Run the real local Codex worker control-plane E2E
  --live-pi-harness        Run the live Pi harness in report mode
  --audit                  Run pnpm run audit
  --web-build              Run pnpm --dir web run build
  --timeout-ms <ms>        Timeout for full local worker E2E. Default: ${DEFAULT_TIMEOUT_MS}`);
}

function runStep(name, command, args, options = {}) {
  const startedAt = Date.now();
  try {
    const stdout = execFileSync(command, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
    return {
      name,
      ok: true,
      durationMs: Date.now() - startedAt,
      stdout,
      parsed: parseJson(stdout),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      stdoutPreview: preview(typeof error?.stdout === "string" ? error.stdout : undefined),
      stderrPreview: preview(typeof error?.stderr === "string" ? error.stderr : undefined),
      parsed: parseJson(typeof error?.stdout === "string" ? error.stdout : ""),
    };
  }
}

function parseJson(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

function preview(value) {
  if (!value) return undefined;
  return value.trim().slice(0, 4000);
}

function compactStep(step) {
  return {
    name: step.name,
    ok: step.ok,
    durationMs: step.durationMs,
    ...(step.parsed ? { parsed: step.parsed } : {}),
    ...(!step.ok
      ? {
          error: step.error,
          stdoutPreview: step.stdoutPreview,
          stderrPreview: step.stderrPreview,
        }
      : {}),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const node = process.execPath;
  const steps = [];

  steps.push(
    runStep("auth", node, [
      "--experimental-strip-types",
      "scripts/doctor-codex-subscription-auth.mjs",
      "--fresh-local",
      "--cwd",
      opts.cwd,
      "--report-only",
    ]),
  );
  steps.push(runStep("classifierProviderConfigs", node, ["scripts/e2e-classifier-provider-configs.mjs"]));
  steps.push(runStep("codexFirstInstallDefaults", node, ["scripts/e2e-codex-first-install-defaults.mjs"]));
  steps.push(runStep("workerHostConfigure", node, ["scripts/e2e-worker-host-configure.mjs"]));
  steps.push(
    runStep("workerHostScheduler", node, [
      "--experimental-strip-types",
      "scripts/e2e-codex-worker-host-scheduler.mjs",
    ]),
  );
  steps.push(
    runStep("workerUiVisibility", node, [
      "--experimental-strip-types",
      "scripts/e2e-worker-ui-visibility.mjs",
      "--cwd",
      opts.cwd,
    ]),
  );
  if (opts.strict || opts.livePiHarness) {
    const livePiArgs = [
      "--experimental-strip-types",
      "scripts/e2e-live-pi-orchestrator-codex-worker.mjs",
      "--cwd",
      opts.cwd,
    ];
    if (!opts.strict) livePiArgs.push("--allow-missing-pi-auth");
    steps.push(runStep("livePiHarness", node, livePiArgs));
  }

  if (opts.fullLocalWorker) {
    steps.push(
      runStep("fullLocalWorker", node, [
        "--experimental-strip-types",
        "scripts/e2e-codex-worker-control-plane.mjs",
        "--cwd",
        opts.cwd,
        "--timeout-ms",
        String(opts.timeoutMs),
        "--omit-worker-host",
      ]),
    );
  }
  if (opts.webBuild) {
    steps.push(runStep("webBuild", "pnpm", ["--dir", "web", "run", "build"]));
  }
  if (opts.audit) {
    steps.push(runStep("audit", "pnpm", ["run", "audit"]));
  }

  const auth = steps.find((step) => step.name === "auth")?.parsed;
  const livePi = steps.find((step) => step.name === "livePiHarness")?.parsed;
  const repeatableChecksOk = steps.every((step) => step.ok);
  const codexWorkersReady = auth?.codexWorkers?.ready === true;
  const piOrchestratorReady = auth?.piOrchestrator?.ready === true;
  const fullLivePiReady = livePi?.ok === true && livePi?.skipped !== true;
  const strictOk = repeatableChecksOk && codexWorkersReady && piOrchestratorReady && fullLivePiReady;
  const reportOk = repeatableChecksOk && codexWorkersReady;
  const nextAction = !codexWorkersReady
    ? "Install Codex CLI and run codex login so Codex app-server workers can authenticate."
    : !piOrchestratorReady
      ? "Run pnpm exec pi, use /login, select ChatGPT Plus/Pro (Codex), then rerun this doctor with --strict."
      : !fullLivePiReady
        ? "Run this doctor with --strict to execute the full live Pi orchestrator proof."
        : "All Codex subscription readiness gates passed.";

  const report = {
    ok: opts.strict ? strictOk : reportOk,
    mode: opts.strict ? "strict" : "report",
    cwd: opts.cwd,
    repeatableChecksOk,
    codexWorkersReady,
    piOrchestratorReady,
    fullLivePiReady,
    nextAction,
    steps: steps.map(compactStep),
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main();

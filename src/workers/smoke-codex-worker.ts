import { openBlackboard } from "../blackboard/db.ts";
import { type CodexWorkerProfile, loadConfig } from "../config/load-config.ts";
import { resolveCodexWorkerProfile } from "./codex-worker-profiles.ts";
import { runCodexWorkerSmoke } from "./codex-worker-smoke.ts";

type CliOptions = {
  dbPath: string;
  cwd: string;
  prompt?: string;
  timeoutMs?: number;
  profileId?: string;
  model?: string;
  developerInstructions?: string;
  context?: string;
  skillNames: string[];
};

function parseArgs(argv: string[]): CliOptions {
  let dbPath = "";
  let cwd = process.cwd();
  let prompt: string | undefined;
  let timeoutMs: number | undefined;
  let profileId: string | undefined;
  let model: string | undefined;
  let developerInstructions: string | undefined;
  let context: string | undefined;
  const skillNames: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
    } else if (arg === "--db" && next) {
      dbPath = next;
      i += 1;
    } else if (arg === "--cwd" && next) {
      cwd = next;
      i += 1;
    } else if (arg === "--prompt" && next) {
      prompt = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--profile" && next) {
      profileId = next;
      i += 1;
    } else if (arg === "--model" && next) {
      model = next;
      i += 1;
    } else if (arg === "--developer-instructions" && next) {
      developerInstructions = next;
      i += 1;
    } else if (arg === "--context" && next) {
      context = next;
      i += 1;
    } else if (arg === "--skill" && next) {
      skillNames.push(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!dbPath) throw new Error("Missing required --db <path>");
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("--timeout-ms must be a positive number");
  }

  return {
    dbPath,
    cwd,
    prompt,
    timeoutMs,
    profileId,
    model,
    developerInstructions,
    context,
    skillNames,
  };
}

function printHelp(): void {
  console.log(`Usage: pnpm run smoke:codex-worker -- --db <path> [--cwd <path>]

Runs one local Codex app-server smoke prompt and persists the worker lifecycle
to the Flitterbot blackboard worker tables.

Options:
  --profile <id>                  Load a Codex worker profile from config.json
  --model <model>                 Override the profile/default Codex model
  --developer-instructions <text> Inject extra app-server developer instructions
  --context <text>                Inject extra profile context
  --skill <name>                  Add a requested Codex skill hint`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  let profile: CodexWorkerProfile | undefined;
  if (opts.profileId) {
    profile = resolveCodexWorkerProfile(loadConfig(), opts.profileId);
  }
  const db = openBlackboard(opts.dbPath);
  try {
    const result = await runCodexWorkerSmoke({
      db,
      cwd: opts.cwd,
      prompt: opts.prompt,
      timeoutMs: opts.timeoutMs,
      profile,
      model: opts.model,
      developerInstructions: opts.developerInstructions,
      context: opts.context,
      skillNames: opts.skillNames,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

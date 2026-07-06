#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { refreshOpenAICodexToken } from "@earendil-works/pi-ai/oauth";

const PROVIDER = "openai-codex";

function parseArgs(argv) {
  const opts = {
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    target: "global-pi",
    yes: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--codex-home" && next) {
      opts.codexHome = path.resolve(next);
      i += 1;
    } else if (arg === "--target" && next) {
      opts.target = next;
      i += 1;
    } else if (arg === "--target-path" && next) {
      opts.target = path.resolve(next);
      i += 1;
    } else if (arg === "--home" && next) {
      opts.home = path.resolve(next);
      i += 1;
    } else if (arg === "--yes") {
      opts.yes = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!["global-pi", "control-surface"].includes(opts.target) && !path.isAbsolute(opts.target)) {
    throw new Error("--target must be global-pi, control-surface, or use --target-path <path>");
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: pnpm run auth:import-codex-to-pi -- --yes [options]

Imports the local Codex CLI ChatGPT subscription OAuth credential into Pi's
openai-codex provider auth format. This lets Pi orchestrator prompts use the
same subscription-backed OpenAI/Codex account that Codex app-server workers use.

No credential values are printed.

Options:
  --yes                    Required unless --dry-run is used
  --dry-run                Inspect Codex/Pi auth shape but do not refresh or write
  --codex-home <path>      Codex credential home. Default: CODEX_HOME or ~/.codex
  --target global-pi       Write ~/.pi/agent/auth.json. Default
  --target control-surface Write ~/.flitterbot/control-surface/agent/auth.json
  --target-path <path>     Write an explicit Pi auth.json path
  --home <path>            HOME to use before loading Flitterbot config`);
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a JSON object`);
  }
  return parsed;
}

async function resolveTargetPath(opts) {
  if (opts.home) {
    process.env.HOME = opts.home;
    process.env.FLITTERBOT_HOME = path.join(opts.home, ".flitterbot");
  }
  if (opts.target === "global-pi") {
    return path.join(os.homedir(), ".pi", "agent", "auth.json");
  }
  if (opts.target === "control-surface") {
    const { loadConfig } = await import("../src/config/load-config.ts");
    return path.join(loadConfig().controlSurfaceAgentDir, "auth.json");
  }
  return opts.target;
}

function mockRefreshResult() {
  const raw = process.env.FLITTERBOT_CODEX_TO_PI_MOCK_REFRESH_JSON;
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.access !== "string" ||
    typeof parsed.refresh !== "string" ||
    typeof parsed.expires !== "number"
  ) {
    throw new Error("FLITTERBOT_CODEX_TO_PI_MOCK_REFRESH_JSON must include access, refresh, and expires");
  }
  return parsed;
}

async function refreshCredential(refreshToken) {
  const mocked = mockRefreshResult();
  if (mocked) return mocked;
  try {
    return await refreshOpenAICodexToken(refreshToken);
  } catch {
    throw new Error(
      "Failed to refresh Codex OAuth token for Pi import. Re-run codex login or use pnpm exec pi /login.",
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.yes && !opts.dryRun) {
    console.error("Refusing to write Pi auth without --yes. Use --dry-run to validate only.");
    process.exit(2);
  }

  const codexAuthPath = path.join(opts.codexHome, "auth.json");
  const codexAuth = readJsonObject(codexAuthPath);
  const refreshToken = codexAuth.tokens?.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error(`No Codex CLI refresh token found at ${codexAuthPath}`);
  }

  const targetPath = await resolveTargetPath(opts);
  const existing = readJsonObject(targetPath);
  const existingProviders = Object.keys(existing);
  const overwroteProvider = Object.prototype.hasOwnProperty.call(existing, PROVIDER);
  let refreshed = null;

  if (!opts.dryRun) {
    refreshed = await refreshCredential(refreshToken);
    const credential = { type: "oauth", ...refreshed };
    AuthStorage.create(targetPath).set(PROVIDER, credential);
  }

  const { readPiAuthFileShape } = await import("../src/pi-auth.ts");
  const shape = opts.dryRun
    ? {
        credentialProviderKeys: [...new Set([...Object.keys(existing), PROVIDER])],
        hasCredentials: true,
      }
    : readPiAuthFileShape(targetPath);
  const providerReady = shape.credentialProviderKeys.some(
    (key) => key.toLowerCase() === PROVIDER,
  );

  console.log(
    JSON.stringify(
      {
        ok: providerReady,
        dryRun: opts.dryRun,
        provider: PROVIDER,
        codexAuthPath,
        targetPath,
        wrote: !opts.dryRun,
        refreshed: !opts.dryRun,
        existingProviders,
        overwroteProvider,
        ...(refreshed
          ? {
              expiresAt: new Date(refreshed.expires).toISOString(),
              expiresInMinutes: Math.round((refreshed.expires - Date.now()) / 60000),
            }
          : {}),
        targetShape: {
          credentialProviderKeys: shape.credentialProviderKeys,
          hasCredentials: shape.hasCredentials,
        },
      },
      null,
      2,
    ),
  );

  if (!providerReady) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

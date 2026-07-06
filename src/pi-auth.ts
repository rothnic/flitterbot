import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();
const PROVIDERS_KEY = "providers";

export type PiAuthFileShape = {
  exists: boolean;
  topLevelKeys: string[];
  providerKeys: string[];
  credentialProviderKeys: string[];
  hasCredentials: boolean;
  error?: string;
};

function readJsonObject(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function isCredentialLike(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).length > 0;
}

export function readPiAuthFileShape(filePath: string): PiAuthFileShape {
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      topLevelKeys: [],
      providerKeys: [],
      credentialProviderKeys: [],
      hasCredentials: false,
    };
  }

  try {
    const parsed = readJsonObject(filePath) ?? {};
    const topLevelKeys = Object.keys(parsed);
    const providerKeys =
      parsed[PROVIDERS_KEY] && typeof parsed[PROVIDERS_KEY] === "object"
        ? Object.keys(parsed[PROVIDERS_KEY] as Record<string, unknown>)
        : [];
    const credentialProviderKeys = [
      ...topLevelKeys.filter((key) => key !== PROVIDERS_KEY && isCredentialLike(parsed[key])),
      ...providerKeys.filter((key) =>
        isCredentialLike((parsed[PROVIDERS_KEY] as Record<string, unknown> | undefined)?.[key]),
      ),
    ];

    return {
      exists: true,
      topLevelKeys,
      providerKeys,
      credentialProviderKeys,
      hasCredentials: credentialProviderKeys.length > 0,
    };
  } catch (error) {
    return {
      exists: true,
      topLevelKeys: [],
      providerKeys: [],
      credentialProviderKeys: [],
      hasCredentials: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function hasPiProviderAuth(filePath: string, provider: string): boolean {
  const shape = readPiAuthFileShape(filePath);
  const normalizedProvider = provider.toLowerCase();
  return shape.credentialProviderKeys.some((key) => key.toLowerCase() === normalizedProvider);
}

function providerList(providers?: string | string[]): string[] {
  if (!providers) return [];
  return (Array.isArray(providers) ? providers : [providers]).filter(Boolean);
}

function hasAnyProvider(filePath: string, providers: string[]): boolean {
  if (providers.length === 0) return false;
  const shape = readPiAuthFileShape(filePath);
  const credentialProviderKeys = new Set(
    shape.credentialProviderKeys.map((key) => key.toLowerCase()),
  );
  return providers.some((provider) => credentialProviderKeys.has(provider.toLowerCase()));
}

export function selectPiAuthPath(
  controlSurfaceAgentDir: string,
  piAuthPath = path.join(HOME, ".pi", "agent", "auth.json"),
  providers?: string | string[],
): string {
  const controlSurfaceAuthPath = path.join(controlSurfaceAgentDir, "auth.json");
  const targetProviders = providerList(providers);
  if (hasAnyProvider(controlSurfaceAuthPath, targetProviders)) return controlSurfaceAuthPath;
  if (hasAnyProvider(piAuthPath, targetProviders)) return piAuthPath;
  if (readPiAuthFileShape(controlSurfaceAuthPath).hasCredentials) return controlSurfaceAuthPath;
  if (readPiAuthFileShape(piAuthPath).hasCredentials) return piAuthPath;
  return controlSurfaceAuthPath;
}

export function resolvePiAuthPath(
  controlSurfaceAgentDir: string,
  providers?: string | string[],
): string {
  return selectPiAuthPath(controlSurfaceAgentDir, undefined, providers);
}

export function resolvePiModelsPath(controlSurfaceAgentDir: string): string {
  const controlSurfaceModelsPath = path.join(controlSurfaceAgentDir, "models.json");
  const piModelsPath = path.join(HOME, ".pi", "agent", "models.json");
  if (fs.existsSync(controlSurfaceModelsPath)) return controlSurfaceModelsPath;
  if (fs.existsSync(piModelsPath)) return piModelsPath;
  return controlSurfaceModelsPath;
}

export function createPiAuthStorage(
  controlSurfaceAgentDir: string,
  providers?: string | string[],
): AuthStorage {
  return AuthStorage.create(resolvePiAuthPath(controlSurfaceAgentDir, providers));
}

export function createPiModelRegistry(
  authStorage: AuthStorage,
  controlSurfaceAgentDir: string,
): ModelRegistry {
  return ModelRegistry.create(authStorage, resolvePiModelsPath(controlSurfaceAgentDir));
}

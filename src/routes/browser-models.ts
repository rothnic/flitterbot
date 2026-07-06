import type http from "node:http";
import {
  type Api,
  getSupportedThinkingLevels,
  type KnownProvider,
  type Model,
} from "@earendil-works/pi-ai";
import {
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import type { ModelConfigEntry } from "../config/load-config.ts";
import { persistModelsToConfigFile } from "../config/persist-models.ts";
import type {
  ModelListItem,
  ModelsListResponse,
  ModelsMutationResponse,
} from "../contracts/index.ts";
import { createPiAuthStorage } from "../pi-auth.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

export async function handleBrowserModelsRoute(
  runtime: ControlSurfaceRuntime,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  return sendJson(res, 200, await buildModelsListResponse(runtime));
}

export async function handleBrowserModelsPinRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }
  const body = await readJsonBody<{ id: unknown; pin: unknown; label?: unknown }>(req);
  if (typeof body.id !== "string" || !body.id.trim()) {
    return sendJson(res, 400, { ok: false, error: "id (string) is required" });
  }
  if (typeof body.pin !== "boolean") {
    return sendJson(res, 400, { ok: false, error: "pin (boolean) is required" });
  }
  const id = body.id.trim();
  const userLabel = typeof body.label === "string" ? body.label.trim() : "";

  const current = runtime.config.models;
  let nextList: ModelConfigEntry[];

  if (body.pin) {
    if (current.some((m) => m.id === id)) {
      return sendJson(res, 200, await buildModelsMutationResponse(runtime));
    }
    const entry = buildEntryFromId(id, userLabel, current);
    if (!entry) {
      return sendJson(res, 400, {
        ok: false,
        error: `Cannot pin "${id}" — not a valid curated id or provider/modelId pair`,
      });
    }
    nextList = [...current, entry];
  } else {
    nextList = current.filter((m) => m.id !== id);
    if (nextList.length === current.length) {
      return sendJson(res, 200, await buildModelsMutationResponse(runtime));
    }
    if (nextList.length === 0) {
      return sendJson(res, 400, {
        ok: false,
        error: "Cannot unpin the last model — keep at least one pinned entry",
      });
    }
  }

  let nextDefault = runtime.config.defaultModel;
  if (!body.pin && runtime.config.defaultModel === id && !id.includes("/")) {
    nextDefault = nextList[0]!.id;
  }

  runtime.config.models = nextList;
  runtime.config.defaultModel = nextDefault;
  persistModelsToConfigFile({ models: nextList, defaultModel: nextDefault });
  runtime.log(
    `models: ${body.pin ? "pinned" : "unpinned"} id=${id}; total=${nextList.length}; default=${nextDefault}`,
  );

  return sendJson(res, 200, await buildModelsMutationResponse(runtime));
}

export async function buildModelsListResponse(
  runtime: ControlSurfaceRuntime,
): Promise<ModelsListResponse> {
  const availabilityByProvider = await resolveProviderAvailability(runtime);
  const pinned = runtime.config.models.map((entry) =>
    buildPinnedModelItem(entry, availabilityByProvider),
  );
  const pinnedCatalogKeys = new Set(pinned.map((entry) => `${entry.provider}/${entry.modelId}`));
  const all: ModelListItem[] = [];

  for (const provider of getBuiltinProviders()) {
    const authKind = availabilityByProvider.get(provider) ?? "none";
    for (const model of getBuiltinModels(provider)) {
      if (pinnedCatalogKeys.has(`${provider}/${model.id}`)) continue;
      all.push({
        id: `${provider}/${model.id}`,
        label: model.name,
        provider,
        modelId: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        ...modelThinkingCapabilities(model),
        available: authKind !== "none",
        authKind,
      });
    }
  }

  return {
    pinned,
    all,
    defaultModel: runtime.config.defaultModel,
    defaultThinkingLevel: runtime.config.defaultThinkingLevel,
  };
}

export async function buildModelsMutationResponse(
  runtime: ControlSurfaceRuntime,
): Promise<ModelsMutationResponse> {
  return {
    ok: true,
    ...(await buildModelsListResponse(runtime)),
  };
}

function buildPinnedModelItem(
  entry: ModelConfigEntry,
  availabilityByProvider: Map<string, ModelListItem["authKind"]>,
): ModelListItem {
  const catalogModel = getBuiltinModel(entry.provider as KnownProvider, entry.modelId as never);
  const authKind = availabilityByProvider.get(entry.provider) ?? "none";
  return {
    id: entry.id,
    label: entry.label,
    provider: entry.provider,
    modelId: entry.modelId,
    ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
    ...(catalogModel ? modelThinkingCapabilities(catalogModel) : {}),
    available: authKind !== "none",
    authKind,
  };
}

function modelThinkingCapabilities(model: Model<Api>) {
  return {
    reasoning: Boolean(model.reasoning),
    supportsXhigh: getSupportedThinkingLevels(model).includes("xhigh"),
  };
}

async function resolveProviderAvailability(
  runtime: ControlSurfaceRuntime,
): Promise<Map<string, ModelListItem["authKind"]>> {
  const providers = new Set([
    ...getBuiltinProviders(),
    ...runtime.config.models.map((model) => model.provider),
  ]);
  const entries = await Promise.all(
    [...providers].map(async (provider) => {
      const authStorage = createPiAuthStorage(runtime.config.controlSurfaceAgentDir, provider);
      const apiKey = await authStorage.getApiKey(provider);
      const credential = authStorage.get(provider);
      const authKind: ModelListItem["authKind"] = apiKey
        ? credential?.type === "oauth"
          ? "subscription"
          : "api_key"
        : "none";
      return [provider, authKind] as const;
    }),
  );
  return new Map(entries);
}

function buildEntryFromId(
  id: string,
  userLabel: string,
  existing: ModelConfigEntry[],
): ModelConfigEntry | null {
  const existingMatch = existing.find((m) => m.id === id);
  if (existingMatch) return existingMatch;

  const slashIdx = id.indexOf("/");
  if (slashIdx <= 0 || slashIdx === id.length - 1) return null;
  const provider = id.slice(0, slashIdx);
  const rawModelId = id.slice(slashIdx + 1);
  const model = getBuiltinModel(provider as KnownProvider, rawModelId as never);
  if (!model) return null;

  return {
    id,
    label: userLabel || model.name,
    provider,
    modelId: rawModelId,
  };
}

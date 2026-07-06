import type { KnownProvider } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { FlitterbotConfig, ModelConfigEntry } from "./load-config.ts";

export function resolveModelEntry(
  config: Pick<FlitterbotConfig, "models" | "defaultModel">,
  modelId?: string,
): ModelConfigEntry {
  if (modelId) {
    const curated = config.models.find((m) => m.id === modelId);
    if (curated) return curated;
    const fromCatalog = resolveCompositeId(modelId);
    if (fromCatalog) return fromCatalog;
    throw new Error(
      `Unknown model id "${modelId}" — not in config.models and not a valid provider/modelId pair in the pi SDK catalog`,
    );
  }
  const fallback =
    config.models.find((m) => m.id === config.defaultModel) ??
    resolveCompositeId(config.defaultModel);
  if (fallback) return fallback;
  throw new Error(
    `Config invariant violated: defaultModel "${config.defaultModel}" is neither in models[] nor a valid provider/modelId pair`,
  );
}

function resolveCompositeId(compositeId: string): ModelConfigEntry | null {
  const slashIdx = compositeId.indexOf("/");
  if (slashIdx <= 0 || slashIdx === compositeId.length - 1) return null;
  const provider = compositeId.slice(0, slashIdx);
  const rawModelId = compositeId.slice(slashIdx + 1);
  const model = getBuiltinModel(provider as KnownProvider, rawModelId as never);
  if (!model) return null;
  return {
    id: compositeId,
    label: `${model.name} (${provider})`,
    provider,
    modelId: rawModelId,
  };
}

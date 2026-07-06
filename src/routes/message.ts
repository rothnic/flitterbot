import type http from "node:http";
import { getActivePiSessionId, getStreamByName } from "../blackboard/query-streams.ts";
import { classifyMessage } from "../classifier/classify.ts";
import { resolveClassifierApiKey } from "../classifier/groq-client.ts";
import type {
  DeliveryMode,
  MessageMetadata,
  MessageRequest,
  MessageResponse,
  MessageSource,
  StreamRoutingMeta,
} from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { loadWhatsAppConfig } from "../whatsapp/config.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

export async function handleMessageRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  const body = await readJsonBody<MessageRequest>(req);
  if (!body.text || typeof body.text !== "string") {
    return sendJson(res, 400, { ok: false, error: "text is required" });
  }

  const source = normalizeSource(body.source);
  const deliveryMode: DeliveryMode = body.deliveryMode === "steer" ? "steer" : "followUp";
  const formatted = formatInboundMessage(body.text, source, body.metadata);

  let streamMeta: StreamRoutingMeta = {};
  if (body.targetPiSessionId) {
    streamMeta._targetSessionId = body.targetPiSessionId;
  } else {
    try {
      const classification = await routeMessage(runtime, body.text, source, body.metadata);
      if (classification) {
        streamMeta = classification.metadata;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.log(`router: failed — ${message}`);
      return sendJson(res, 500, { ok: false, error: message });
    }
  }

  runtime.enqueue({
    text: formatted,
    source,
    metadata: { ...body.metadata, ...streamMeta },
    deliveryMode,
    images: Array.isArray(body.images) ? body.images : undefined,
  });

  const response: MessageResponse = { ok: true };
  return sendJson(res, 200, response);
}

async function routeMessage(
  runtime: ControlSurfaceRuntime,
  rawText: string,
  source: MessageSource,
  metadata?: MessageMetadata,
): Promise<{ metadata: StreamRoutingMeta } | null> {
  // Resolve the owner the sender maps to, plus the fallback target + default-conversation session
  // used to hydrate the classifier. Owner (defaultUser) falls back to the global default session;
  // every other WhatsApp user falls back to their own `flitterbot: <userId>` default stream.
  let ownerUser: string | undefined;
  let fallback: StreamRoutingMeta = { router_action: "default" };
  let defaultPiSessionId = runtime.sessionManager.getDefault()?.piSessionId;

  if (source === "whatsapp") {
    const whatsappUserId =
      typeof metadata?.whatsapp_user_id === "string" ? metadata.whatsapp_user_id.trim() : "";
    if (!whatsappUserId) {
      throw new Error("WhatsApp message accepted without whatsapp_user_id metadata");
    }

    const whatsappConfig = loadWhatsAppConfig();
    ownerUser = whatsappUserId;

    if (whatsappConfig.defaultUser !== whatsappUserId) {
      const userDefaultStream = getStreamByName(
        runtime.blackboard,
        `flitterbot: ${whatsappUserId}`,
      );
      if (!userDefaultStream || userDefaultStream.status !== "open") {
        throw new Error(`Missing open default stream for WhatsApp user: ${whatsappUserId}`);
      }
      fallback = {
        router_action: "matched",
        stream_id: userDefaultStream.id,
        stream_name: userDefaultStream.name,
      };
      defaultPiSessionId =
        getActivePiSessionId(runtime.blackboard, userDefaultStream.id) ?? defaultPiSessionId;
    }
  }

  try {
    const classifier = runtime.config.classifier;
    const apiKey = resolveClassifierApiKey(classifier);
    if (classifier.provider === "disabled") return { metadata: fallback };
    if (classifier.provider !== "pi" && !apiKey) return { metadata: fallback };
    const result = await classifyMessage(
      rawText,
      runtime.blackboard,
      runtime.config,
      defaultPiSessionId,
      ownerUser,
    );
    if (result.stream) {
      runtime.log(
        `router: matched stream "${result.stream.name}" (${result.stream.id.slice(0, 8)})`,
      );
      return {
        metadata: {
          router_action: "matched",
          stream_id: result.stream.id,
          stream_name: result.stream.name,
        },
      };
    }
    runtime.log("router: no stream match, routing to fallback");
    return { metadata: fallback };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[router] classification failed:", msg);
    runtime.log(`router: classification failed — ${msg}`);
    return { metadata: fallback };
  }
}

function normalizeSource(source?: string): MessageSource {
  switch (source) {
    case "whatsapp":
      return source;
    default:
      return "web";
  }
}

function formatInboundMessage(
  text: string,
  _source: MessageSource,
  _metadata?: MessageMetadata,
): string {
  return text;
}

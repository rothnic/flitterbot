import type http from "node:http";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

const MAX_WORKER_CONTROL_BODY_BYTES = 256 * 1024;

type LaunchCodexWorkerRequest = {
  prompt?: unknown;
  profile?: unknown;
  cwd?: unknown;
  stream_id?: unknown;
  worker_host?: unknown;
  context?: unknown;
};

type FollowUpCodexWorkerRequest = {
  prompt?: unknown;
  profile?: unknown;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

function errorStatus(message: string): number {
  return /not found|unknown worker|unknown worker host|unknown worker session/i.test(message)
    ? 404
    : 400;
}

export async function handleCodexWorkerLaunchRoute(
  runtime: ControlSurfaceRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  if (!requireBearer(request, runtime.config.controlSurfaceToken)) {
    return sendJson(response, 401, { ok: false, error: "unauthorized" });
  }

  let body: LaunchCodexWorkerRequest;
  try {
    body = await readJsonBody<LaunchCodexWorkerRequest>(request, {
      maxBytes: MAX_WORKER_CONTROL_BODY_BYTES,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 400, { ok: false, error: `invalid JSON body: ${message}` });
  }

  try {
    const result = await runtime.launchCodexWorkerProgrammatic({
      prompt: requiredString(body.prompt, "prompt"),
      profileId: optionalString(body.profile),
      cwd: optionalString(body.cwd),
      streamId: optionalString(body.stream_id),
      workerHostId: optionalString(body.worker_host),
      context: optionalString(body.context),
    });
    return sendJson(response, 200, { ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, errorStatus(message), { ok: false, error: message });
  }
}

export async function handleCodexWorkerStatusRoute(
  runtime: ControlSurfaceRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  workerSessionId: string,
): Promise<void> {
  if (!requireBearer(request, runtime.config.controlSurfaceToken)) {
    return sendJson(response, 401, { ok: false, error: "unauthorized" });
  }

  try {
    const result = runtime.getCodexWorkerStatusProgrammatic({ workerSessionId });
    return sendJson(response, 200, { ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, errorStatus(message), { ok: false, error: message });
  }
}

export async function handleCodexWorkerFollowUpRoute(
  runtime: ControlSurfaceRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  workerSessionId: string,
): Promise<void> {
  if (!requireBearer(request, runtime.config.controlSurfaceToken)) {
    return sendJson(response, 401, { ok: false, error: "unauthorized" });
  }

  let body: FollowUpCodexWorkerRequest;
  try {
    body = await readJsonBody<FollowUpCodexWorkerRequest>(request, {
      maxBytes: MAX_WORKER_CONTROL_BODY_BYTES,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 400, { ok: false, error: `invalid JSON body: ${message}` });
  }

  try {
    const result = await runtime.followUpCodexWorkerProgrammatic({
      workerSessionId,
      prompt: requiredString(body.prompt, "prompt"),
      profileId: optionalString(body.profile),
    });
    return sendJson(response, 200, { ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, errorStatus(message), { ok: false, error: message });
  }
}

export async function handleCodexWorkerCancelRoute(
  runtime: ControlSurfaceRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  workerSessionId: string,
): Promise<void> {
  if (!requireBearer(request, runtime.config.controlSurfaceToken)) {
    return sendJson(response, 401, { ok: false, error: "unauthorized" });
  }

  try {
    const result = await runtime.cancelCodexWorkerProgrammatic(workerSessionId);
    return sendJson(response, 200, { ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, errorStatus(message), { ok: false, error: message });
  }
}

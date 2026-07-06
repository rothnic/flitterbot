// Suppress the node:sqlite ExperimentalWarning before any imports that use it.
const _origWarningListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  for (const listener of _origWarningListeners) (listener as (w: Error) => void)(warning);
});

import http from "node:http";
import { pathToFileURL } from "node:url";
import {
  CONTROL_SURFACE_ENDPOINTS,
  type HookRouteEventName,
  ROUTE_EVENT_TO_HOOK_EVENT,
} from "./contracts/index.ts";
import { sendJson } from "./routes/_shared.ts";
import { handleBrowserDirectoryCompletionsRoute } from "./routes/browser-directory-completions.ts";
import { handleBrowserModelsPinRoute, handleBrowserModelsRoute } from "./routes/browser-models.ts";
import { handleBrowserPiSessionDiffRoute } from "./routes/browser-pi-session-diff.ts";
import { handleBrowserPiSessionStreamRoute } from "./routes/browser-pi-session-stream.ts";
import { handleBrowserPiSessionsRoute } from "./routes/browser-pi-sessions.ts";
import {
  handleBrowserSessionDetailRoute,
  handleBrowserSessionsRoute,
} from "./routes/browser-sessions.ts";
import { handleBrowserSkillsRoute } from "./routes/browser-skills.ts";
import { handleBrowserStreamsHistoryRoute } from "./routes/browser-streams.ts";
import { handleBrowserTranscriptRoute } from "./routes/browser-transcript.ts";
import {
  handleBrowserUserConfigGetRoute,
  handleBrowserUserConfigPutRoute,
} from "./routes/browser-user-config.ts";
import { handleBrowserWorkerSessionsRoute } from "./routes/browser-worker-sessions.ts";
import { handleCloseStreamNoopRoute } from "./routes/close-stream.ts";
import {
  handleCodexWorkerCancelRoute,
  handleCodexWorkerFollowUpRoute,
  handleCodexWorkerLaunchRoute,
  handleCodexWorkerStatusRoute,
} from "./routes/codex-workers.ts";
import { handleCompactPiSessionRoute } from "./routes/compact-pi-session.ts";
import { handleCreateStreamRoute } from "./routes/create-stream.ts";
import { handleCronTickRoute } from "./routes/cron-tick.ts";
import { handleDirectSessionMessageRoute } from "./routes/direct-session-message.ts";
import { handleHookRoute } from "./routes/hooks.ts";
import { handleMessageRoute } from "./routes/message.ts";
import { handlePiSessionInterruptRoute } from "./routes/pi-session-interrupt.ts";
import {
  handlePiSessionModelRoute,
  handlePiSessionThinkingLevelRoute,
} from "./routes/pi-session-model.ts";
import { handlePinStreamRoute } from "./routes/pin-stream.ts";
import { handlePruneStreamHistoryRoute } from "./routes/prune-stream-history.ts";
import { handleRenameStreamRoute } from "./routes/rename-stream.ts";
import { handleReopenStreamRoute } from "./routes/reopen-stream.ts";
import { handleRuntimeWhatsAppRoute } from "./routes/runtime-whatsapp.ts";
import { handleSetStreamCwdRoute } from "./routes/set-stream-cwd.ts";
import { handleStatusRoute } from "./routes/status.ts";
import { handleStopRoute } from "./routes/stop.ts";
import { ControlSurfaceRuntime } from "./runtime.ts";
import { errorDetail, errorMessage, formatStartupFailure } from "./startup-error.ts";

let runtime: ControlSurfaceRuntime | undefined;

function installProcessHandlers(): void {
  process.on("SIGTERM", () => {
    void runtime?.stop("sigterm").finally(() => process.exit(0));
    if (!runtime) process.exit(0);
  });
  process.on("SIGINT", () => {
    void runtime?.stop("sigint").finally(() => process.exit(0));
    if (!runtime) process.exit(0);
  });
  process.on("uncaughtException", (error) => {
    console.error(errorDetail(error));
    void runtime?.stop("uncaught_exception", true).finally(() => process.exit(1));
    if (!runtime) process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    console.error(errorDetail(error));
    void runtime?.stop("unhandled_rejection", true).finally(() => process.exit(1));
    if (!runtime) process.exit(1);
  });
}

async function main(): Promise<void> {
  runtime = new ControlSurfaceRuntime();
  const activeRuntime = runtime;
  const server = createServer(activeRuntime);
  activeRuntime.attachServer(server);

  await activeRuntime.start();
  server.listen(
    activeRuntime.config.controlSurfacePort,
    activeRuntime.config.controlSurfaceHost,
    () => {
      console.log(
        `Flitterbot control surface listening on http://${activeRuntime.config.controlSurfaceHost}:${activeRuntime.config.controlSurfacePort}`,
      );
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installProcessHandlers();
  try {
    await main();
  } catch (error) {
    console.error(formatStartupFailure(error));
    await runtime?.stop("startup_failure", true).catch((stopError) => {
      console.error(`Failed to stop runtime after startup failure: ${errorDetail(stopError)}`);
    });
    process.exit(1);
  }
}

export function createServer(runtime: ControlSurfaceRuntime): http.Server {
  const server = http.createServer(async (req, res) => {
    applyCorsHeaders(res);
    if ((req.method ?? "GET") === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    try {
      await routeRequest(runtime, req, res);
    } catch (error) {
      runtime.log(`unhandled route error: ${errorDetail(error)}`);
      sendJson(res, 500, { ok: false, error: errorMessage(error) });
    }
  });

  server.on("upgrade", (req, socket: import("node:net").Socket, head) => {
    const handled = runtime.handleUpgrade(req, socket, head);
    if (!handled) socket.destroy();
  });

  return server;
}

function applyCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

async function routeRequest(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(
    req.url ?? "/",
    `http://${runtime.config.controlSurfaceHost}:${runtime.config.controlSurfacePort}`,
  );
  const pathname = url.pathname;
  const segments = pathname.split("/").filter(Boolean);

  if (
    method === CONTROL_SURFACE_ENDPOINTS.status.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.status.path
  ) {
    return handleStatusRoute(runtime, req, res);
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.message.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.message.path
  ) {
    return handleMessageRoute(runtime, req, res);
  }
  if (method === "POST" && segments[0] === "hook" && segments[1]) {
    const eventName = segments[1] as HookRouteEventName;
    if (eventName in ROUTE_EVENT_TO_HOOK_EVENT) {
      return handleHookRoute(runtime, req, res, eventName);
    }
    runtime.log(`hook ${segments[1]}: unknown event, rejecting`);
    return sendJson(res, 404, { ok: false, error: `Unknown hook route event: ${segments[1]}` });
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.stop.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.stop.path
  ) {
    return handleStopRoute(runtime, req, res);
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.cronTick.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.cronTick.path
  ) {
    return handleCronTickRoute(runtime, req, res);
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.sessions.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.sessions.path
  ) {
    return handleBrowserSessionsRoute(runtime, req, res);
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.streamsHistory.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.streamsHistory.path
  ) {
    return handleBrowserStreamsHistoryRoute(runtime, req, res);
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.skills.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.skills.path
  ) {
    return handleBrowserSkillsRoute(runtime, req, res);
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.models.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.models.path
  ) {
    return handleBrowserModelsRoute(runtime, req, res);
  }
  if (method === "POST" && pathname === "/api/models/pin") {
    return handleBrowserModelsPinRoute(runtime, req, res);
  }
  if (method === "POST" && pathname === "/api/workers") {
    return handleCodexWorkerLaunchRoute(runtime, req, res);
  }
  if (
    method === "GET" &&
    segments[0] === "api" &&
    segments[1] === "workers" &&
    segments[2] &&
    !segments[3]
  ) {
    return handleCodexWorkerStatusRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === "POST" &&
    segments[0] === "api" &&
    segments[1] === "workers" &&
    segments[2] &&
    segments[3] === "followup" &&
    !segments[4]
  ) {
    return handleCodexWorkerFollowUpRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === "POST" &&
    segments[0] === "api" &&
    segments[1] === "workers" &&
    segments[2] &&
    segments[3] === "cancel" &&
    !segments[4]
  ) {
    return handleCodexWorkerCancelRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === CONTROL_SURFACE_ENDPOINTS.directoryCompletions.method &&
    pathname === CONTROL_SURFACE_ENDPOINTS.directoryCompletions.path
  ) {
    return handleBrowserDirectoryCompletionsRoute(runtime, req, res);
  }
  if (
    method === "GET" &&
    segments[0] === "api" &&
    segments[1] === "sessions" &&
    segments[2] &&
    segments[3] === "transcript"
  ) {
    return handleBrowserTranscriptRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (method === "GET" && segments[0] === "api" && segments[1] === "sessions" && segments[2]) {
    return handleBrowserSessionDetailRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === "GET" &&
    segments[0] === "api" &&
    segments[1] === "pi-sessions" &&
    segments[2] &&
    segments[3] === "sessions"
  ) {
    return handleBrowserPiSessionsRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === "GET" &&
    segments[0] === "api" &&
    segments[1] === "pi-sessions" &&
    segments[2] &&
    segments[3] === "stream" &&
    !segments[4]
  ) {
    return handleBrowserPiSessionStreamRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === "GET" &&
    segments[0] === "api" &&
    segments[1] === "pi-sessions" &&
    segments[2] &&
    segments[3] === "diff" &&
    !segments[4]
  ) {
    return handleBrowserPiSessionDiffRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (method === "POST" && segments[0] === "sessions" && segments[1] && segments[2] === "message") {
    return handleDirectSessionMessageRoute(runtime, req, res, decodeURIComponent(segments[1]));
  }
  if (
    method === "POST" &&
    segments[0] === "api" &&
    segments[1] === "pi-sessions" &&
    segments[2] &&
    segments[3] === "interrupt"
  ) {
    return handlePiSessionInterruptRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === "PUT" &&
    segments[0] === "api" &&
    segments[1] === "pi-sessions" &&
    segments[2] &&
    segments[3] === "model"
  ) {
    return handlePiSessionModelRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === "PUT" &&
    segments[0] === "api" &&
    segments[1] === "pi-sessions" &&
    segments[2] &&
    segments[3] === "thinking-level"
  ) {
    return handlePiSessionThinkingLevelRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === "POST" &&
    segments[0] === "api" &&
    segments[1] === "streams" &&
    segments[2] &&
    segments[3] === "reopen"
  ) {
    return handleReopenStreamRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === "POST" &&
    segments[0] === "api" &&
    segments[1] === "streams" &&
    segments[2] &&
    segments[3] === "close"
  ) {
    return handleCloseStreamNoopRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === "PUT" &&
    segments[0] === "api" &&
    segments[1] === "streams" &&
    segments[2] &&
    segments[3] === "pin"
  ) {
    return handlePinStreamRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === "PUT" &&
    segments[0] === "api" &&
    segments[1] === "streams" &&
    segments[2] &&
    segments[3] === "name"
  ) {
    return handleRenameStreamRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    method === "POST" &&
    segments[0] === "api" &&
    segments[1] === "streams" &&
    segments[2] &&
    segments[3] === "cwd"
  ) {
    return handleSetStreamCwdRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (method === "POST" && segments[0] === "api" && segments[1] === "streams" && !segments[2]) {
    return handleCreateStreamRoute(runtime, req, res);
  }
  if (
    method === "POST" &&
    segments[0] === "api" &&
    segments[1] === "streams" &&
    segments[2] === "prune" &&
    !segments[3]
  ) {
    return handlePruneStreamHistoryRoute(runtime, req, res);
  }
  if (
    method === "POST" &&
    segments[0] === "api" &&
    segments[1] === "streams" &&
    segments[2] === "compact" &&
    !segments[3]
  ) {
    return handleCompactPiSessionRoute(runtime, req, res);
  }
  if (
    method === "GET" &&
    segments[0] === "api" &&
    segments[1] === "streams" &&
    segments[2] &&
    segments[3] === "workers" &&
    !segments[4]
  ) {
    return handleBrowserWorkerSessionsRoute(runtime, req, res, decodeURIComponent(segments[2]));
  }
  if (
    (method === CONTROL_SURFACE_ENDPOINTS.runtimeWhatsAppStart.method &&
      pathname === CONTROL_SURFACE_ENDPOINTS.runtimeWhatsAppStart.path) ||
    (method === CONTROL_SURFACE_ENDPOINTS.runtimeWhatsAppStop.method &&
      pathname === CONTROL_SURFACE_ENDPOINTS.runtimeWhatsAppStop.path)
  ) {
    return handleRuntimeWhatsAppRoute(
      runtime,
      req,
      res,
      pathname.endsWith("/start") ? "start" : "stop",
    );
  }

  if (segments[0] === "api" && segments[1] === "user-config" && segments[2] && !segments[3]) {
    const userId = decodeURIComponent(segments[2]);
    if (method === "GET") {
      return handleBrowserUserConfigGetRoute(runtime, req, res, userId);
    }
    if (method === "PUT") {
      return handleBrowserUserConfigPutRoute(runtime, req, res, userId);
    }
  }

  return sendJson(res, 404, { ok: false, error: `No route for ${method} ${pathname}` });
}

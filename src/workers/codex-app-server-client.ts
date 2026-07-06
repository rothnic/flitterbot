import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

type JsonObject = Record<string, unknown>;

type JsonRpcResponse = {
  id: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type JsonRpcNotification = {
  method: string;
  params?: JsonObject;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export type CodexAppServerEvent = {
  method: string;
  params?: JsonObject;
};

export type CodexAppServerClientOptions = {
  codexCommand?: string;
  spawnCommand?: string;
  spawnArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: CodexAppServerEvent) => void;
  onStderr?: (chunk: string) => void;
};

export type CodexThreadStartResponse = {
  thread: {
    id: string;
    sessionId?: string;
  };
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy?: string;
  sandbox?: unknown;
};

export type CodexTurnStartResponse = {
  turn: {
    id: string;
    status: string;
  };
};

export type CodexThreadResumeResponse = CodexThreadStartResponse;

export type CodexTurnCompletion = {
  status: string;
  finalOutput: string;
  turn: JsonObject;
};

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rl: ReadlineInterface;
  private readonly pending = new Map<string, PendingRequest>();
  private onEvent?: (event: CodexAppServerEvent) => void;
  private readonly onStderr?: (chunk: string) => void;
  private stderrTail = "";
  private exited = false;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.onEvent = options.onEvent;
    this.onStderr = options.onStderr;
    this.child = spawn(
      options.spawnCommand ?? options.codexCommand ?? "codex",
      options.spawnArgs ?? ["app-server"],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail = `${this.stderrTail}${text}`.slice(-8000);
      this.onStderr?.(text);
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      const error = new Error(
        `codex app-server exited before request completed: code=${code ?? "null"} signal=${signal ?? "null"} stderr=${this.stderrTail.trim()}`,
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  async initialize(): Promise<JsonObject> {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "flitterbot-codex-worker",
        title: "Flitterbot Codex Worker",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "command/exec/outputDelta",
          "item/agentMessage/delta",
          "item/plan/delta",
          "item/fileChange/outputDelta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
        ],
      },
    });
    this.notify("initialized");
    return result as JsonObject;
  }

  async startThread(params: {
    cwd: string;
    model?: string | null;
    approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    baseInstructions?: string | null;
    developerInstructions?: string | null;
    personality?: "friendly" | "pragmatic" | "none" | null;
  }): Promise<CodexThreadStartResponse> {
    return (await this.request("thread/start", {
      model: params.model ?? null,
      modelProvider: null,
      cwd: params.cwd,
      approvalPolicy: params.approvalPolicy ?? "never",
      approvalsReviewer: "user",
      sandbox: params.sandbox ?? "workspace-write",
      serviceName: "flitterbot",
      baseInstructions: params.baseInstructions ?? null,
      developerInstructions: params.developerInstructions ?? null,
      personality: params.personality ?? "pragmatic",
    })) as CodexThreadStartResponse;
  }

  async resumeThread(params: {
    threadId: string;
    cwd?: string | null;
    model?: string | null;
    approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    baseInstructions?: string | null;
    developerInstructions?: string | null;
    personality?: "friendly" | "pragmatic" | "none" | null;
  }): Promise<CodexThreadResumeResponse> {
    return (await this.request("thread/resume", {
      threadId: params.threadId,
      model: params.model ?? null,
      modelProvider: null,
      cwd: params.cwd ?? null,
      approvalPolicy: params.approvalPolicy ?? "never",
      approvalsReviewer: "user",
      sandbox: params.sandbox ?? "workspace-write",
      baseInstructions: params.baseInstructions ?? null,
      developerInstructions: params.developerInstructions ?? null,
      personality: params.personality ?? "pragmatic",
    })) as CodexThreadResumeResponse;
  }

  async startTurn(params: {
    threadId: string;
    prompt: string;
    cwd?: string | null;
    approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
    model?: string | null;
  }): Promise<CodexTurnStartResponse> {
    return (await this.request("turn/start", {
      threadId: params.threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text: params.prompt, text_elements: [] }],
      cwd: params.cwd ?? null,
      approvalPolicy: params.approvalPolicy ?? "never",
      approvalsReviewer: "user",
      model: params.model ?? null,
    })) as CodexTurnStartResponse;
  }

  async interruptTurn(params: { threadId: string; turnId: string }): Promise<void> {
    await this.request("turn/interrupt", {
      threadId: params.threadId,
      turnId: params.turnId,
    });
  }

  waitForTurnCompletion(
    threadId: string,
    turnId: string,
    timeoutMs: number = 120_000,
  ): Promise<CodexTurnCompletion> {
    return new Promise((resolve, reject) => {
      let finalOutput = "";
      let settled = false;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for Codex turn ${turnId}`));
      }, timeoutMs);

      const originalOnEvent = this.onEvent;
      const eventHandler = (event: CodexAppServerEvent) => {
        originalOnEvent?.(event);
        const params = event.params;
        if (params?.threadId !== threadId) return;
        if (params.turnId && params.turnId !== turnId) return;

        if (event.method === "item/completed") {
          const item = params.item as JsonObject | undefined;
          if (item?.type === "agentMessage" && typeof item.text === "string") {
            finalOutput = item.text;
          }
          return;
        }

        if (event.method === "turn/completed") {
          const turn = params.turn as JsonObject | undefined;
          if (!turn || turn.id !== turnId) return;
          cleanup();
          const status = typeof turn.status === "string" ? turn.status : "completed";
          if (status === "failed") {
            reject(new Error(`Codex turn ${turnId} failed: ${JSON.stringify(turn.error ?? null)}`));
            return;
          }
          resolve({ status, finalOutput, turn });
        }
      };

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.onEvent = originalOnEvent;
      };

      this.onEvent = eventHandler;
    });
  }

  close(): void {
    this.rl.close();
    this.child.stdin.end();
    if (!this.exited) this.child.kill("SIGTERM");
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.exited) throw new Error("codex app-server is not running");
    const id = randomUUID();
    const message = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.onStderr?.(`non-json app-server stdout: ${line}\n`);
      return;
    }

    if (typeof message.id === "string" && !message.method) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }

    if (typeof message.method === "string" && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }

    if (typeof message.method === "string") {
      const event = message as JsonRpcNotification;
      this.onEvent?.({ method: event.method, params: event.params });
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message ?? JSON.stringify(response.error)));
      return;
    }
    pending.resolve(response.result);
  }

  private handleServerRequest(message: JsonObject): void {
    const method = String(message.method);
    this.onEvent?.({ method, params: message.params as JsonObject | undefined });
    const id = message.id;
    if (id == null) return;
    const result = serverRequestFallbackResult(method);
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }
}

function serverRequestFallbackResult(method: string): JsonObject {
  if (method.includes("requestApproval") || method.endsWith("Approval")) {
    return { decision: "denied" };
  }
  if (method === "item/tool/requestUserInput") {
    return { status: "canceled" };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action: "cancel" };
  }
  return {};
}

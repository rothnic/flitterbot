import type http from "node:http";

export async function readJsonBody<T = unknown>(
  req: http.IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<T> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (options.maxBytes && bytes > options.maxBytes) {
      throw new Error(`JSON body exceeds ${options.maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {} as T;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

export function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body)}\n`);
}

function getBearerToken(header?: string | string[]): string | undefined {
  if (!header) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function requireBearer(req: http.IncomingMessage, expectedToken: string): boolean {
  return getBearerToken(req.headers.authorization) === expectedToken;
}

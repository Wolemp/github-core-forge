// The forge's HTTP surface: /healthz, the REST v3 API under /api/v3 and (added by later stages) git
// smart HTTP, GraphQL and MCP. main.ts is the entry <-> env lifecycle; this is the server it starts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, dispatch, type Ctx } from './src/rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `${requestCounter.toString(16).toUpperCase().padStart(8, '0')}:0001:0000:${Date.now().toString(16).toUpperCase()}`;
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = status === 204 || body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), ...headers });
  res.end(status === 204 ? undefined : text);
}

function sendError(res: ServerResponse, error: ApiError): void {
  const body: Record<string, unknown> = { message: error.message, documentation_url: 'https://docs.github.com/rest' };
  if (error.errors !== undefined) body.errors = error.errors;
  sendJson(res, error.status, body);
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  return m === null ? null : m[1].trim();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(raw: Buffer): Record<string, unknown> {
  const text = raw.toString('utf8');
  if (text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ApiError(400, 'Problems parsing JSON');
  return value as Record<string, unknown>;
}

function baseOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? 'localhost'}`;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const path = url.pathname.slice('/api/v3'.length);
  const open = path === '' || path === '/' || path === '/meta';
  if (!open) {
    const token = bearer(req);
    if (token === null) throw new ApiError(401, 'Requires authentication');
    if (TOKEN !== '' && token !== TOKEN) throw new ApiError(401, 'Bad credentials');
  }
  let parsed: Record<string, unknown> | null = null;
  const ctx: Omit<Ctx, 'params'> = {
    method,
    url,
    base: baseOf(req),
    json: () => {
      if (parsed === null) parsed = parseJson(raw);
      return parsed;
    },
  };
  const reply = dispatch(method, path, ctx);
  if (reply === null) throw new ApiError(404, 'Not Found');
  sendJson(res, reply.status, reply.body, reply.headers ?? {});
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const path = url.pathname;
    try {
      // The env's boot check calls this twice: 200 {"ok":true}.
      if (req.method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        handleRest(req, res, url).catch((err: unknown) => {
          if (res.headersSent) return;
          if (err instanceof ApiError) sendError(res, err);
          else sendJson(res, 500, { message: 'Server Error' });
        });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
    } catch {
      if (!res.headersSent) sendJson(res, 500, { message: 'Server Error' });
    }
  });
  server.keepAliveTimeout = 30_000;
  return server;
}

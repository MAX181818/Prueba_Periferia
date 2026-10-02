import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as oc from './tools/oc.js';
import {
  createAgent,
  DEFAULT_SESSION_TOKENS,
  DEFAULT_GLOBAL_TOKENS,
  type AgentOptions,
} from './agent/loop.js';
import type { LlmAdapter, Registry, Tool } from './llm/adapter.js';
import { OfflineAdapter } from './llm/offline.js';
import { OpenAiAdapter } from './llm/openai.js';
import { OllamaAdapter } from './llm/ollama.js';

const chatInput = z
  .object({ sessionId: z.string().uuid().optional(), message: z.string().trim().min(1).max(4000) })
  .strict();
function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}.`);
  return value;
}
export function adapterFromEnv(): LlmAdapter {
  const mode = process.env.LLM_MODE ?? 'offline';
  if (mode === 'offline') return new OfflineAdapter();
  if (mode === 'ollama')
    return new OllamaAdapter({
      model: process.env.LLM_MODEL,
      baseUrl: process.env.OLLAMA_BASE_URL,
      numCtx: integerEnv('OLLAMA_NUM_CTX', 16384, 2048, 131072),
    });
  if (mode !== 'openai') throw new Error('LLM_MODE debe ser offline, openai u ollama.');
  return new OpenAiAdapter({
    apiKey: process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
    baseUrl: process.env.LLM_BASE_URL,
  });
}
function wrapTool<S extends z.ZodRawShape>(tool: {
  description: string;
  args: S;
  execute(
    args: z.infer<z.ZodObject<S>>,
    ctx: { directory: string; sessionId: string },
  ): Promise<string>;
}): Tool {
  return {
    description: tool.description,
    args: tool.args,
    execute: (args, ctx) => tool.execute(z.object(tool.args).parse(args), ctx),
  };
}
export function defaultRegistry(): Registry {
  return {
    oc_leer_paquete: wrapTool(oc.leer_paquete),
    oc_validar: wrapTool(oc.validar),
    oc_construir_payload: wrapTool(oc.construir_payload),
    oc_generar_evidencia: wrapTool(oc.generar_evidencia),
    oc_crear: wrapTool(oc.crear),
  };
}
export interface AppOptions extends Partial<Omit<AgentOptions, 'directory'>> {
  directory: string;
  rateLimit?: number;
}
async function body(req: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    length += chunk.length;
    if (length > 16000) throw new Error('Cuerpo demasiado grande.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
const cases = [
  { id: 'sol-001', title: 'Compra válida', description: 'Solicitud completa y aprobada.' },
  {
    id: 'sol-002',
    title: 'Proveedor inexistente',
    description: 'Bloqueo de maestro de proveedores.',
  },
  { id: 'sol-003', title: 'Aprobador sin autoridad', description: 'Bloqueo de autorización.' },
  {
    id: 'sol-004',
    title: 'Diferencia de cotización',
    description: 'Requiere confirmación de los valores.',
  },
  { id: 'sol-005', title: 'Compra retroactiva', description: 'Factura anterior a la solicitud.' },
  { id: 'sol-006', title: 'IVA no informado', description: 'IVA derivado requiere confirmación.' },
];
export function createApp(options: AppOptions) {
  const adapter = options.adapter ?? adapterFromEnv();
  const local = adapter.provider === 'ollama-local';
  const maxIterations = options.maxIterations ?? integerEnv('MAX_ITERATIONS', 12, 1, 25);
  const timeoutMs =
    options.timeoutMs ??
    integerEnv('LLM_TIMEOUT_MS', local ? 120000 : 30000, 100, local ? 300000 : 60000);
  const agent = createAgent({
    ...options,
    registry: options.registry ?? defaultRegistry(),
    adapter,
    maxIterations,
    maxSessionTokens:
      options.maxSessionTokens ??
      integerEnv('MAX_SESSION_TOKENS', DEFAULT_SESSION_TOKENS, 1000, 1000000),
    maxGlobalTokens:
      options.maxGlobalTokens ??
      integerEnv('MAX_GLOBAL_TOKENS', DEFAULT_GLOBAL_TOKENS, 1000, 10000000),
    maxCompletionTokens:
      options.maxCompletionTokens ?? integerEnv('MAX_COMPLETION_TOKENS', 1500, 64, 8000),
    timeoutMs,
  });
  const rate = new Map<string, { start: number; count: number }>();
  let globalWindow = { start: Date.now(), count: 0 };
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  server.timeout = local ? maxIterations * timeoutMs + 30000 : 60000;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        json(res, 200, {
          ok: true,
          provider: adapter.provider,
          model: adapter.model,
          mode: adapter.provider === 'offline' ? 'offline' : local ? 'ollama' : 'openai',
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/cases') {
        json(res, 200, { cases });
        return;
      }
      if (req.method === 'GET' && /^\/api\/sessions\/[\da-f-]{36}$/.test(url.pathname)) {
        const session = agent.getSession(url.pathname.split('/')[3]!);
        json(res, session ? 200 : 404, session ?? { ok: false, error: 'Sesión no encontrada.' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) {
          json(res, 403, { ok: false, error: 'Origen no permitido.' });
          return;
        }
        if (!req.headers['content-type']?.startsWith('application/json')) {
          json(res, 415, { ok: false, error: 'Usa Content-Type application/json.' });
          return;
        }
        const now = Date.now();
        for (const [key, entry] of rate) if (now - entry.start > 60000) rate.delete(key);
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (rate.size > 1000 && !rate.has(ip)) {
          json(res, 429, { ok: false, error: 'Demasiadas conexiones. Intenta más tarde.' });
          return;
        }
        const entry = rate.get(ip) ?? { start: now, count: 0 };
        entry.count++;
        rate.set(ip, entry);
        if (now - globalWindow.start > 60000) globalWindow = { start: now, count: 0 };
        globalWindow.count++;
        if (entry.count > (options.rateLimit ?? 20) || globalWindow.count > 60) {
          json(res, 429, {
            ok: false,
            error: 'Límite de solicitudes alcanzado. Espera un minuto.',
          });
          return;
        }
        let raw: unknown;
        try {
          raw = await body(req);
        } catch {
          json(res, 400, { ok: false, error: 'JSON inválido o cuerpo demasiado grande.' });
          return;
        }
        const input = chatInput.safeParse(raw);
        if (!input.success) {
          json(res, 400, {
            ok: false,
            error: 'Incluye un mensaje de 1 a 4000 caracteres y un sessionId válido si existe.',
          });
          return;
        }
        try {
          json(res, 200, await agent.chat(input.data.message, input.data.sessionId));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'El servidor no pudo completar la solicitud.';
          const allowed = /sesión|sesiones|turno|ocupado/i.test(message)
            ? message
            : 'El servidor no pudo completar la solicitud.';
          json(res, /no existe|expiró/.test(allowed) ? 404 : 429, { ok: false, error: allowed });
        }
        return;
      }
      const staticFiles: Record<string, { name: string; mime: string }> = {
        '/': { name: 'index.html', mime: 'text/html' },
        '/index.html': { name: 'index.html', mime: 'text/html' },
        '/app.js': { name: 'app.js', mime: 'text/javascript' },
        '/styles.css': { name: 'styles.css', mime: 'text/css' },
      };
      const file = staticFiles[url.pathname];
      if (req.method === 'GET' && file) {
        const content = await readFile(join(options.directory, 'web', file.name));
        res.writeHead(200, { 'Content-Type': `${file.mime}; charset=utf-8` });
        res.end(content);
        return;
      }
      json(res, 404, { ok: false, error: 'Ruta no encontrada.' });
    } catch {
      if (!res.headersSent)
        json(res, 400, { ok: false, error: 'Solicitud inválida o archivo no disponible.' });
      else res.end();
    }
  }
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = resolve(fileURLToPath(new URL('../', import.meta.url)));
    const app = createApp({ directory });
    const port = integerEnv('PORT', 3000, 1, 65535);
    app.listen(port, process.env.HOST ?? '127.0.0.1', () => {
      console.log(
        `Órdenes de compra: http://localhost:${port} | modo ${process.env.LLM_MODE ?? 'offline'}`,
      );
    });
  } catch {
    console.error('No se pudo iniciar: revisa LLM_MODE, credenciales y límites de entorno.');
    process.exitCode = 1;
  }
}

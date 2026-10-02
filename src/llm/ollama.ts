import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LlmAdapter, Message, ToolDefinition, ModelResponse, SendOptions } from './adapter.js';

const responseSchema = z.object({
  message: z.object({
    role: z.literal('assistant'),
    content: z.string(),
    tool_calls: z
      .array(
        z.object({
          function: z.object({ name: z.string().min(1), arguments: z.record(z.unknown()) }),
        }),
      )
      .optional(),
  }),
  done: z.literal(true),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
});
export interface OllamaOptions {
  model?: string;
  baseUrl?: string;
  numCtx?: number;
}
export class OllamaAdapter implements LlmAdapter {
  readonly provider = 'ollama-local';
  readonly model: string;
  private readonly url: string;
  private readonly numCtx: number;
  constructor(options: OllamaOptions = {}) {
    this.model = options.model ?? 'qwen3:4b-instruct-2507-q4_K_M';
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*(?::[a-zA-Z0-9_.-]+)?$/.test(this.model) ||
      /cloud/i.test(this.model)
    )
      throw new Error('Ollama requiere un modelo local sin host remoto ni tag cloud.');
    let url: URL;
    try {
      url = new URL(options.baseUrl ?? 'http://127.0.0.1:11434');
    } catch {
      throw new Error('OLLAMA_BASE_URL inválida: usa HTTP loopback local.');
    }
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '[::1]' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
    if (
      url.protocol !== 'http:' ||
      !loopback ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error(
        'OLLAMA_BASE_URL inválida: usa HTTP loopback local sin credenciales, ruta ni parámetros.',
      );
    this.url = new URL('/api/chat', url).href;
    this.numCtx = options.numCtx ?? 16384;
    if (!Number.isInteger(this.numCtx) || this.numCtx < 2048 || this.numCtx > 131072)
      throw new Error('OLLAMA_NUM_CTX debe ser un entero entre 2048 y 131072.');
  }
  async enviar(
    messages: Message[],
    tools: ToolDefinition[],
    options: SendOptions,
  ): Promise<ModelResponse> {
    const names = new Map(
      messages.flatMap((message) =>
        (message.toolCalls ?? []).map((call) => [call.id, call.name] as const),
      ),
    );
    const wireMessages = messages.map((message) => {
      const toolName =
        message.role === 'tool' ? (message.name ?? names.get(message.toolCallId ?? '')) : undefined;
      if (message.role === 'tool' && !toolName)
        throw new Error('La respuesta de herramienta requiere un nombre conocido.');
      return {
        role: message.role,
        content: message.content,
        ...(toolName ? { tool_name: toolName } : {}),
        ...(message.toolCalls
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                type: 'function',
                function: { name: call.name, arguments: call.args },
              })),
            }
          : {}),
      };
    });
    const response = await fetch(this.url, {
      method: 'POST',
      signal: options.signal,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: wireMessages,
        tools: tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        stream: false,
        think: false,
        options: { temperature: 0, num_ctx: this.numCtx, num_predict: options.maxTokens },
      }),
    });
    // Never echo provider bodies: they may contain private request data.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Proveedor LLM local devolvió HTTP ${response.status}.`);
    }
    if (Number(response.headers.get('content-length') ?? 0) > 500000) {
      await response.body?.cancel();
      throw new Error('Respuesta LLM demasiado grande.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Respuesta LLM vacía.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 500000) {
          await reader.cancel();
          throw new Error('Respuesta LLM demasiado grande.');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    let body: z.infer<typeof responseSchema>;
    try {
      body = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      throw new Error('Respuesta LLM local inválida.');
    }
    return {
      content: body.message.content,
      toolCalls: (body.message.tool_calls ?? []).map((call) => ({
        id: randomUUID(),
        name: call.function.name,
        args: call.function.arguments,
      })),
      tokens:
        body.prompt_eval_count === undefined && body.eval_count === undefined
          ? undefined
          : (body.prompt_eval_count ?? 0) + (body.eval_count ?? 0),
    };
  }
}

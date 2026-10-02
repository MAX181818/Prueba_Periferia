import { z } from 'zod';
import type { LlmAdapter, Message, ToolDefinition, ModelResponse } from './adapter.js';

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal('function'),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ total_tokens: z.number().nonnegative() }).optional(),
});
export interface OpenAiOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}
export class OpenAiAdapter implements LlmAdapter {
  readonly provider = 'openai-compatible';
  readonly model: string;
  private readonly url: string;
  private readonly request: typeof fetch;
  constructor(private readonly options: OpenAiOptions) {
    if (!options.apiKey.trim())
      throw new Error('LLM_API_KEY u OPENAI_API_KEY es obligatorio en modo openai.');
    this.model = options.model;
    const url = new URL(
      `${(options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`,
    );
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('LLM_BASE_URL inválida.');
    this.url = url.href;
    this.request = options.fetch ?? fetch;
  }
  async enviar(
    messages: Message[],
    tools: ToolDefinition[],
    options: { maxTokens: number; signal: AbortSignal },
  ): Promise<ModelResponse> {
    const response = await this.request(this.url, {
      method: 'POST',
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content || (message.toolCalls ? null : ''),
          ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
          ...(message.toolCalls
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              }
            : {}),
        })),
        tools: tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        tool_choice: 'auto',
        parallel_tool_calls: false,
        max_completion_tokens: options.maxTokens,
        store: false,
      }),
    });
    // Provider bodies may echo credentials or request content. Never expose them.
    if (!response.ok) throw new Error(`Proveedor LLM devolvió HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length') ?? 0) > 500000)
      throw new Error('Respuesta LLM demasiado grande.');
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
    const body = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const message = body.choices[0]!.message;
    return {
      content: message.content ?? '',
      toolCalls: (message.tool_calls ?? []).map((call) => {
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = null;
        }
        return { id: call.id, name: call.function.name, args };
      }),
      tokens: body.usage?.total_tokens,
    };
  }
}

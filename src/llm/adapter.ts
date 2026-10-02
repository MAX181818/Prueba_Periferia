import type { ZodRawShape } from 'zod';

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  tokens?: number;
}
export interface ServerState {
  caso?: string;
  humanPermission: boolean;
  preview: boolean;
  cancelled: boolean;
}
export interface SendOptions {
  maxTokens: number;
  signal: AbortSignal;
  serverState?: ServerState;
}
export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  enviar(
    messages: Message[],
    tools: ToolDefinition[],
    options: SendOptions,
  ): Promise<ModelResponse>;
}
export interface Tool {
  description: string;
  args: ZodRawShape;
  execute(
    args: Record<string, unknown>,
    ctx: { directory: string; sessionId: string },
  ): Promise<string>;
}
export type Registry = Record<string, Tool>;

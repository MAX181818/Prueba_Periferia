import { randomUUID } from 'node:crypto';
import type { LlmAdapter, Message, ModelResponse, ToolDefinition, SendOptions } from './adapter.js';
function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
function parsed(message: Message | undefined): Record<string, unknown> {
  try {
    return object(JSON.parse(message?.content ?? '{}'));
  } catch {
    return {};
  }
}
function invoke(name: string, args: unknown): ModelResponse {
  return { content: '', toolCalls: [{ id: randomUUID(), name, args }], tokens: 0 };
}
/** Deterministic fixture runner. This is explicitly not a language model. */
export class OfflineAdapter implements LlmAdapter {
  readonly provider = 'offline';
  readonly model = 'simulador-determinista-sin-LLM';
  async enviar(
    messages: Message[],
    _tools: ToolDefinition[],
    options: SendOptions,
  ): Promise<ModelResponse> {
    const userIndex = messages.map((message) => message.role).lastIndexOf('user');
    const current = messages.slice(userIndex + 1);
    const state = options.serverState;
    const caso = state?.caso;
    const reply = (content: string): ModelResponse => ({ content, toolCalls: [], tokens: 0 });
    if (!caso)
      return reply(
        'Modo offline: simulador determinista, sin modelo de lenguaje. Indica un caso, por ejemplo «Procesa sol-001» o «Muéstrame sol-004 sin crear».',
      );
    if (state?.cancelled)
      return reply('No se creó la OC. Solicita una nueva vista previa cuando quieras continuar.');
    const toolMessages = current.filter((message) => message.role === 'tool');
    const last = toolMessages[toolMessages.length - 1];
    if (last && parsed(last).ok === false) return reply(`No se pudo continuar: ${last.content}`);
    const find = (name: string) => toolMessages.find((message) => message.name === name);
    const read = find('oc_leer_paquete');
    if (!read) return invoke('oc_leer_paquete', { caso });
    const paquete = parsed(read).data;
    const validation = find('oc_validar');
    if (!validation) return invoke('oc_validar', { caso, paquete });
    const data = object(parsed(validation).data);
    if (data.apta !== true)
      return reply(
        `Solicitud bloqueada. No se creará la OC.\n${JSON.stringify(data.bloqueos, null, 2)}\nSolicita corregir los datos o la aprobación antes de volver a procesar.`,
      );
    const built = find('oc_construir_payload');
    if (!built) return invoke('oc_construir_payload', { caso, paquete, derivados: data.derivados });
    if (Array.isArray(data.confirmaciones) && data.confirmaciones.length && !state?.humanPermission)
      return reply('Se requiere confirmación antes de crear.');
    if (state?.preview && !state.humanPermission) return reply('Payload preparado para revisión.');
    const evidence = find('oc_generar_evidencia');
    if (!evidence) return invoke('oc_generar_evidencia', { caso });
    const created = find('oc_crear');
    if (!created) return invoke('oc_crear', { caso, payload: object(parsed(built).data).payload });
    return reply(
      `OC creada en SAP simulado: ${JSON.stringify(parsed(created).data)}\nEvidencia: ${JSON.stringify(parsed(evidence).data)}\nValores derivados informados: ${JSON.stringify(data.derivados)}.`,
    );
  }
}

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z, type ZodTypeAny } from 'zod';
import type { LlmAdapter, Registry, Message, ToolDefinition, ToolCall } from '../llm/adapter.js';
import { SessionStore, type ChatResult, type VisibleCall } from './session.js';
import { appendOutput, serial } from '../domain/files.js';

export const DEFAULT_SESSION_TOKENS = 400000;
export const DEFAULT_GLOBAL_TOKENS = 1000000;

export interface AgentOptions {
  directory: string;
  adapter: LlmAdapter;
  registry: Registry;
  systemPrompt?: string;
  maxIterations?: number;
  maxSessionTokens?: number;
  maxGlobalTokens?: number;
  maxCompletionTokens?: number;
  timeoutMs?: number;
  maxSessions?: number;
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function envelope(result: string): Record<string, unknown> {
  try {
    return record(JSON.parse(result));
  } catch {
    return { ok: false, error: 'La herramienta devolvió una respuesta inválida.' };
  }
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}
function jsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const description = schema.description;
  let inner = schema;
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodNullable ||
    inner instanceof z.ZodDefault
  )
    inner = inner._def.innerType;
  let result: Record<string, unknown> = {};
  if (inner instanceof z.ZodString) result = { type: 'string' };
  if (inner instanceof z.ZodNumber) result = { type: 'number' };
  if (inner instanceof z.ZodBoolean) result = { type: 'boolean' };
  if (inner instanceof z.ZodEnum) result = { type: 'string', enum: inner.options };
  if (inner instanceof z.ZodArray) result = { type: 'array', items: jsonSchema(inner.element) };
  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as z.ZodRawShape;
    result = {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(shape).map(([key, field]) => [key, jsonSchema(field)]),
      ),
      required: Object.entries(shape)
        .filter(([, field]) => !field.isOptional())
        .map(([key]) => key),
      additionalProperties: false,
    };
  }
  return description ? { ...result, description } : result;
}
export function createAgent(options: AgentOptions) {
  const { directory, adapter, registry } = options;
  const store = new SessionStore(options.maxSessions);
  const definitions: ToolDefinition[] = Object.entries(registry).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: jsonSchema(z.object(tool.args)),
  }));
  let globalTokens = 0;
  let activeTurns = 0;
  const loadPrompt = async () =>
    options.systemPrompt ??
    `${await readFile(join(directory, 'agent/prompt.md'), 'utf8')}\n\n${await readFile(join(directory, 'src/knowledge/ordenes-compra.md'), 'utf8')}`;
  const scrub = (text: string) => {
    for (const key of [process.env.LLM_API_KEY, process.env.OPENAI_API_KEY])
      if (key) text = text.split(key).join('[secreto oculto]');
    return text;
  };
  async function chat(message: string, sessionId?: string): Promise<ChatResult> {
    const session = store.obtain(sessionId);
    if (session.busy)
      throw new Error('Ya hay un turno en curso en esta sesión. Espera a que termine.');
    if (activeTurns >= 4) throw new Error('El servidor está ocupado. Intenta más tarde.');
    session.busy = true;
    activeTurns++;
    const visible: VisibleCall[] = [];
    const turn: Message[] = [{ role: 'user', content: message }];
    let reply = '';
    const mentionedCases = [...message.toLowerCase().matchAll(/\bsol-\d{3}\b/g)].map(
      (match) => match[0],
    );
    const explicitCase = mentionedCases.length === 1 ? mentionedCases[0] : undefined;
    const normalized = message
      .trim()
      .toLowerCase()
      .replace(/[.!¡¿?]+$/g, '')
      .trim();
    const previousPending = session.pending;
    session.pending = undefined;
    const confirms =
      /^(?:sí|si|confirmo|confirmar|confirmado|sí,? confirmo|si,? confirmo|confirmo la creación|confirmo crear|crear la oc|autorizo)(?:\s+(?:la\s+)?(?:sol-\d{3}))?$/.test(
        normalized,
      );
    const humanPermission =
      confirms && !!previousPending && (!explicitCase || explicitCase === previousPending.caso);
    const preview =
      /\b(?:preview|vista previa|mu[eé]strame|mostrar|revisar)\b|no (?:la )?cre(?:es|ar)|hasta que.*confirm/i.test(
        message,
      );
    // Default to refusal for any remaining "no", regardless of the following verb.
    // Exempt only the safe condition and the prohibition already enforced by preview.
    const negationText = normalized
      .replace(/\bsi\s+no\s+hay\s+bloqueos\b/g, '')
      .replace(/\bno (?:la )?cre(?:es|ar)\b/g, '');
    const declined = /\b(?:no|cancelar|cancela|rechazo)\b/.test(negationText);
    const actionRequested = !!explicitCase || humanPermission;
    const creationRequested =
      humanPermission ||
      /\b(?:procesa|procesar|crea|crear|genera|generar|tramita|tramitar)\b/i.test(message);
    if (explicitCase) session.selectedCase = explicitCase;
    if (humanPermission) session.selectedCase = previousPending?.caso;
    const selectedCase = session.selectedCase;
    let latestValidation: Record<string, unknown> | undefined;
    let payloadBuilt = false;
    let created = false;
    let executedCalls = 0;
    let completionCorrections = 0;
    async function execute(call: ToolCall): Promise<string> {
      const tool = registry[call.name];
      let result: string;
      if (++executedCalls > 40)
        result = JSON.stringify({
          ok: false,
          error: 'Límite de herramientas por turno alcanzado.',
        });
      else if (!tool) result = JSON.stringify({ ok: false, error: 'Herramienta desconocida.' });
      else {
        const parsed = z.object(tool.args).strict().safeParse(call.args);
        if (!parsed.success)
          result = JSON.stringify({
            ok: false,
            error: 'Argumentos inválidos.',
            detalles: parsed.error.issues.map((issue) => ({
              campo: issue.path.join('.'),
              error: issue.message,
            })),
          });
        else if (
          'caso' in parsed.data &&
          (typeof parsed.data.caso !== 'string' ||
            !/^sol-\d{3}$/.test(parsed.data.caso) ||
            parsed.data.caso !== selectedCase ||
            !actionRequested ||
            mentionedCases.length > 1)
        )
          result = JSON.stringify({
            ok: false,
            error:
              'La herramienta debe operar sobre el único caso solicitado por el usuario en este turno.',
          });
        else if (call.name === 'oc_crear') {
          if (declined || !actionRequested)
            result = JSON.stringify({
              ok: false,
              error: 'La creación no está autorizada en este turno.',
            });
          else {
            // Releer y validar siempre, incluso si el modelo salta pasos o inventa confirmado.
            const read = envelope(
              await execute({
                id: `${call.id}-read`,
                name: 'oc_leer_paquete',
                args: { caso: selectedCase },
              }),
            );
            const validation =
              read.ok === true
                ? envelope(
                    await execute({
                      id: `${call.id}-validate`,
                      name: 'oc_validar',
                      args: { caso: selectedCase, paquete: read.data },
                    }),
                  )
                : read;
            const data = record(validation.data);
            const reasons = strings(data.confirmaciones);
            if (validation.ok !== true || data.apta !== true || strings(data.bloqueos).length)
              result = JSON.stringify({
                ok: false,
                error: 'La solicitud tiene bloqueos o no pudo validarse.',
                bloqueos: data.bloqueos ?? [],
              });
            else if ((reasons.length || preview) && !humanPermission) {
              session.pending = {
                caso: selectedCase!,
                reasons: reasons.length ? reasons : ['Revisión del payload antes de crear'],
              };
              result = JSON.stringify({
                ok: false,
                error: 'Se requiere confirmación humana en el siguiente mensaje.',
                confirmaciones: session.pending.reasons,
              });
            } else {
              const built = envelope(
                await execute({
                  id: `${call.id}-payload`,
                  name: 'oc_construir_payload',
                  args: { caso: selectedCase, paquete: read.data, derivados: data.derivados },
                }),
              );
              const evidence =
                built.ok === true
                  ? envelope(
                      await execute({
                        id: `${call.id}-evidence`,
                        name: 'oc_generar_evidencia',
                        args: { caso: selectedCase },
                      }),
                    )
                  : built;
              if (built.ok !== true || evidence.ok !== true)
                result = JSON.stringify({
                  ok: false,
                  error: 'No fue posible preparar el payload o la evidencia; no se creó la OC.',
                });
              else
                result = await tool.execute(
                  {
                    ...parsed.data,
                    payload: record(built.data).payload,
                    confirmado: humanPermission,
                  },
                  { directory, sessionId: session.id },
                );
            }
          }
        } else {
          try {
            result = await tool.execute(parsed.data, { directory, sessionId: session.id });
          } catch {
            result = JSON.stringify({
              ok: false,
              error: 'La herramienta no pudo ejecutarse. Revisa los archivos del caso.',
            });
          }
        }
      }
      result = scrub(result);
      if (Buffer.byteLength(result) > 100000)
        result = JSON.stringify({
          ok: false,
          error: 'La respuesta de la herramienta excede el límite permitido.',
        });
      const response = envelope(result);
      if (call.name === 'oc_validar' && response.ok === true)
        latestValidation = record(response.data);
      if (call.name === 'oc_construir_payload' && response.ok === true) payloadBuilt = true;
      if (call.name === 'oc_crear' && response.ok === true) {
        created = true;
        session.pending = undefined;
      }
      visible.push({
        name: call.name,
        args: JSON.parse(scrub(JSON.stringify(call.args ?? {}))) as unknown,
        result,
      });
      await serial(resolve(directory, 'out/log.jsonl'), () =>
        appendOutput(
          directory,
          'out/log.jsonl',
          `${JSON.stringify({ ts: new Date().toISOString(), sessionId: session.id, ...visible[visible.length - 1] })}\n`,
        ),
      );
      return result;
    }
    try {
      const prompt = await loadPrompt();
      const messages: Message[] = [
        { role: 'system', content: prompt },
        ...session.turns.flat(),
        ...turn,
      ];
      // Server metadata informs orchestration; never treats model text as authorization.
      messages[0]!.content += `\nEstado del servidor: caso=${selectedCase ?? 'ninguno'}; permiso_humano=${humanPermission}; vista_previa=${preview}; cancelado=${declined}.`;
      if (previousPending && !humanPermission && !explicitCase) {
        reply = declined
          ? 'Solicitud cancelada. No se creó ninguna OC.'
          : 'No recibí una confirmación explícita. No se creó la OC. Solicita otra vista previa para continuar.';
      } else {
        for (let iteration = 0; iteration < (options.maxIterations ?? 12); iteration++) {
          const completionLimit = options.maxCompletionTokens ?? 1500;
          // UTF-8 bytes conservatively reserve input tokens; usage returned by the provider is tracked separately.
          const reservation =
            Buffer.byteLength(JSON.stringify({ messages, definitions })) + completionLimit + 1024;
          if (
            adapter.provider !== 'offline' &&
            (session.budgetTokens + reservation >
              (options.maxSessionTokens ?? DEFAULT_SESSION_TOKENS) ||
              globalTokens + reservation > (options.maxGlobalTokens ?? DEFAULT_GLOBAL_TOKENS))
          ) {
            reply =
              'Se alcanzó el límite de tokens disponible. El procesamiento se detuvo; revisa las llamadas realizadas.';
            break;
          }
          if (adapter.provider !== 'offline') {
            session.budgetTokens += reservation;
            globalTokens += reservation;
          }
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('timeout'));
            }, options.timeoutMs ?? 30000);
          });
          let response;
          try {
            response = await Promise.race([
              adapter.enviar(messages, definitions, {
                maxTokens: completionLimit,
                signal: controller.signal,
                serverState: { caso: selectedCase, humanPermission, preview, cancelled: declined },
              }),
              timeout,
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
          session.usedTokens +=
            typeof response.tokens === 'number' && Number.isFinite(response.tokens)
              ? Math.max(0, response.tokens)
              : 0;
          if (
            adapter.provider !== 'offline' &&
            typeof response.tokens === 'number' &&
            response.tokens > reservation
          ) {
            session.budgetTokens += response.tokens - reservation;
            globalTokens += response.tokens - reservation;
          }
          // Reject the batch before retaining assistant calls without matching tool replies.
          if (response.toolCalls.length > 10) {
            reply =
              'El modelo pidió demasiadas herramientas en una sola respuesta. Turno detenido.';
            break;
          }
          const assistant: Message = {
            role: 'assistant',
            content: scrub(response.content),
            ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
          };
          if (
            !response.toolCalls.length &&
            adapter.provider === 'ollama-local' &&
            actionRequested
          ) {
            if (created) break; // El recibo final se construye únicamente con el resultado de la herramienta.
            const blocked = strings(latestValidation?.bloqueos);
            const needsReview = preview || strings(latestValidation?.confirmaciones).length > 0;
            let correction = '';
            if (!declined && !blocked.length) {
              if (!latestValidation && !humanPermission && (creationRequested || preview)) {
                correction =
                  'Falta validar la solicitud con las herramientas: usa oc_leer_paquete y oc_validar antes de responder. La vista previa nunca autoriza crear una OC.';
              } else if (
                needsReview &&
                !humanPermission &&
                latestValidation?.apta === true &&
                !payloadBuilt
              ) {
                correction =
                  'Falta la vista previa: llama ahora a oc_construir_payload con el caso y los datos obtenidos. No crees la OC ni termines antes de mostrar ese resultado.';
              } else if (creationRequested && (humanPermission || !needsReview)) {
                correction =
                  latestValidation?.apta === true || humanPermission
                    ? 'No existe un resultado exitoso de oc_crear en este turno. Completa las herramientas pendientes y llama a oc_crear. El backend revalidará los datos y la autorización; no afirmes creación antes de su resultado.'
                    : 'Todavía no has completado las herramientas de la solicitud. Empieza por oc_leer_paquete y oc_validar. Usa sus resultados para continuar; no inventes una creación.';
              }
            }
            if (
              correction &&
              completionCorrections < 2 &&
              iteration + 1 < (options.maxIterations ?? 12)
            ) {
              completionCorrections++;
              // La corrección no es confirmación humana y no cambia los permisos del turno.
              // No conservar una afirmación prematura del modelo en la sesión.
              messages.push(assistant, { role: 'system', content: correction });
              continue;
            }
            if (declined) reply = 'No se creó ninguna OC. La solicitud fue cancelada.';
            else if (blocked.length) reply = `No se creó ninguna OC. ${blocked.join('\n')}`;
            else if (correction)
              reply =
                'No se creó ninguna OC: el modelo no completó las herramientas necesarias. Solicita una nueva revisión para continuar.';
            else
              reply =
                assistant.content ||
                'El modelo no devolvió una respuesta. Puedes intentar de nuevo.';
            break;
          }
          messages.push(assistant);
          turn.push(assistant);
          if (!response.toolCalls.length) {
            reply =
              assistant.content || 'El modelo no devolvió una respuesta. Puedes intentar de nuevo.';
            break;
          }
          for (const call of response.toolCalls) {
            const result = await execute(call);
            const toolMessage: Message = {
              role: 'tool',
              content: result,
              toolCallId: call.id,
              name: call.name,
            };
            messages.push(toolMessage);
            turn.push(toolMessage);
          }
          if (executedCalls > 40) {
            reply =
              'Se alcanzó el límite de herramientas de este turno. Revisa las llamadas realizadas.';
            break;
          }
          if (session.pending) break;
          if (iteration + 1 === (options.maxIterations ?? 12))
            reply =
              'Se alcanzó el límite de iteraciones. Revisa las herramientas ejecutadas y solicita continuar si hace falta.';
        }
      }
      if (
        !created &&
        latestValidation?.apta === true &&
        !declined &&
        actionRequested &&
        (strings(latestValidation.confirmaciones).length || (preview && payloadBuilt)) &&
        !humanPermission
      ) {
        session.pending = {
          caso: selectedCase!,
          reasons: strings(latestValidation.confirmaciones).length
            ? strings(latestValidation.confirmaciones)
            : ['Revisar el payload antes de crear'],
        };
      }
      if (session.pending) {
        const payloadCall = [...visible]
          .reverse()
          .find(
            (call) => call.name === 'oc_construir_payload' && envelope(call.result).ok === true,
          );
        const previewText = payloadCall
          ? `\n\nPayload listo para SAP:\n${JSON.stringify(record(envelope(payloadCall.result).data).payload, null, 2)}`
          : '';
        reply = `La solicitud ${session.pending.caso} está pendiente de confirmación:\n${session.pending.reasons.map((reason) => `• ${reason}`).join('\n')}${previewText}\n\n¿Confirmas crear esta OC? Responde «confirmo» o «no».`;
      }
    } catch (error) {
      reply =
        error instanceof Error && error.message === 'timeout'
          ? 'El proveedor de lenguaje excedió el tiempo de espera. Puedes intentar de nuevo.'
          : 'No fue posible completar el turno por un error del proveedor o de archivos. Revisa la configuración e intenta de nuevo.';
      session.pending = undefined;
      turn.splice(1); // Drop an incomplete assistant/tool exchange before the next provider request.
    } finally {
      session.busy = false;
      activeTurns--;
      session.touched = Date.now();
    }
    const createdCall = [...visible]
      .reverse()
      .find((call) => call.name === 'oc_crear' && envelope(call.result).ok === true);
    const orderNumber = createdCall
      ? record(envelope(createdCall.result).data).numero_oc
      : undefined;
    if (typeof orderNumber === 'string' && adapter.provider === 'ollama-local') {
      const idempotent = record(envelope(createdCall!.result).data).idempotente === true;
      reply = `OC ${idempotent ? 'ya registrada' : 'creada'} en SAP simulado: ${orderNumber}.${idempotent ? ' Se devolvió la orden existente sin duplicarla.' : ' La creación quedó registrada con su evidencia de aprobación.'}`;
    } else if (typeof orderNumber === 'string' && !reply.includes(orderNumber)) {
      reply = `OC creada en SAP simulado: ${orderNumber}. La creación ya quedó registrada.\n\n${reply}`;
    }
    reply = scrub(reply).slice(0, 16000);
    if (turn[turn.length - 1]?.content !== reply || turn[turn.length - 1]?.role !== 'assistant')
      turn.push({ role: 'assistant', content: reply });
    if (Buffer.byteLength(JSON.stringify(turn)) > 50000)
      turn.splice(1, turn.length - 1, { role: 'assistant', content: reply });
    session.turns.push(turn);
    while (
      session.turns.length > 8 ||
      (session.turns.length > 1 && Buffer.byteLength(JSON.stringify(session.turns)) > 50000)
    )
      session.turns.shift();
    const historyCallLimit = Math.min(4000, Math.floor(100000 / Math.max(1, visible.length)));
    const historyCalls = visible.map((call) => ({
      ...call,
      args:
        Buffer.byteLength(JSON.stringify(call.args)) > historyCallLimit / 4
          ? '[argumentos largos truncados en historial]'
          : call.args,
      result:
        Buffer.byteLength(call.result) > historyCallLimit
          ? `${Buffer.from(call.result).subarray(0, historyCallLimit).toString('utf8')}\n[resultado truncado en historial]`
          : call.result,
    }));
    session.history.push(
      { role: 'user', content: scrub(message) },
      {
        role: 'assistant',
        content: reply,
        toolCalls: historyCalls,
        needsConfirmation: !!session.pending,
      },
    );
    while (
      session.history.length > 40 ||
      (session.history.length > 2 && Buffer.byteLength(JSON.stringify(session.history)) > 200000)
    )
      session.history.splice(0, 2);
    return {
      sessionId: session.id,
      reply,
      toolCalls: visible,
      needsConfirmation: !!session.pending,
    };
  }
  return {
    chat,
    getSession(id: string) {
      const session = store.get(id);
      return session
        ? {
            sessionId: session.id,
            history: session.history,
            needsConfirmation: !!session.pending,
            usedTokens: session.usedTokens,
            budgetTokens: session.budgetTokens,
          }
        : undefined;
    },
  };
}

import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import {
  appendOutput,
  checkCaso,
  errorMessage,
  readOptional,
  serial,
  diskLock,
  type Context,
} from '../domain/files.js';
import { leer, maestros } from '../domain/package.js';
import { paqueteSchema, ordenCompraSchema } from '../domain/schemas.js';
import { controles, type Validacion } from '../domain/controls.js';
import { construir, evidencia } from '../domain/payload.js';
import { MockSapAdapter } from '../sap/mock.js';
const caso = z
  .string()
  .regex(/^sol-\d{3}$/)
  .describe('Carpeta del caso, por ejemplo sol-001');
const paquete = z.unknown().describe('Paquete devuelto por oc_leer_paquete');
async function run(ctx: Context, name: string, fn: () => Promise<unknown>): Promise<string> {
  let result: unknown;
  try {
    result = { ok: true, data: await fn() };
  } catch (error) {
    result = { ok: false, error: errorMessage(error) };
  }
  try {
    await serial(path.resolve(ctx.directory, 'out/log.jsonl'), () =>
      appendOutput(
        ctx.directory,
        'out/log.jsonl',
        JSON.stringify({
          ts: new Date().toISOString(),
          sessionId: ctx.sessionId,
          tool: name,
          result,
        }) + '\n',
      ),
    );
  } catch {
    return JSON.stringify({
      ok: false,
      error: 'No se pudo escribir el log de auditoría; revise permisos de out/',
    });
  }
  return JSON.stringify(result);
}
export const leer_paquete = {
  description:
    'Lee y normaliza solicitud, correo, cotización, aprobación y factura desde fixtures.',
  args: { caso },
  execute(args: { caso: string }, ctx: Context): Promise<string> {
    return run(ctx, 'oc_leer_paquete', () => leer(ctx.directory, args.caso));
  },
};
export const validar = {
  description:
    'Aplica RC1–RC10 y catálogos para devolver bloqueos, confirmaciones y valores derivados.',
  args: { caso, paquete },
  execute(args: { caso: string; paquete: unknown }, ctx: Context): Promise<string> {
    return run(ctx, 'oc_validar', async () => {
      checkCaso(args.caso);
      const p = paqueteSchema.parse(args.paquete);
      const validation = controles(p, await maestros(ctx.directory));
      if (!validation.apta || validation.confirmaciones.length)
        await control(
          ctx,
          p.solicitud.solicitud_id,
          validation.apta ? 'pendiente' : 'bloqueado',
          '',
          validation,
        );
      return validation;
    });
  },
};
export const construir_payload = {
  description:
    'Construye una OC trazable desde datos autoritativos releídos y genera evidencia de aprobación.',
  args: {
    caso,
    paquete,
    derivados: z.unknown().describe('Valores derivados devueltos por oc_validar'),
  },
  execute(
    args: { caso: string; paquete: unknown; derivados: unknown },
    ctx: Context,
  ): Promise<string> {
    return run(ctx, 'oc_construir_payload', async () => {
      const p = paqueteSchema.parse(await leer(ctx.directory, args.caso));
      return construir(ctx.directory, args.caso, p, await maestros(ctx.directory));
    });
  },
};
export const generar_evidencia = {
  description: 'Escribe el correo de aprobación con encabezados y su hash SHA256 en out del caso.',
  args: { caso },
  execute(args: { caso: string }, ctx: Context): Promise<string> {
    return run(ctx, 'oc_generar_evidencia', () => evidencia(ctx.directory, args.caso));
  },
};
const csv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
async function control(
  ctx: Context,
  id: string,
  resultado: string,
  numero: string,
  validation?: Validacion,
) {
  return diskLock(ctx.directory, 'out/.control.lock', async () => {
    const relative = 'out/control.csv';
    if ((await readOptional(ctx.directory, relative)) === null)
      await appendOutput(
        ctx.directory,
        relative,
        'solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n',
      );
    await appendOutput(
      ctx.directory,
      relative,
      [
        id,
        resultado,
        numero,
        validation?.retroactiva ?? false,
        (validation?.bloqueos ?? []).join(' | '),
        (validation?.confirmaciones ?? []).join(' | '),
        new Date().toISOString(),
      ]
        .map(csv)
        .join(',') + '\n',
    );
  });
}
export const crear = {
  description:
    'Revalida datos y payload, exige confirmaciones y crea la OC idempotente en SAP simulado.',
  args: {
    caso,
    payload: z.unknown().describe('OrdenCompra exacta devuelta por oc_construir_payload'),
    confirmado: z
      .boolean()
      .optional()
      .describe('Confirmación humana de todas las excepciones; backend controla el permiso'),
  },
  execute(
    args: { caso: string; payload: unknown; confirmado?: boolean },
    ctx: Context,
  ): Promise<string> {
    return run(ctx, 'oc_crear', async () => {
      let id = args.caso;
      let validation: Validacion | undefined;
      let attempted = false;
      try {
        const p = paqueteSchema.parse(await leer(ctx.directory, args.caso));
        id = p.solicitud.solicitud_id;
        validation = controles(p, await maestros(ctx.directory));
        if (!validation.apta) {
          attempted = true;
          await control(ctx, id, 'bloqueado', '', validation);
          throw new Error(validation.bloqueos.join(' '));
        }
        if (validation.confirmaciones.length && !args.confirmado) {
          attempted = true;
          await control(ctx, id, 'pendiente', '', validation);
          throw new Error(`Confirmación humana requerida: ${validation.confirmaciones.join(' ')}`);
        }
        ordenCompraSchema.parse(args.payload);
        const { payload: expected } = await construir(
          ctx.directory,
          args.caso,
          p,
          await maestros(ctx.directory),
        );
        if (!isDeepStrictEqual(args.payload, expected))
          throw new Error('Payload alterado o desactualizado; reconstruya la OC desde fixtures.');
        return await serial(path.resolve(ctx.directory, 'out/create'), async () => {
          const sap = new MockSapAdapter(ctx.directory);
          const saved = structuredClone(expected);
          if (args.confirmado)
            saved.excepciones.forEach((e) => {
              e.confirmado_por = ctx.sessionId;
            });
          const result = await sap.crearOrden(saved);
          attempted = true;
          await control(
            ctx,
            id,
            result.idempotente ? 'idempotente' : 'creada',
            result.numero_oc,
            validation,
          );
          return result;
        });
      } catch (error) {
        if (!attempted) await control(ctx, id, 'error', '', validation);
        throw error;
      }
    });
  },
};

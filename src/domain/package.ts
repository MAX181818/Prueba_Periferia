import { z } from 'zod';
import {
  aprobacionRawSchema,
  centroSchema,
  correoSchema,
  ivaSchema,
  pagoSchema,
  proveedorSchema,
  solicitudSchema,
  type Maestros,
} from './schemas.js';
import { checkCaso, readJson, readOptional } from './files.js';

function capture(text: string, pattern: RegExp, label: string): string {
  const value = pattern.exec(text)?.[1]?.trim();
  if (!value) throw new Error(`No se pudo leer ${label}; solicite el documento completo`);
  return value;
}
function total(text: string): number {
  return Number(
    capture(text, /^TOTAL[^:\r\n]*:\s*(?:COP|USD)\s*([\d.,]+)/im, 'total')
      .replace(/\./g, '')
      .replace(',', '.'),
  );
}
export async function leer(directory: string, caso: string) {
  checkCaso(caso);
  const base = `fixtures/reto-03/solicitudes/${caso}/`;
  const [correo, solicitud, quote, approval, invoice] = await Promise.all([
    readJson(directory, base + 'correo.json'),
    readJson(directory, base + 'solicitud.json'),
    readOptional(directory, base + 'cotizacion.txt'),
    readJson(directory, base + 'aprobacion.json'),
    readOptional(directory, base + 'factura.txt'),
  ]);
  const aprobacion = approval === null ? null : aprobacionRawSchema.parse(approval);
  const faltantes = [
    ...(correo === null ? ['correo.json'] : []),
    ...(solicitud === null ? ['solicitud.json'] : []),
    ...(quote === null ? ['cotizacion.txt'] : []),
    ...(approval === null ? ['aprobacion.json'] : []),
  ];
  return {
    correo: correo === null ? null : correoSchema.parse(correo),
    solicitud: solicitud === null ? null : solicitudSchema.parse(solicitud),
    cotizacion:
      quote === null
        ? null
        : {
            proveedor: capture(quote, /^Proveedor:\s*(.+)$/im, 'proveedor'),
            nit: /^NIT:\s*(.+)$/im.exec(quote)?.[1]?.trim() ?? null,
            total: total(quote),
            moneda: capture(quote, /^TOTAL[^:\r\n]*:\s*(COP|USD)/im, 'moneda'),
            validez_hasta: null,
            texto: quote,
          },
    aprobacion:
      aprobacion === null
        ? null
        : {
            de: aprobacion.de,
            fecha: aprobacion.fecha,
            aprobado:
              /\baprobado\b/i.test(aprobacion.cuerpo) &&
              !/\b(?:no\s+aprobado|rechazado)\b/i.test(aprobacion.cuerpo),
            texto: aprobacion.cuerpo,
          },
    factura:
      invoice === null
        ? null
        : {
            numero: capture(invoice, /No\.\s*(\S+)/i, 'número factura'),
            fecha: capture(invoice, /Fecha de emisión:\s*(\d{4}-\d{2}-\d{2})/i, 'fecha factura'),
            total: total(invoice),
          },
    faltantes,
  };
}
export async function maestros(directory: string): Promise<Maestros> {
  const base = 'fixtures/reto-03/maestros/';
  const [p, c, i, g] = await Promise.all([
    readJson(directory, base + 'proveedores.json'),
    readJson(directory, base + 'centros-costo.json'),
    readJson(directory, base + 'indicadores-iva.json'),
    readJson(directory, base + 'condiciones-pago.json'),
  ]);
  return {
    proveedores: z.array(proveedorSchema).parse(p),
    centros: z.array(centroSchema).parse(c),
    ivas: z.array(ivaSchema).parse(i),
    pagos: z.array(pagoSchema).parse(g),
  };
}

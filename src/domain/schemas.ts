import { z } from 'zod';

export const fecha = z.string().refine((value) => {
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return false;
  const parsed = new Date(day + 'T00:00:00Z');
  return (
    Number.isFinite(Date.parse(value)) &&
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === day
  );
}, 'Fecha inválida; use ISO 8601');
const text = z.string().trim().min(1);
const email = text.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Correo inválido');
const positive = z.number().finite().positive();
export const solicitudSchema = z.object({
  solicitud_id: text,
  solicitante: text,
  proveedor_nombre: text,
  proveedor_nit: text.optional(),
  descripcion: text,
  centro_costo: text,
  subarea: text,
  cantidad: positive,
  valor_unitario: positive,
  valor_total: positive,
  moneda: z.enum(['COP', 'USD']),
  indicador_iva: text.optional(),
  condiciones_pago: text.optional(),
  fecha_solicitud: fecha,
});
export const aprobacionRawSchema = z.object({
  de: email,
  para: text,
  fecha,
  asunto: text,
  cuerpo: text,
});
export const correoSchema = z.object({ id: text, de: email, asunto: text, fecha });
export const paqueteSchema = z.object({
  correo: correoSchema,
  solicitud: solicitudSchema,
  cotizacion: z
    .object({
      proveedor: text,
      nit: z.string().nullable(),
      total: positive,
      moneda: z.enum(['COP', 'USD']),
      validez_hasta: fecha.nullable(),
      texto: text,
    })
    .nullable(),
  aprobacion: z
    .object({ de: z.string().email(), fecha, aprobado: z.boolean(), texto: text })
    .nullable(),
  factura: z.object({ numero: text, fecha, total: positive }).nullable(),
});
export type Paquete = z.infer<typeof paqueteSchema>;
export const proveedorSchema = z.object({
  codigo_sap: text,
  nit: text,
  nombre: text,
  condiciones_pago_default: text,
  indicador_iva_default: text,
  activo: z.boolean(),
});
export const centroSchema = z.object({
  centro_costo: text,
  subareas: z.array(text),
  aprobadores: z.array(z.object({ email: z.string().email(), tope: positive })),
});
export const ivaSchema = z.object({
  codigo: text,
  descripcion: text,
  tasa: z.number().finite().nonnegative(),
});
export const pagoSchema = z.object({
  codigo: text,
  descripcion: text,
  dias: z.number().int().nonnegative(),
});
export type Proveedor = z.infer<typeof proveedorSchema>;
export type Maestros = {
  proveedores: Proveedor[];
  centros: z.infer<typeof centroSchema>[];
  ivas: z.infer<typeof ivaSchema>[];
  pagos: z.infer<typeof pagoSchema>[];
};
export const ordenCompraSchema = z
  .object({
    referencia: z.object({
      solicitud_id: text,
      correo_id: text,
      cotizacion_ref: z.string().nullable(),
    }),
    sociedad: z.literal('1000'),
    organizacion_compras: z.literal('1000'),
    proveedor: z.object({ codigo_sap: text, nit: text, nombre: text }),
    moneda: z.enum(['COP', 'USD']),
    condiciones_pago: text,
    aprobador: z.object({
      email: z.string().email(),
      fecha_aprobacion: fecha,
      evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    posiciones: z
      .array(
        z.object({
          numero: z.number().int().positive(),
          descripcion: text.max(40),
          cantidad: positive,
          unidad: z.enum(['UN', 'H', 'MES']),
          precio_unitario: positive,
          centro_costo: text,
          subarea: text,
          indicador_iva: text,
        }),
      )
      .min(1),
    excepciones: z.array(
      z.object({ codigo: text, detalle: text, confirmado_por: z.string().nullable() }),
    ),
  })
  .strict();
export type OrdenCompra = z.infer<typeof ordenCompraSchema>;

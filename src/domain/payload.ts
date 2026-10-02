import { createHash } from 'node:crypto';
import {
  aprobacionRawSchema,
  ordenCompraSchema,
  type Maestros,
  type OrdenCompra,
  type Paquete,
} from './schemas.js';
import { checkCaso, readJson, writeOutput } from './files.js';
import { controles, proveedor } from './controls.js';
export async function evidencia(
  directory: string,
  caso: string,
): Promise<{ ruta: string; sha256: string }> {
  checkCaso(caso);
  const approval = aprobacionRawSchema.parse(
    await readJson(directory, `fixtures/reto-03/solicitudes/${caso}/aprobacion.json`),
  );
  const content = `De: ${approval.de}\nPara: ${approval.para}\nFecha: ${approval.fecha}\nAsunto: ${approval.asunto}\n\n${approval.cuerpo}\n`;
  const sha256 = createHash('sha256').update(content).digest('hex');
  const ruta = `out/${caso}/aprobacion.txt`;
  await writeOutput(directory, ruta, content + `SHA256: ${sha256}\n`);
  return { ruta, sha256 };
}
export async function construir(
  directory: string,
  caso: string,
  p: Paquete,
  m: Maestros,
): Promise<{ payload: OrdenCompra; ruta_trazabilidad: string }> {
  const validation = controles(p, m);
  if (!validation.apta) throw new Error(validation.bloqueos.join(' '));
  const s = p.solicitud;
  const vendor = proveedor(p, m);
  if (!vendor || !p.aprobacion) throw new Error('Falta proveedor o aprobación');
  const evidence = await evidencia(directory, caso);
  const payload = ordenCompraSchema.parse({
    referencia: {
      solicitud_id: s.solicitud_id,
      correo_id: p.correo.id,
      cotizacion_ref: p.cotizacion ? `${caso}/cotizacion.txt` : null,
    },
    sociedad: '1000',
    organizacion_compras: '1000',
    proveedor: { codigo_sap: vendor.codigo_sap, nit: vendor.nit, nombre: vendor.nombre },
    moneda: s.moneda,
    condiciones_pago: s.condiciones_pago ?? validation.derivados.condiciones_pago,
    aprobador: {
      email: p.aprobacion.de,
      fecha_aprobacion: p.aprobacion.fecha,
      evidencia_sha256: evidence.sha256,
    },
    posiciones: [
      {
        numero: 10,
        descripcion: s.descripcion.slice(0, 40),
        cantidad: s.cantidad,
        unidad: /\bhora/i.test(s.descripcion) ? 'H' : 'UN',
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: s.indicador_iva ?? validation.derivados.indicador_iva,
      },
    ],
    excepciones: validation.confirmaciones.map((detalle) => ({
      codigo: detalle.split(':')[0],
      detalle,
      confirmado_por: null,
    })),
  });
  const trazabilidad: Record<string, { valor: unknown; fuente: string }> = {};
  const add = (key: string, valor: unknown, fuente: string) => {
    trazabilidad[key] = { valor, fuente };
  };
  add('referencia.solicitud_id', s.solicitud_id, 'solicitud');
  add('referencia.correo_id', p.correo.id, 'derivado: correo');
  add('referencia.cotizacion_ref', payload.referencia.cotizacion_ref, 'cotizacion');
  add('sociedad', '1000', 'derivado: sociedad configurada');
  add('organizacion_compras', '1000', 'derivado: organización configurada');
  for (const [key, value] of Object.entries(payload.proveedor))
    add(`proveedor.${key}`, value, 'maestro.proveedores');
  add('moneda', s.moneda, 'solicitud');
  add(
    'condiciones_pago',
    payload.condiciones_pago,
    s.condiciones_pago ? 'solicitud' : 'maestro.proveedores',
  );
  for (const [key, value] of Object.entries(payload.aprobador))
    add(
      `aprobador.${key}`,
      value,
      key === 'evidencia_sha256'
        ? 'derivado: SHA256 correo aprobación'
        : 'derivado: correo aprobación',
    );
  for (const [key, value] of Object.entries(payload.posiciones[0]))
    add(
      `posiciones.0.${key}`,
      value,
      key === 'numero' || key === 'unidad'
        ? 'derivado'
        : key === 'indicador_iva' && !s.indicador_iva
          ? 'maestro.proveedores'
          : 'solicitud',
    );
  payload.excepciones.forEach((excepcion, index) => {
    for (const [key, value] of Object.entries(excepcion))
      add(`excepciones.${index}.${key}`, value, 'derivado: controles');
  });
  const ruta_trazabilidad = `out/${caso}/trazabilidad.json`;
  await writeOutput(directory, ruta_trazabilidad, JSON.stringify(trazabilidad, null, 2));
  return { payload, ruta_trazabilidad };
}

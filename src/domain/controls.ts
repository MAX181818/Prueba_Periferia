import type { Maestros, Paquete, Proveedor } from './schemas.js';
export type Validacion = {
  apta: boolean;
  bloqueos: string[];
  confirmaciones: string[];
  derivados: { indicador_iva?: string; condiciones_pago?: string };
  retroactiva: boolean;
};
const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
export function proveedor(paquete: Paquete, m: Maestros): Proveedor | undefined {
  const s = paquete.solicitud;
  return m.proveedores.find((p) =>
    s.proveedor_nit
      ? p.nit === s.proveedor_nit.replace(/\D/g, '')
      : normalize(p.nombre) === normalize(s.proveedor_nombre),
  );
}
export function controles(p: Paquete, m: Maestros): Validacion {
  const s = p.solicitud;
  const vendor = proveedor(p, m);
  const centro = m.centros.find((c) => c.centro_costo === s.centro_costo);
  const approver = centro?.aprobadores.find(
    (a) => a.email.toLowerCase() === p.aprobacion?.de.toLowerCase(),
  );
  const bloqueos: string[] = [];
  const confirmaciones: string[] = [];
  const derivados: Validacion['derivados'] = {};
  if (!vendor?.activo)
    bloqueos.push(
      'RC1: Proveedor inexistente o inactivo; solicite alta o actualización del maestro.',
    );
  if (!p.aprobacion?.aprobado || !approver)
    bloqueos.push(
      'RC2: Falta aprobación válida de un aprobador del centro; solicite aprobación autorizada.',
    );
  if (approver && s.valor_total > approver.tope)
    bloqueos.push(
      `RC3: Monto ${s.valor_total} supera tope ${approver.tope}; solicite aprobación con autoridad suficiente.`,
    );
  if (!centro?.subareas.includes(s.subarea))
    bloqueos.push('RC4: Centro o subárea inválidos; corrija la solicitud.');
  if (!p.cotizacion) confirmaciones.push('RC5: No hay cotización; confirme si procede sin ella.');
  else if (Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total > 0.02)
    confirmaciones.push(
      `RC5: Solicitud ${s.valor_total} ${s.moneda} y cotización ${p.cotizacion.total} ${p.cotizacion.moneda} difieren más de 2%; confirme el monto de la solicitud.`,
    );
  if (p.cotizacion && p.cotizacion.moneda !== s.moneda)
    bloqueos.push('Moneda de cotización diferente a solicitud; solicite corrección.');
  if (!s.indicador_iva && vendor) {
    derivados.indicador_iva = vendor.indicador_iva_default;
    confirmaciones.push(
      `RC6: IVA no informado; confirme indicador ${vendor.indicador_iva_default} derivado del proveedor.`,
    );
  }
  if (!s.condiciones_pago && vendor) derivados.condiciones_pago = vendor.condiciones_pago_default;
  const retroactiva = !!p.factura && p.factura.fecha.slice(0, 10) < s.fecha_solicitud.slice(0, 10);
  if (retroactiva)
    confirmaciones.push(
      'RC8: Factura anterior a la solicitud; confirme la creación de OC retroactiva.',
    );
  if (p.aprobacion && p.aprobacion.fecha.slice(0, 10) < s.fecha_solicitud.slice(0, 10))
    confirmaciones.push('RC9: Aprobación anterior a solicitud; confirme su vigencia.');
  if (Math.abs(s.cantidad * s.valor_unitario - s.valor_total) > 1)
    bloqueos.push('RC10: Cantidad × precio unitario no coincide con total; corrija la solicitud.');
  if (!m.ivas.some((i) => i.codigo === (s.indicador_iva ?? derivados.indicador_iva)))
    bloqueos.push('Indicador IVA no existe en catálogo; solicite corrección.');
  if (!m.pagos.some((i) => i.codigo === (s.condiciones_pago ?? derivados.condiciones_pago)))
    bloqueos.push('Condiciones de pago no existen en catálogo; solicite corrección.');
  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva };
}

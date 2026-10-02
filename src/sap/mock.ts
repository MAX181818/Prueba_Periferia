import { z } from 'zod';
import { appendOutput, readOptional, diskLock } from '../domain/files.js';
import { maestros } from '../domain/package.js';
import { ordenCompraSchema, type OrdenCompra } from '../domain/schemas.js';
import type { SapAdapter } from './adapter.js';
const recordSchema = z.object({
  numero_oc: z.string(),
  fecha: z.string(),
  orden: ordenCompraSchema,
});
type Registro = z.infer<typeof recordSchema>;
export class MockSapAdapter implements SapAdapter {
  constructor(private readonly directory: string) {}
  async consultarProveedor(nit: string) {
    const p = (await maestros(this.directory)).proveedores.find((p) => p.nit === nit);
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null;
  }
  private async records(): Promise<Registro[]> {
    const text = await readOptional(this.directory, 'out/sap/ordenes.jsonl');
    return text
      ? text
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => recordSchema.parse(JSON.parse(line)))
      : [];
  }
  async buscarOrdenPorReferencia(solicitud_id: string) {
    const found = (await this.records()).find(
      (r) => r.orden.referencia.solicitud_id === solicitud_id,
    );
    return found ? { numero_oc: found.numero_oc } : null;
  }
  async crearOrden(
    orden: OrdenCompra,
  ): Promise<{ numero_oc: string; fecha: string; idempotente: boolean }> {
    ordenCompraSchema.parse(orden);
    return diskLock(this.directory, 'out/sap/.lock', async () => {
      const records = await this.records();
      const existing = records.find(
        (r) => r.orden.referencia.solicitud_id === orden.referencia.solicitud_id,
      );
      if (existing)
        return { numero_oc: existing.numero_oc, fecha: existing.fecha, idempotente: true };
      const numero_oc = String(
        Math.max(4500000000, ...records.map((r) => Number(r.numero_oc))) + 1,
      );
      const fecha = new Date().toISOString();
      await appendOutput(
        this.directory,
        'out/sap/ordenes.jsonl',
        JSON.stringify({ numero_oc, fecha, orden }) + '\n',
      );
      return { numero_oc, fecha, idempotente: false };
    });
  }
}

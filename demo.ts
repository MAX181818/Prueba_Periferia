import path from 'node:path';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as oc from './src/tools/oc.js';
import { safePath } from './src/domain/files.js';
const directory = path.dirname(fileURLToPath(import.meta.url));
const ctx = { directory, sessionId: 'demo-confirmacion-humana' };
const out = await safePath(directory, 'out');
if (path.dirname(out) !== path.resolve(directory) || path.basename(out) !== 'out')
  throw new Error('Destino de limpieza inválido');
await rm(out, { recursive: true, force: true });
type Result = { ok: boolean; data: Record<string, unknown>; error?: string };
const parse = (s: string) => JSON.parse(s) as Result;
async function processCase(caso: string, confirmado = false) {
  const read = parse(await oc.leer_paquete.execute({ caso }, ctx));
  if (!read.ok) {
    console.log(caso, read);
    return;
  }
  const validation = parse(await oc.validar.execute({ caso, paquete: read.data }, ctx));
  console.log(caso, JSON.stringify(validation.data));
  const build = parse(
    await oc.construir_payload.execute(
      { caso, paquete: read.data, derivados: validation.data?.derivados },
      ctx,
    ),
  );
  const result = parse(
    await oc.crear.execute({ caso, payload: build.data?.payload ?? {}, confirmado }, ctx),
  );
  console.log(caso, JSON.stringify(result));
}
for (let n = 1; n <= 6; n++) await processCase(`sol-${String(n).padStart(3, '0')}`);
console.log('Repetición sol-001:');
await processCase('sol-001');
console.log(
  'Confirmación humana explícita sol-004: se acepta total solicitud, distinto de cotización.',
);
await processCase('sol-004', true);

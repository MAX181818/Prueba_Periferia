import { appendFile, lstat, mkdir, readFile, writeFile, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

export type Context = { directory: string; sessionId: string };
export function checkCaso(caso: string): void {
  if (!/^sol-\d{3}$/.test(caso)) throw new Error('Caso inválido: use sol-001 a sol-006, sin rutas');
}
export async function safePath(directory: string, relative: string): Promise<string> {
  const root = path.resolve(directory);
  const result = path.resolve(root, relative);
  if (!result.startsWith(root + path.sep)) throw new Error('Ruta fuera del proyecto');
  let current = root;
  for (const segment of path.relative(root, result).split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('No se permiten enlaces simbólicos en fixtures/out');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return result;
}
export async function readOptional(directory: string, relative: string): Promise<string | null> {
  try {
    return await readFile(await safePath(directory, relative), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function readJson(directory: string, relative: string): Promise<unknown | null> {
  const text = await readOptional(directory, relative);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`JSON malformado en ${relative}; solicite el archivo corregido`);
  }
}
export async function writeOutput(
  directory: string,
  relative: string,
  value: string,
): Promise<void> {
  if (!relative.startsWith('out/')) throw new Error('Destino debe estar en out/');
  const filename = await safePath(directory, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, value, 'utf8');
}
export async function appendOutput(
  directory: string,
  relative: string,
  value: string,
): Promise<void> {
  const filename = await safePath(directory, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await appendFile(filename, value, 'utf8');
}
const queues = new Map<string, Promise<unknown>>();
export async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}
/** The directory is created exclusively: only its owner removes it. */
export async function diskLock<T>(
  directory: string,
  relative: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await safePath(directory, relative);
  return serial(lock, async () => {
    await mkdir(path.dirname(lock), { recursive: true });
    const started = Date.now();
    while (true) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() - started > 10000)
          throw new Error('Archivo de auditoría/SAP ocupado; reintente más tarde');
        await delay(25);
      }
    }
    try {
      return await fn();
    } finally {
      await rmdir(lock);
    }
  });
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error al procesar la solicitud';
}

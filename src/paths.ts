// Rutas de los datos importados con la base de Vite (`base` en vite.config.ts, p. ej. "/RRW/"). El importador
// escribe rutas absolutas desde la raíz de assets/ ("/sprites/…", "/audio/…"); aquí se les antepone la base.

const BASE = import.meta.env.BASE_URL; // termina en "/"

/** Ruta de un archivo de assets/ con la base delante (no la repite si ya la lleva). */
export function asset(path: string): string {
  if (/^[a-z]+:/i.test(path) || path.startsWith(BASE)) return path;
  return BASE + path.replace(/^\/+/, "");
}

/** Copia de un objeto (el manifiesto) con la base delante de todas las rutas absolutas que contiene. */
export function withBase<T>(value: T): T {
  if (typeof value === "string") return (value.startsWith("/") ? asset(value) : value) as T;
  if (Array.isArray(value)) return value.map(withBase) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withBase(v)])) as T;
  }
  return value;
}

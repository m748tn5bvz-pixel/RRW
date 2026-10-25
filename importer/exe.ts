// Datos que el motor necesita y que viven dentro de ROADRASH.EXE (se leen de la copia del usuario).

/** Convierte una dirección virtual en offset de archivo usando la tabla de secciones del PE. */
export function vaToFileOffset(exe: Uint8Array, va: number): number {
  const v = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  const pe = v.getUint32(0x3c, true);
  const nSec = v.getUint16(pe + 6, true);
  const optSize = v.getUint16(pe + 20, true);
  const imageBase = v.getUint32(pe + 24 + 28, true);
  const rva = va - imageBase;
  for (let i = 0; i < nSec; i++) {
    const s = pe + 24 + optSize + i * 40;
    const vaddr = v.getUint32(s + 12, true);
    const rawSize = v.getUint32(s + 16, true);
    const rawPtr = v.getUint32(s + 20, true);
    if (rva >= vaddr && rva < vaddr + rawSize) return rawPtr + (rva - vaddr);
  }
  throw new Error(`VA 0x${va.toString(16)} fuera de las secciones inicializadas`);
}

/**
 * Tablas de remapeo de colores de los pilotos (FUN_00443820): pixel' = tabla[pixel + corredor·256].
 * Base DAT_0046e158; corredores válidos < DAT_004642d4 − 1 (= 15).
 */
export const RIDER_REMAP_VA = 0x46e158;
export const RIDER_COUNT = 15;

export function readRiderRemaps(exe: Uint8Array): Uint8Array {
  const off = vaToFileOffset(exe, RIDER_REMAP_VA);
  return exe.slice(off, off + RIDER_COUNT * 256);
}

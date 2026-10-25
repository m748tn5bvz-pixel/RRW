// Familias de objetos (recursos 'FAM ' de FAMILIES.RSC, ya descomprimidas con PKWARE DCL).
//
// Evidencia en ROADRASH.EXE:
//   FUN_0044aa80  reubica el árbol: un nodo con u32 n < 0x1000 es una lista de n offsets relativos al
//                 nodo; si no, es una hoja con magic ('RRAN', 'PGLC', 'ANIM', 'CANS', 'CCB '…).
//   FUN_0044ac00  objeto = raíz[categoría][id & 0x3F]; la familia sale del slot (id & 0xC0) >> 6.
//   FUN_0044b630  objetos de borde: categoría 0, nivel 2 (FUN_0040b750(obj, 2)).
//   FUN_0044a200  'RRAN': +0x08 ANIM (nº de niveles en ANIM+0x10), +0x0C CCB, +0x10 PLUT; niveles de
//                 0x1C bytes desde +0x1C: [0] CCB, [1] chunk con el PDAT (+8), [2] anclaje (x, y),
//                 [3] cajas de choque, [4] nº de cajas, [5] ancho, [6] alto. Offsets relativos al objeto.

import { decodePdat, PDAT_MAGIC, type IndexedImage } from "./cel.ts";

export interface FamObject {
  image: IndexedImage;
  /** Anclaje (píxel del sprite que se apoya en el suelo), relativo a la imagen recortada. */
  hx: number;
  hy: number;
  /** Cajas de choque del nivel 2 ([3]/[4]): [x0, y0, x1, y1] en 1/256 de unidad desde el anclaje (FUN_004373f0). */
  boxes: [number, number, number, number][];
}

const RRAN = 0x5252414e;

/** Nodo de lista del árbol: devuelve los offsets absolutos de sus hijos, o null si es una hoja. */
function children(v: DataView, node: number): number[] | null {
  const n = v.getUint32(node, true);
  if (n === 0 || n >= 0x1000) return null;
  return Array.from({ length: n }, (_, i) => node + v.getUint32(node + 4 + i * 4, true));
}

/** Imagen y anclaje del nivel `level` (o el más alto disponible) de un objeto 'RRAN'. */
function decodeRran(data: Uint8Array, v: DataView, obj: number, level = 2): FamObject | null {
  if (v.getUint32(obj, true) !== RRAN) return null;
  const levels = v.getUint32(obj + v.getUint32(obj + 8, true) + 0x10, true);
  for (let l = Math.min(level, levels - 1); l >= 0; l--) {
    const e = obj + 0x1c + l * 0x1c;
    const pdat = obj + v.getUint32(e + 4, true) + 8;
    if (pdat + 0x40 > data.length || v.getUint32(pdat, true) !== PDAT_MAGIC) continue;
    const image = decodePdat(data.subarray(pdat));
    if (!image) continue;
    const hot = obj + v.getUint32(e + 8, true);
    const boxes: [number, number, number, number][] = [];
    const nBoxes = v.getUint32(e + 0x10, true);
    if (nBoxes > 0 && nBoxes < 64) {
      const b = obj + v.getUint32(e + 0xc, true);
      for (let k = 0; k < nBoxes && b + k * 16 + 16 <= data.length; k++)
        boxes.push([0, 4, 8, 12].map((o) => v.getInt32(b + k * 16 + o, true)) as [number, number, number, number]);
    }
    return { image, hx: v.getInt32(hot, true), hy: v.getInt32(hot + 4, true), boxes };
  }
  return null;
}

const PGLC = 0x434c4750;

/**
 * Textura de un 'PGLC' (FUN_0044a660 tipo 0 / FUN_0044a760 tipo 1): tabla de niveles de detalle en
 * +byte(0x15)·4; cada entrada es un offset relativo a +8 de un PDAT. Se devuelve el de mayor tamaño.
 */
function decodePglc(data: Uint8Array, v: DataView, node: number): IndexedImage | null {
  if (v.getUint32(node, true) !== PGLC) return null;
  const kind = data[node + 0x14] & 3;
  const table = node + data[node + 0x15] * 4;
  const offsets: number[] = [];
  if (kind === 0) {
    for (let j = 0; j <= data[node + 0x19]; j++) {
      const list = node + v.getUint32(table + j * 4, true);
      for (let i = 0; i <= data[node + 0x18]; i++) offsets.push(node + 8 + v.getUint32(list + i * 4, true));
    }
  } else if (kind === 1) {
    for (let i = 0; i <= data[node + 0x18]; i++) offsets.push(node + 8 + v.getUint32(table + i * 4, true));
  }
  let best: IndexedImage | null = null;
  for (const p of offsets) {
    if (p + 0x40 > data.length || p < 0) continue;
    // El offset puede apuntar al chunk (cabecera de 8 B) o directamente al PDAT.
    const at = v.getUint32(p, true) === PDAT_MAGIC ? p : v.getUint32(p + 8, true) === PDAT_MAGIC ? p + 8 : -1;
    if (at < 0) continue;
    const img = decodePdat(data.subarray(at));
    if (img && (!best || img.width * img.height > best.width * best.height)) best = img;
  }
  return best;
}

/**
 * Texturas de terreno (categoría 1): para cada índice de estilo (id & 0x3F), una o varias texturas.
 * Montaña/bosque/colinas usan las dos primeras (FUN_0040ccb0); edificios, el propio PGLC (FUN_0040b8e0).
 */
export function familyTerrain(data: Uint8Array): (IndexedImage | null)[][] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const root = children(v, 0);
  const cat1 = root?.[1] !== undefined ? children(v, root[1]) : null;
  return (cat1 ?? []).map((node) => {
    const kids = children(v, node);
    return kids ? kids.map((k) => decodePglc(data, v, k)) : [decodePglc(data, v, node)];
  });
}

/**
 * Alto de cada textura de la categoría 1 (FUN_0040b8e0): byte +0x16 del 'PGLC' · 16. En los edificios es
 * el alto de la fachada; ≤ 0x10 = sin edificio (solar).
 */
export function familyTerrainHeights(data: Uint8Array): number[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const root = children(v, 0);
  const cat1 = root?.[1] !== undefined ? children(v, root[1]) : null;
  return (cat1 ?? []).map((node) => {
    const leaf = children(v, node)?.[0] ?? node;
    return v.getUint32(leaf, true) === PGLC ? data[leaf + 0x16] * 16 : 0;
  });
}

/**
 * Aceras (categoría 5, FUN_0044acd0(id, 5, variante)): por índice, sus variantes; FUN_0040bde0 usa la 0
 * para la parte de arriba y la 1 para el frente del bordillo.
 */
export function familySidewalks(data: Uint8Array): (IndexedImage | null)[][] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const root = children(v, 0);
  const cat5 = root?.[5] !== undefined ? children(v, root[5]) : null;
  return (cat5 ?? []).map((node) => {
    const kids = children(v, node);
    return kids ? kids.map((k) => decodePglc(data, v, k)) : [decodePglc(data, v, node)];
  });
}

/** Objetos de borde (categoría 0) de una familia, en el orden de su índice (id & 0x3F). */
export function familyObjects(data: Uint8Array): (FamObject | null)[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const root = children(v, 0);
  const cat0 = root?.[0] !== undefined ? children(v, root[0]) : null;
  return (cat0 ?? []).map((obj) => decodeRran(data, v, obj));
}

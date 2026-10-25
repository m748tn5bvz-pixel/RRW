// Sub-bloques de un segmento de circuito. Cada parser cita el código de ROADRASH.EXE que lo lee.
// Todos los bloques empiezan con: fourcc (invertido), u32 tamaño total.

import { readFourCC } from "./rsrc.ts";

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * RLAN — carriles por lado (FUN_00452820 init, FUN_00452920 avance, FUN_004528f0 lectura).
 * +0x08 nº de entradas; entradas de 20 B desde +0x10.
 * Valor en 8.8 "carriles"; borde = carriles·250 unidades desde el centro (FUN_00454240, 0xFA).
 * Entre start y end el valor cambia por paso con delta (16.16); en end se fija al valor final.
 */
export interface LaneEntry {
  start: number;
  end: number;
  left0: number;
  right0: number;
  left1: number;
  right1: number;
  dLeft: number; // 16.16 por paso
  dRight: number;
}
export function parseLanes(b: Uint8Array): LaneEntry[] {
  const v = view(b);
  const n = v.getInt32(8, true);
  const out: LaneEntry[] = [];
  for (let i = 0; i < n; i++) {
    const e = 0x10 + i * 0x14;
    out.push({
      start: v.getInt32(e, true),
      end: v.getInt32(e + 4, true),
      left0: v.getUint8(e + 8),
      right0: v.getUint8(e + 9),
      left1: v.getUint8(e + 10),
      right1: v.getUint8(e + 11),
      dLeft: v.getInt32(e + 12, true),
      dRight: v.getInt32(e + 16, true),
    });
  }
  return out;
}

/**
 * RSLD — arcenes (FUN_00452a00 init, FUN_00452b70 avance, FUN_00452b00 lectura).
 * Entradas de 36 B desde +0x10: start, end, 4 bytes inicio/fin del par A (izq/der),
 * 4 bytes inicio/fin del par B, 2 bytes de indicadores (+0x10/+0x11), 4 deltas 16.16 (+0x14..).
 * El par A se suma por fuera del borde del asfalto (FUN_00454240: +0x3A/+0x3B).
 */
export interface ShoulderEntry {
  start: number;
  end: number;
  a0: [number, number];
  a1: [number, number];
  b0: [number, number];
  b1: [number, number];
  flags: [number, number];
  deltas: [number, number, number, number];
}
export function parseShoulders(b: Uint8Array): ShoulderEntry[] {
  const v = view(b);
  const n = v.getInt32(8, true);
  const out: ShoulderEntry[] = [];
  for (let i = 0; i < n; i++) {
    const e = 0x10 + i * 0x24;
    out.push({
      start: v.getInt32(e, true),
      end: v.getInt32(e + 4, true),
      a0: [v.getUint8(e + 8), v.getUint8(e + 9)],
      a1: [v.getUint8(e + 10), v.getUint8(e + 11)],
      b0: [v.getUint8(e + 12), v.getUint8(e + 13)],
      b1: [v.getUint8(e + 14), v.getUint8(e + 15)],
      flags: [v.getUint8(e + 16), v.getUint8(e + 17)],
      deltas: [v.getInt32(e + 20, true), v.getInt32(e + 24, true), v.getInt32(e + 28, true), v.getInt32(e + 32, true)],
    });
  }
  return out;
}

/**
 * RSEC — secciones (FUN_00452610 init, FUN_00452690 avance, FUN_00452710 / FUN_004527d0 lectura).
 * +0x08 nº de entradas, +0x0C longitud; entradas de 12 B desde +0x14: start, end, tipo, 3 bytes.
 * El juego marca la primera, la penúltima y la última pieza de cada sección (inicio/fin de puentes, etc.).
 */
export interface SectionEntry {
  start: number;
  end: number;
  type: number;
  extra: [number, number, number];
}
export function parseSections(b: Uint8Array): SectionEntry[] {
  const v = view(b);
  const n = v.getInt32(8, true);
  const out: SectionEntry[] = [];
  for (let i = 0; i < n; i++) {
    const e = 0x14 + i * 12;
    out.push({
      start: v.getInt32(e, true),
      end: v.getInt32(e + 4, true),
      type: v.getUint8(e + 8),
      extra: [v.getUint8(e + 9), v.getUint8(e + 10), v.getUint8(e + 11)],
    });
  }
  return out;
}

/**
 * Terreno a los lados (FUN_004510c0 init, FUN_004516e0 avance, FUN_00451910 lectura).
 *  RMTN/RDWD: +0x0C nº entradas izq, +0x10 der; entradas de 16 B desde +0x18 (izq y luego der);
 *    después, 2 bytes por paso (estilo izq/der → corte +0x148/+0x149).
 *    Cada paso: v1 += rand(±b5) ∈ [0, 2·b6]; v2 += rand(±b10) ∈ [0, 4·b11]; v3 += rand(±b7) ∈ [0, 4·b8]
 *    (FUN_00451220). Pie = v1; cima = v3 + 2·(b6 + 2·b9); altura = base + v2 (FUN_00451710).
 *  RBLD: 2 bytes por paso desde +0x10 (FUN_004517b0).
 *  RHIL: +0x08 nº de entradas de 76 B desde +0x14: start, end, estilo izq/der (+8/+9),
 *    y 8 grupos de 8 B (2 lados × 4 puntos): xmin/32, xmax/32, pendiente x/8, hmin/16, hmax/16 (con signo),
 *    pendiente h/8, tramo mín, tramo máx (FUN_00450fc0, FUN_00451380, FUN_004515a0, FUN_004517e0).
 */
export interface MountainEntry {
  start: number;
  bytes: number[]; // b4..b11 tal cual (ver arriba)
  base: number;
}
export interface HillPoint {
  xMin: number;
  xMax: number;
  xJitter: number;
  hMin: number;
  hMax: number;
  hJitter: number;
  spanMin: number;
  spanMax: number;
}
export interface HillEntry {
  start: number;
  end: number;
  style: [number, number];
  left: HillPoint[];
  right: HillPoint[];
}
export type Terrain =
  | { kind: "RMTN" | "RDWD"; left: MountainEntry[]; right: MountainEntry[]; styles: number[] }
  | { kind: "RBLD"; styles: number[] }
  | { kind: "RHIL"; entries: HillEntry[] }
  | { kind: string; unknown: true };

export function parseTerrain(b: Uint8Array, length: number): Terrain {
  const v = view(b);
  const kind = readFourCC(v, 0);
  const styles = (off: number) => Array.from(b.subarray(off, off + length * 2));
  if (kind === "RMTN" || kind === "RDWD") {
    const nL = v.getInt32(0x0c, true);
    const nR = v.getInt32(0x10, true);
    const entry = (i: number): MountainEntry => {
      const e = 0x18 + i * 16;
      return { start: v.getInt32(e, true), bytes: Array.from(b.subarray(e + 4, e + 12)), base: v.getInt32(e + 12, true) };
    };
    return {
      kind,
      left: Array.from({ length: nL }, (_, i) => entry(i)),
      right: Array.from({ length: nR }, (_, i) => entry(nL + i)),
      styles: styles(0x18 + (nL + nR) * 16),
    };
  }
  if (kind === "RBLD") return { kind, styles: styles(0x10) };
  if (kind === "RHIL") {
    const n = v.getInt32(8, true);
    const entries: HillEntry[] = [];
    for (let i = 0; i < n; i++) {
      const e = 0x14 + i * 0x4c;
      const point = (k: number): HillPoint => {
        const p = e + 0x0c + k * 8;
        return {
          xMin: v.getUint8(p) * 32,
          xMax: v.getUint8(p + 1) * 32,
          xJitter: v.getUint8(p + 2) * 8,
          hMin: v.getInt8(p + 3) * 16,
          hMax: v.getInt8(p + 4) * 16,
          hJitter: v.getUint8(p + 5) * 8,
          spanMin: v.getUint8(p + 6),
          spanMax: v.getUint8(p + 7),
        };
      };
      entries.push({
        start: v.getInt32(e, true),
        end: v.getInt32(e + 4, true),
        style: [v.getUint8(e + 8), v.getUint8(e + 9)],
        left: [0, 1, 2, 3].map(point),
        right: [4, 5, 6, 7].map(point),
      });
    }
    return { kind, entries };
  }
  return { kind, unknown: true };
}

/**
 * RROB — objetos de borde (FUN_00451b60 init, FUN_00451e20 avance, FUN_00451a90 decodifica una entrada,
 * FUN_00451cb0 rellena el corte). +0x08 nº de entradas; u32 por entrada desde +0x14. Las entradas son
 * consecutivas: cada una ocupa (rep + 1)·len + 1 pasos. Se exportan crudas; el cliente las decodifica
 * con el mismo reparto de bits (src/objects.ts).
 */
export function parseRoadsideObjects(b: Uint8Array): number[] {
  const v = view(b);
  const n = v.getUint32(8, true);
  return Array.from({ length: n }, (_, i) => v.getUint32(0x14 + i * 4, true));
}

/**
 * RRSM — carga de familias por slot (FUN_004522a0 init, FUN_00452310 avance → FUN_0044b120 encola la
 * petición para el hilo de carga FUN_0044ae90). +0x08 nº de entradas de 12 B desde +0x18:
 * paso (i32), estado (+4: 1 = cargar, 2 = liberar), slot (+5), familia (u16 +8).
 */
export interface FamilyLoad {
  pos: number;
  state: number;
  slot: number;
  fam: number;
}
export function parseFamilyLoads(b: Uint8Array): FamilyLoad[] {
  const v = view(b);
  const n = v.getUint32(8, true);
  return Array.from({ length: n }, (_, i) => {
    const e = 0x18 + i * 12;
    return { pos: v.getInt32(e, true), state: b[e + 4], slot: b[e + 5], fam: v.getUint16(e + 8, true) };
  });
}

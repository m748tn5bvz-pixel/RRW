// Animaciones de pilotos y motos (conjunto 0): formas 'CANS', anclajes 'ANIM' (GLOBAL.RSC) y plantillas del EXE.
//
// Evidencia en ROADRASH.EXE:
//   FUN_00445a60  carga 'CANS' id 1 (formas) y 'ANIM' id 1/3 (RRAN: un nivel por fotograma de HIBOB/HISHADOW)
//                 y construye cada animación con FUN_0040b6a0(plantilla, destino, nº de fotogramas).
//   FUN_0040b200  plantilla de 8 B [nombre i32, fila u8, …, siguiente u8 (+5)] → fotograma de 0x14 B.
//   FUN_0040b5a0  forma con id = índice + 1: [id, nFilas, duración·20, ?] + filas de 7 i32
//                 (u16 alto de la fila = nº de fotograma, base 1).
//   FUN_0040b5f0  lista de banderas por forma (bloque B: base + B[+4] + 0xC, listas [n, valores…]).
//   FUN_0040b630  tabla de nombres (16 B por forma) tras los bloques A, B, C y D.
//   FUN_0040b650  busca la forma siguiente con un nombre dado.
//   FUN_0043af60  elige forma y fila con el ángulo de vista y la inclinación (ver src/riders.ts).
//   0x474bd8      tabla de ids de animación del conjunto 0 (48 punteros a destinos de FUN_0040b6a0). No sigue
//                 el orden de las plantillas: los ids 20 y 21 no se construyen aquí y desde el 22 cada id es la
//                 plantilla id − 2 (p. ej. 26/27 = KiL/KiR, la patada de FUN_004095d0).

import { vaToFileOffset } from "./exe.ts";

/** Plantillas del conjunto 0, en el orden de FUN_00445a60: [VA plantilla, nº de fotogramas, destino]. */
const TEMPLATES_SET0: [number, number, number][] = [
  [0x4746c0, 1, 0x4b92e0], [0x4746c8, 1, 0x4b93f0], [0x4746d0, 1, 0x4b9200], [0x4746d8, 1, 0x4b9470],
  [0x4746e0, 1, 0x4b9a90], [0x4746e8, 2, 0x4b93c0], [0x4746f8, 2, 0x4b9bb0], [0x474708, 1, 0x4b9450],
  [0x474710, 1, 0x4b9ef0], [0x474718, 2, 0x4b9b40], [0x474728, 5, 0x4b99b0], [0x474750, 5, 0x4b96c0],
  [0x474778, 5, 0x4b9a20], [0x4747a0, 5, 0x4b9650], [0x4747c8, 2, 0x4b9100], [0x4747d8, 2, 0x4b98f0],
  [0x4747e8, 3, 0x4b9130], [0x474800, 3, 0x4b9190], [0x474818, 3, 0x4b9020], [0x474830, 3, 0x4b9380],
  [0x474868, 3, 0x4b9410], [0x474880, 3, 0x4b9300], [0x474898, 3, 0x4b9eb0], [0x4748b0, 3, 0x4b9b70],
  [0x4748c8, 2, 0x4b91d0], [0x4748d8, 2, 0x4b92b0], [0x4748e8, 7, 0x4b9860], [0x474920, 8, 0x4b9540],
  [0x474960, 4, 0x4b97a0], [0x474980, 4, 0x4b9920], [0x4749a0, 4, 0x4ba060], [0x4749c0, 5, 0x4b9d00],
  [0x4749e8, 4, 0x4b94f0], [0x474a08, 2, 0x4b9b10], [0x474a18, 5, 0x4b9060], [0x474a40, 4, 0x4b95e0],
  [0x474a60, 6, 0x4b9d70], [0x474a90, 5, 0x4b9fa0], [0x474ab8, 5, 0x4b9c20], [0x474ae0, 5, 0x4b9f10],
  [0x474b08, 5, 0x4b97f0], [0x474b30, 5, 0x4b9e20], [0x474b58, 4, 0x4ba010], [0x474b78, 4, 0x4b9230],
  [0x474b98, 3, 0x4b9970], [0x474bb0, 3, 0x4ba0b0], [0x474bc8, 1, 0x4b9f80], [0x474bd0, 1, 0x4b9170],
];
const ANIM_IDS = 0x474bd8;
/** Conjunto 1 (policía: FUN_00446060 elige el conjunto 0x4746b8[tipo] = 1 para el tipo 2), con 'CANS' 2 y
 *  'ANIM' 2/4; sus ids salen de la tabla 0x474ca8 (52 entradas, como la del conjunto 0). */
const TEMPLATES_SET1: [number, number, number][] = [
  [0x4746d0, 1, 0x4b9af0], [0x474710, 1, 0x4b9e90], [0x474718, 2, 0x4b90d0], [0x4747e8, 3, 0x4b9ab0],
  [0x474800, 3, 0x4b9340], [0x4748e8, 7, 0x4ba0f0], [0x4749c0, 5, 0x4b9c90], [0x474b30, 5, 0x4b9730],
  [0x474bc8, 1, 0x4b9630], [0x474b98, 3, 0x4b9be0], [0x474a40, 4, 0x4b9490],
];
const ANIM_IDS_SET1 = 0x474ca8;

export interface AnimFrame {
  shape: number; // índice de forma
  row: number; // fila base
  byLean: boolean; // +9: con banderas 0xF800, la fila es la inclinación y la forma el ángulo
  nLean: number; // +5
  nAngle: number; // +6
  leanRange: number; // +7
  angleDiv: number; // +8
  duration: number; // +0xC, en ticks de 60 Hz
  next: number; // +0xD: bits 0-3 tipo (0 seguir, 1 bucle a bits 4-7, otro = fin), bits 4-7 destino
  hit: boolean; // banderas & 0x600000: fotograma que golpea (FUN_004096f0)
}

export interface RiderAnims {
  /** Por forma: fotograma (base 0) de cada fila; −1 si la fila no tiene imagen. */
  shapes: number[][];
  /** Banderas por forma y fila (bit 0 espejo, 0x10000 tamaño ×2, 0x20000 ×4). */
  flags: number[][];
  /** Anclaje y tamaño de cada fotograma (niveles del RRAN 'ANIM' 1). */
  hotspots: [number, number, number, number][];
  /** Anclaje y tamaño de la sombra de cada fotograma (RRAN 'ANIM' 3, mismo índice; HISHADOW). */
  shadowHotspots: [number, number, number, number][];
  anims: AnimFrame[][];
}

export class Cans {
  readonly b: Uint8Array;
  readonly v: DataView;
  constructor(b: Uint8Array) {
    this.b = b;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  i32 = (o: number) => this.v.getInt32(o, true);
  get type() { return this.i32(8); }
  get nShapes() { return this.type === 1 ? this.i32(0x2c) : this.i32(0xc); }
  /** FUN_0040b5a0 */
  shape(idx: number) {
    let p = this.type === 1 ? 0x30 : 0x10;
    for (let guard = 0; guard < 4096; guard++) {
      if (this.i32(p) - idx === 1) return p;
      p += (this.i32(p + 4) * 7 + 4) * 4;
      if (p >= this.b.length) break;
    }
    return -1;
  }
  /** FUN_0040b5f0 */
  list(idx: number) {
    let p = this.type === 1 ? 0 : this.i32(4);
    p = p + this.i32(p + 4) + 0xc;
    for (let k = 0; k < idx; k++) p += this.i32(p) * 4 + 4;
    return p;
  }
  /** FUN_0040b620 */
  flag(idx: number, k: number) { return this.i32(this.list(idx) + 4 + k * 4); }
  /** FUN_0040b630 */
  names() {
    let p = this.i32(4);
    p += this.i32(p + 4);
    p += this.i32(p + 4);
    p += this.i32(p + 4);
    return p + 0xc;
  }
  /** FUN_0040b650 */
  find(name: number, start: number) {
    const n = this.nShapes, base = this.names();
    for (let i = start; i < n; i++) if (this.i32(base + i * 16) === name) return i;
    return -1;
  }
}

// Bits de banderas → ángulo (FUN_0040b200, +7 y +8); bit a bit, como el original.
const bit = (u: number, b: number) => ((u >>> b) & 1) !== 0;
const leanBits = (u: number) =>
  ((((bit(u, 13) ? 0xaaaaa : 0) + (u & 0x8000) * 0x40 + (bit(u, 12) ? 0x55555 : 0) + (bit(u, 14) ? 0x155555 : 0) + (bit(u, 11) ? 0x2aaaa : 0)) >> 16) * 2) & 0xff;
const angleBits = (u: number) =>
  ((((u & 0x400) * 0x1000 + (bit(u, 6) ? 0x55555 : 0) + (bit(u, 9) ? 0x2aaaaa : 0) + (bit(u, 7) ? 0xaaaaa : 0) + (bit(u, 5) ? 0x2aaaa : 0) + (bit(u, 8) ? 0x155555 : 0)) >> 16) * 2) & 0xff;

/** FUN_0040b200: una plantilla → un fotograma de animación. */
export function buildFrame(c: Cans, name: number, row: number, next: number): AnimFrame | null {
  name = Math.abs(name);
  const found = [-1, -1, -1], ends = [0, 0, 0];
  let start = 0;
  for (let k = 0; k < 3; k++) {
    const s = c.find(name, start);
    found[k] = s;
    if (s < 0) break;
    const f0 = c.flag(s, 0);
    let e = s;
    for (;;) {
      e++;
      if (c.i32(c.names() + e * 16) !== name) break;
      if ((c.flag(e, 0) & 6) !== (f0 & 6)) break;
    }
    ends[k] = e;
    start = e;
  }
  let [a, b, d] = found;
  if (a < 0) return null;
  if (b < 0) { b = a; ends[1] = ends[0]; d = -1; a = -1; }
  else if (d < 0) {
    if ((c.flag(b, 0) & 6) !== 0) {
      if ((c.flag(b, 0) & 2) === 0) { d = b; b = a; a = -1; ends[1] = ends[0]; }
      else { const t = b; b = a; a = t; ends[1] = ends[0]; }
    }
  } else {
    if ((c.flag(a, 0) & 2) === 0) {
      if ((c.flag(b, 0) & 2) === 0) { const t = d; d = a; a = t; ends[2] = ends[0]; }
      else { const t = b; b = a; a = t; ends[1] = ends[0]; }
    }
    if ((c.flag(b, 0) & 4) !== 0) { const t = d; d = b; b = t; const te = ends[2]; ends[2] = ends[1]; ends[1] = te; }
  }
  const shapeHdr = c.shape(b);
  const u = c.flag(b, 0);
  const byLean = (u & 0xf800) !== 0;
  return {
    shape: b,
    row: (row << 24) >> 24,
    byLean,
    nLean: byLean ? c.i32(shapeHdr + 4) : 0,
    nAngle: byLean ? ends[1] - b : c.i32(shapeHdr + 4),
    leanRange: leanBits(u),
    angleDiv: angleBits(u),
    duration: Math.trunc(c.i32(shapeHdr + 8) / 20),
    next,
    hit: (u & 0x600000) !== 0,
  };
}

/** Por forma: fotograma (base 0, u16 alto de cada fila) y banderas de cada fila. */
export function readShapes(c: Cans) {
  const shapes: number[][] = [], flags: number[][] = [];
  for (let s = 0; s < c.nShapes; s++) {
    const p = c.shape(s);
    const rows: number[] = [], fl: number[] = [];
    if (p >= 0) for (let r = 0; r < c.i32(p + 4); r++) {
      rows.push((c.v.getUint16(p + 16 + r * 28 + 2, true) || 0) - 1);
      fl.push(c.flag(s, r));
    }
    shapes.push(rows);
    flags.push(fl);
  }
  return { shapes, flags };
}

// RRAN 'ANIM': niveles de 7 i32 desde +0x1C; [2] anclaje (x, y), [5] ancho, [6] alto (FUN_0044a200).
function readHotspots(animBytes: Uint8Array) {
  const av = new DataView(animBytes.buffer, animBytes.byteOffset, animBytes.byteLength);
  const nLevels = av.getInt32(av.getInt32(8, true) + 0x10, true);
  const out: [number, number, number, number][] = [];
  for (let l = 0; l < nLevels; l++) {
    const e = 0x1c + l * 0x1c;
    const hot = av.getInt32(e + 8, true);
    out.push([av.getInt32(hot, true), av.getInt32(hot + 4, true), av.getInt32(e + 0x14, true), av.getInt32(e + 0x18, true)]);
  }
  return out;
}

/**
 * `animBytes` = 'ANIM' 1 (pilotos), `shadowAnimBytes` = 'ANIM' 3 (sombras: DAT_004b94e4 en FUN_00445a60).
 * `set` 1 = policía ('CANS' 2, 'ANIM' 2 y 4).
 */
export function readRiderAnims(exe: Uint8Array, cansBytes: Uint8Array, animBytes: Uint8Array, shadowAnimBytes: Uint8Array, set: 0 | 1 = 0): RiderAnims {
  const c = new Cans(cansBytes);
  const ev = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  const { shapes, flags } = readShapes(c);
  const hotspots = readHotspots(animBytes);
  const shadowHotspots = readHotspots(shadowAnimBytes);
  const templates = set ? TEMPLATES_SET1 : TEMPLATES_SET0;
  const byDest = new Map(templates.map(([va, n, dest]) => {
    const out: AnimFrame[] = [];
    let o = vaToFileOffset(exe, va);
    for (let k = 0; k < n; k++, o += 8) {
      const f = buildFrame(c, ev.getInt32(o, true), exe[o + 4], exe[o + 5]);
      if (f) out.push(f);
    }
    return [dest, out] as const;
  }));
  // Índice = id de animación (el que usan FUN_0040ac70 y las tablas de ataque); [] si no se construye aquí.
  const ids = vaToFileOffset(exe, set ? ANIM_IDS_SET1 : ANIM_IDS);
  const anims = Array.from({ length: set ? 52 : TEMPLATES_SET0.length }, (_, id) => byDest.get(ev.getUint32(ids + id * 4, true)) ?? []);
  return { shapes, flags, hotspots, shadowHotspots, anims };
}

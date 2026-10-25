// Circuitos de Road Rash (.CRS): segmentos (SGS), grafo de nodos (NOD) y trazado (PTH).
//
// Evidencia en ROADRASH.EXE (Ghidra vía REA):
//   FUN_00441940  carga "Data\Courses\<nombre>.CRS" y sus recursos SGS/NOD/CEL
//   FUN_00447e50  convierte los offsets de cada registro de segmento en punteros
//   FUN_00447b80  convierte los offsets del grafo NOD
//   FUN_00452cb0  inicializa el cursor de carretera sobre un nodo (un iterador por bloque)
//   FUN_00452e10  avanza el cursor y salta al nodo siguiente/anterior
//   FUN_004519f0  avance de PTH: acumulador += byte1 del paso cruzado
//   FUN_00451a40  lectura de PTH: (byte0, byte1) del paso actual
//   FUN_00454240  arma el corte de carretera: atan(byte0), atan(byte1), acumulador
//   FUN_00453030  en bifurcaciones integra dos veces Δbyte0 entre ramas (separación lateral)
//   FUN_0044f720  arcotangente en punto fijo (256 = 1.0 → 256 = 90°, 1024 por vuelta)

import { getResource, readFourCC, type ResourceFile } from "./rsrc.ts";

/**
 * Pasos de PTH: byte0 = curvatura pseudo-3D (dx += b0; x += dx), byte1 = pendiente (y += b1).
 * Ver FUN_00443d70 / FUN_00444630 en docs/FORMATS.md.
 */
export interface PathBlock {
  length: number; // número de pasos
  startHeight: number; // cabecera +0x0C (valor inicial del acumulador al avanzar)
  endHeight: number; // cabecera +0x0E (valor inicial al recorrer en reversa)
  curve: Int8Array;
  slope: Int8Array;
}

/** Sub-bloque de un segmento que todavía no se decodifica: se conserva crudo. */
export interface RawBlock {
  tag: string; // p. ej. "RROB", "RLAN"
  bytes: Uint8Array;
}

export interface Segment {
  index: number;
  path: PathBlock;
  // Punteros del registro (52 bytes) por posición; ver docs/FORMATS.md
  blocks: Record<string, RawBlock | null>;
}

export type CourseNode =
  | { kind: "start"; offset: number; next: number }
  | { kind: "end"; offset: number }
  | { kind: "run"; offset: number; segment: number; length: number; next: number; prev: number }
  | { kind: "fork" | "merge"; offset: number; links: [number, number, number]; raw: number[] };

export interface Course {
  segments: Segment[];
  nodes: Map<number, CourseNode>;
  root: number;
}

// Posición de cada puntero dentro del registro de segmento de 52 bytes (índice de dword).
// Confirmado por FUN_00452cb0 (qué iterador recibe cada uno).
const SEGMENT_SLOTS: Record<number, string> = {
  1: "path", // RPTH
  2: "objects", // RROB  → FUN_00451b60
  3: "sprites", // RRSM  → FUN_004522a0 / FUN_0044b170 (lista de sprites con dimensiones)
  4: "terrain", // RHIL / RMTN / RDWD / RBLD → FUN_004510c0
  5: "slide", // RSLD  → FUN_00452a00
  6: "lanes", // RLAN  → FUN_00452820
  7: "hazards", // RHZD  → FUN_00452060
  9: "sections", // RSEC  → FUN_00452610
};

function blockAt(sgs: Uint8Array, view: DataView, offset: number): RawBlock | null {
  if (offset === 0) return null;
  const size = view.getUint32(offset + 4, true);
  return { tag: readFourCC(view, offset), bytes: sgs.subarray(offset, offset + size) };
}

function parsePath(view: DataView, offset: number): PathBlock {
  const length = view.getInt32(offset + 8, true);
  const curve = new Int8Array(length);
  const slope = new Int8Array(length);
  for (let i = 0; i < length; i++) {
    curve[i] = view.getInt8(offset + 0x10 + 2 * i);
    slope[i] = view.getInt8(offset + 0x11 + 2 * i);
  }
  return {
    length,
    startHeight: view.getInt16(offset + 0x0c, true),
    endHeight: view.getInt16(offset + 0x0e, true),
    curve,
    slope,
  };
}

export function parseCourse(file: ResourceFile): Course {
  const sgs = getResource(file, "SGS ", 1);
  const sv = new DataView(sgs.buffer, sgs.byteOffset, sgs.byteLength);
  const count = sv.getInt32(8, true);
  const segments: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const rec = 0x10 + i * 0x34;
    const blocks: Record<string, RawBlock | null> = {};
    for (const [slot, name] of Object.entries(SEGMENT_SLOTS)) {
      if (name === "path") continue;
      blocks[name] = blockAt(sgs, sv, sv.getUint32(rec + 4 * Number(slot), true));
    }
    segments.push({ index: i, path: parsePath(sv, sv.getUint32(rec + 4, true)), blocks });
  }

  const nod = getResource(file, "NOD ", 1);
  const nv = new DataView(nod.buffer, nod.byteOffset, nod.byteLength);
  const root = nv.getUint32(0x10, true);
  const nodes = new Map<number, CourseNode>();
  const queue = [root];
  while (queue.length) {
    const off = queue.shift()!;
    if (!off || nodes.has(off) || off + 4 > nod.length) continue;
    const w = (i: number) => nv.getInt32(off + 4 * i, true);
    switch (w(0)) {
      case 0: {
        const node: CourseNode = { kind: "run", offset: off, next: w(2), prev: w(3), segment: w(4), length: w(5) };
        nodes.set(off, node);
        queue.push(node.next, node.prev);
        break;
      }
      case 1:
      case 2: {
        const node: CourseNode = {
          kind: w(0) === 1 ? "fork" : "merge",
          offset: off,
          links: [w(2), w(3), w(4)],
          raw: [0, 1, 2, 3, 4, 5, 6, 7].map(w),
        };
        nodes.set(off, node);
        queue.push(...node.links);
        break;
      }
      case 3:
        // Marca de salida: 8 bytes. El siguiente dword apunta al primer tramo (observado: 0x14 en CANYN).
        nodes.set(off, { kind: "start", offset: off, next: root });
        break;
      case 4:
        nodes.set(off, { kind: "end", offset: off });
        break;
      default:
        throw new Error(`nodo de tipo desconocido ${w(0)} en 0x${off.toString(16)}`);
    }
  }
  return { segments, nodes, root };
}

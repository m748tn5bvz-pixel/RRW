// Simulación, paso a paso, de los iteradores de ROADRASH.EXE sobre la ruta principal.
// Produce arrays por paso que el renderer consume. Referencias en importer/blocks.ts y docs/FORMATS.md.

import { flattenRoute, type CourseJson, type RouteFork, type Step } from "./road.ts";

export interface LaneEntry { start: number; end: number; left0: number; right0: number; left1: number; right1: number; dLeft: number; dRight: number }
export interface ShoulderEntry {
  start: number; end: number; a0: [number, number]; a1: [number, number]; b0: [number, number]; b1: [number, number];
  flags: [number, number]; deltas: [number, number, number, number];
}
interface MountainEntry { start: number; bytes: number[]; base: number }
interface HillPoint { xMin: number; xMax: number; xJitter: number; hMin: number; hMax: number; hJitter: number; spanMin: number; spanMax: number }
interface HillEntry { start: number; end: number; style: [number, number]; left: HillPoint[]; right: HillPoint[] }
type Terrain =
  | { kind: "RMTN" | "RDWD"; left: MountainEntry[]; right: MountainEntry[]; styles: number[] }
  | { kind: "RBLD"; styles: number[] }
  | { kind: "RHIL"; entries: HillEntry[] }
  | { kind: string; unknown: true }
  | null;

export interface SectionData { start: number; end: number; type: number; extra: [number, number, number] }

export interface SegmentData {
  length: number;
  sections?: SectionData[];
  lanes: LaneEntry[];
  shoulders: ShoulderEntry[];
  terrain: Terrain;
}

/** Tipo de terreno por paso y lado (para colorear). */
export const Ground = {
  Flat: 0,
  Mountain: 1,
  Woods: 2,
  Hills: 3,
  Buildings: 4,
} as const;

/** Puntos del perfil por lado: (x hacia fuera desde el borde del arcén, altura), en unidades del juego. */
export const PROFILE = 5;

/**
 * Intersección: sección RSEC de tipo 0 (cruce), 1 o 2 (en T) (FUN_00452690 guarda tipo + 1); `lanes` =
 * extra[0] (carriles de la calle que cruza, +0x111 del controlador), `lights` = extra[2] ≠ 0.
 */
export interface Crossing { start: number; end: number; type: number; lanes: number; lights: boolean }

export interface Track {
  steps: Step[];
  /** Marcas del corte +0x37 de las intersecciones (FUN_00452710): 8 entrada, 0x10 salida, 0x20|n calle. */
  cross: Uint8Array;
  crossings: Crossing[];
  forks: RouteFork[];
  /**
   * Desplazamiento del centro de la carretera (cursor +0xC → corte +0xCC), en unidades. FUN_00453030 lo
   * cambia al entrar en una rama (la 0 conserva el borde izquierdo, la 1 el derecho) y al unirse.
   */
  offset: Float32Array;
  laneL: Float32Array; // carriles (float) por lado
  laneR: Float32Array;
  shoulderL: Float32Array; // ancho del arcén (unidades)
  shoulderR: Float32Array;
  /** Par B de RSLD (FUN_00452b00 → corte +0x140/+0x144): alto de la acera (bordillo) en unidades. */
  curbL: Float32Array;
  curbR: Float32Array;
  /** Banderas de RSLD (+0x14A/+0x14B): id de la textura de acera (categoría 5) por lado. */
  walkL: Uint8Array;
  walkR: Uint8Array;
  groundL: Uint8Array;
  groundR: Uint8Array;
  styleL: Uint8Array;
  styleR: Uint8Array;
  profile: Float32Array; // [paso][lado 0=izq,1=der][punto][x,h]
}

/** Generador determinista (mulberry32) en lugar del rand() del juego (FUN_00441750). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export function buildTrack(course: CourseJson, choices: readonly number[] = []): Track {
  const { steps, forks } = flattenRoute(course, choices);
  const n = steps.length;
  const t: Track = {
    steps,
    forks,
    cross: new Uint8Array(n),
    crossings: [],
    offset: new Float32Array(n),
    laneL: new Float32Array(n),
    laneR: new Float32Array(n),
    shoulderL: new Float32Array(n),
    shoulderR: new Float32Array(n),
    curbL: new Float32Array(n),
    curbR: new Float32Array(n),
    walkL: new Uint8Array(n),
    walkR: new Uint8Array(n),
    groundL: new Uint8Array(n),
    groundR: new Uint8Array(n),
    styleL: new Uint8Array(n),
    styleR: new Uint8Array(n),
    profile: new Float32Array(n * 2 * PROFILE * 2),
  };
  const rand = rng([...course.name].reduce((h, c) => h * 31 + c.charCodeAt(0), 7));
  const randRange = (lo: number, hi: number) => lo + (hi >= lo ? rand() % (hi - lo + 1) : 0);

  let i = 0;
  while (i < n) {
    const segIndex = steps[i].segment;
    const seg = course.segments[segIndex] as unknown as SegmentData;
    simulateSegment(t, i, seg, rand, randRange);
    for (const e of seg.sections ?? []) {
      if (e.type > 2 || e.start < 0 || e.end > seg.length) continue;
      t.crossings.push({ start: i + e.start, end: i + e.end, type: e.type, lanes: e.extra[0], lights: e.extra[2] !== 0 });
      for (let k = e.start; k <= e.end; k++) if (i + k < n) t.cross[i + k] = crossFlags(e.type + 1, e.start, e.end, k);
    }
    i += seg.length;
  }
  // FUN_00453030: al entrar en la rama 0, off += (izq. de la rama − izq. anterior)·0xFA; en la 1,
  // off += (der. anterior − der. de la rama)·0xFA. Al unirse, lo mismo con la carretera siguiente.
  const shifts = new Map<number, number>();
  for (const f of forks) {
    if (f.start > 0 && f.start < n) {
      const d = f.branch === 0 ? t.laneL[f.start] - t.laneL[f.start - 1] : t.laneR[f.start - 1] - t.laneR[f.start];
      shifts.set(f.start, (shifts.get(f.start) ?? 0) + d * 250);
    }
    if (f.merge > 0 && f.merge < n) {
      const d = f.branch === 0 ? t.laneL[f.merge] - t.laneL[f.merge - 1] : t.laneR[f.merge - 1] - t.laneR[f.merge];
      shifts.set(f.merge, (shifts.get(f.merge) ?? 0) + d * 250);
    }
  }
  let off = 0;
  for (let k = 0; k < n; k++) {
    off += shifts.get(k) ?? 0;
    t.offset[k] = off;
  }
  return t;
}

/** FUN_00452710: marca del paso `k` de una intersección de tipo (+1) `kind` entre `start` y `end`. */
export function crossFlags(kind: number, start: number, end: number, k: number) {
  if (k === end) return 0;
  if (k === start) return 8;
  if (end - k === 1) return 0x10;
  if (kind === 1) {
    const m = end - 2 * k + start;
    if (m === 0 || m === 1) return 0x22;
    return 0x20 + (end - k < k - start + 1 ? 1 : 0);
  }
  return 0x21;
}

function setProfile(t: Track, step: number, side: 0 | 1, pts: [number, number][]) {
  const base = (step * 2 + side) * PROFILE * 2;
  for (let k = 0; k < PROFILE; k++) {
    const p = pts[Math.min(k, pts.length - 1)];
    t.profile[base + k * 2] = p[0];
    t.profile[base + k * 2 + 1] = p[1];
  }
}

function simulateSegment(
  t: Track,
  first: number,
  seg: SegmentData,
  rand: () => number,
  randRange: (lo: number, hi: number) => number,
) {
  const len = seg.length;

  // --- RLAN (FUN_00452820 / FUN_00452920): valores 16.16; sin bloque, 2 carriles (FUN_004528f0 → 0x200).
  let li = 0;
  let left = (seg.lanes[0]?.left0 ?? 2) * 65536;
  let right = (seg.lanes[0]?.right0 ?? 2) * 65536;
  // --- RSLD (FUN_00452a00 / FUN_00452b70): par A; sin bloque, el corte usa ±650 − ±500 = 150 (FUN_004551c0).
  let si = 0;
  let shL = seg.shoulders.length ? seg.shoulders[0].a0[0] * 65536 : 150 * 65536;
  let shR = seg.shoulders.length ? seg.shoulders[0].a0[1] * 65536 : 150 * 65536;
  let cbL = (seg.shoulders[0]?.b0[0] ?? 0) * 65536, cbR = (seg.shoulders[0]?.b0[1] ?? 0) * 65536;

  // --- Terreno: estado inicial (FUN_004510c0 / FUN_00450fc0)
  const terrain = seg.terrain;
  const mtn = terrain && "left" in terrain ? terrain : null;
  const hil = terrain && "entries" in terrain ? terrain : null;
  const mIdx = [0, 0];
  const mVal = [0, 1].map((k) => {
    const e = (k === 0 ? mtn?.left : mtn?.right)?.[0];
    return e ? { v1: e.bytes[2], v2: e.bytes[7] * 2, v3: e.bytes[4] * 2 } : { v1: 0, v2: 0, v3: 0 };
  });
  let hIdx = 0;
  const hState = [0, 1].map((k) =>
    [0, 1, 2, 3].map((p) => {
      const pt = hil?.entries[0]?.[k === 0 ? "left" : "right"][p];
      return {
        x: pt ? randRange(pt.xMin, pt.xMax) : 0,
        h: pt ? pt.hMin + (rand() % (pt.hMax - pt.hMin + 1 || 1)) : 0,
        dx: 0,
        dh: 0,
        start: 0,
        end: 0,
      };
    }),
  );

  for (let s = 0; s < len; s++) {
    const idx = first + s;
    if (idx >= t.steps.length) break;

    // Carriles: avance al cruzar el paso s (FUN_00452920, sentido positivo).
    if (s > 0 && seg.lanes.length) {
      const e = seg.lanes[li];
      if (s <= e.end) {
        if (s < e.end) { left += e.dLeft; right += e.dRight; }
        else { left = e.left1 * 65536; right = e.right1 * 65536; }
      } else if (seg.lanes[li + 1]?.start === s) li++;
    }
    t.laneL[idx] = left / 65536;
    t.laneR[idx] = right / 65536;

    // Arcenes (FUN_00452b70): misma lógica que carriles para el par A.
    if (s > 0 && seg.shoulders.length) {
      const e = seg.shoulders[si];
      if (s <= e.end) {
        if (s < e.end) { shL += e.deltas[0]; shR += e.deltas[1]; cbL += e.deltas[2]; cbR += e.deltas[3]; }
        else { shL = e.a1[0] * 65536; shR = e.a1[1] * 65536; cbL = e.b1[0] * 65536; cbR = e.b1[1] * 65536; }
      } else if (seg.shoulders[si + 1]?.start === s) si++;
    }
    t.shoulderL[idx] = shL / 65536;
    t.shoulderR[idx] = shR / 65536;
    t.curbL[idx] = cbL / 65536;
    t.curbR[idx] = cbR / 65536;
    const se = seg.shoulders[si];
    if (se) { t.walkL[idx] = se.flags[0]; t.walkR[idx] = se.flags[1]; }

    // Terreno
    for (const side of [0, 1] as const) {
      const ground = side === 0 ? t.groundL : t.groundR;
      const style = side === 0 ? t.styleL : t.styleR;
      if (mtn) {
        // FUN_00451220: cambio de entrada y caminata aleatoria acotada.
        const list = side === 0 ? mtn.left : mtn.right;
        if (list.length > 1 && list[mIdx[side] + 1] && list[mIdx[side] + 1].start <= s) mIdx[side]++;
        const e = list[mIdx[side]];
        const b = e.bytes; // b4..b11
        const st = mVal[side];
        st.v1 = Math.min(Math.max(st.v1 + randRange(0, b[1] * 2) - b[1], 0), b[2] * 2);
        st.v2 = Math.min(Math.max(st.v2 + randRange(0, b[6] * 2) - b[6], 0), b[7] * 4);
        st.v3 = Math.min(Math.max(st.v3 + randRange(0, b[3] * 2) - b[3], 0), b[4] * 4);
        // FUN_00451710: pie, cima y altura.
        const foot = st.v1;
        const top = st.v3 + (b[2] + b[5] * 2) * 2;
        const height = e.base + st.v2;
        setProfile(t, idx, side, [[0, 0], [foot, 0], [Math.max(top, foot + 1), height], [top + 6000, height]]);
        ground[idx] = mtn.kind === "RDWD" ? Ground.Woods : Ground.Mountain;
        style[idx] = mtn.styles[s * 2 + side] ?? 0;
      } else if (hil) {
        // FUN_004515a0 / FUN_00451380: cambio de entrada, nuevos tramos y avance lineal de cada punto.
        if (side === 0 && hil.entries[hIdx + 1] && hil.entries[hIdx + 1].start <= s) hIdx++;
        const entry = hil.entries[hIdx];
        const pts = side === 0 ? entry.left : entry.right;
        const prof: [number, number][] = [[0, 0]];
        hState[side].forEach((p, k) => {
          const g = pts[k];
          if (p.end <= s || s <= p.start) {
            let span = randRange(g.spanMin, g.spanMax);
            if (s + span > entry.end) span = entry.end - s;
            p.start = s;
            p.end = s + span;
            if (span > 0) {
              let dx = randRange(0, g.xJitter * 2) - g.xJitter;
              const nx = p.x + dx * span;
              if (nx < g.xMin) dx = (g.xMin - p.x) / span;
              else if (nx > g.xMax) dx = (g.xMax - p.x) / span;
              let dh = randRange(0, g.hJitter * 2) - g.hJitter;
              const nh = p.h + dh * span;
              if (nh < g.hMin || nh > g.hMax) dh = ((nh < g.hMin ? g.hMin : g.hMax) - p.h) / span;
              p.dx = dx;
              p.dh = dh;
            }
          }
          p.x += p.dx;
          p.h += p.dh;
          prof.push([Math.max(p.x, prof[prof.length - 1][0] + 1), p.h]);
        });
        setProfile(t, idx, side, prof);
        ground[idx] = Ground.Hills;
        style[idx] = entry.style[side];
      } else if (terrain && "styles" in terrain) {
        // RBLD (FUN_004517b0): solo estilo por paso; los edificios los dibuja src/buildings.ts (FUN_0040c770).
        setProfile(t, idx, side, [[0, 0], [6000, 0]]);
        ground[idx] = Ground.Buildings;
        style[idx] = terrain.styles[s * 2 + side] ?? 0;
      } else {
        setProfile(t, idx, side, [[0, 0], [6000, 0]]);
        ground[idx] = Ground.Flat;
      }
    }
  }
}

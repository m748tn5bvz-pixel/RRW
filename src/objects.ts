// Objetos de borde (árboles, señales, edificios sueltos…) con el arte original de FAMILIES.RSC.
//
// Simulación de los iteradores de ROADRASH.EXE sobre la ruta principal:
//   FUN_00451a90  decodifica una entrada RROB (u32):
//                 bit31 alterna lado · bit30 espejo · bit29 separación ancha · bit28 lado (0 = derecha)
//                 bits24-27 len · bits16-23 id de sprite (0x3F = nada) · bit11 separación aleatoria
//                 bits8-10 nº de objetos − 1 · bits4-7 escala · separación:
//                   len = 0 → v = bits12-15·16 + bits0-3; v·8 (o (v + 32)·32 si ancha)
//                   len > 0 → bits0-3·64 (o (bits0-3 + 4)·256 si ancha); bits12-15 = rep
//   FUN_00451e20  cada entrada ocupa (rep + 1)·len + 1 pasos; luego pasa a la siguiente.
//   FUN_00451cb0  coloca objetos en el paso si rep = 0 o (paso − inicio) % (rep + 1) = 0:
//                 x0 = borde der. (+0xE4) − 224 + sep, o borde izq. (+0xE0) + 224 − sep; siguientes ± sep.
//   FUN_00451c20  altura de cada objeto = altura del terreno en su x (FUN_00439b10); si > 998, 0.
//   FUN_00452310  RRSM: qué familia ocupa cada slot; el sprite id elige slot (id >> 6) e índice (id & 0x3F).
//   FUN_0044b630  dibujo: en la mitad del corte; píxel del sprite = escala/4 unidades; anclaje en el suelo;
//                 bit de espejo → se dibuja invertido alrededor del anclaje.

import * as THREE from "three/webgpu";
import { PROFILE, type Track } from "./track.ts";
import type { ViewSlice } from "./road.ts";
import { pixelTexture, type SpriteManifest } from "./sprites.ts";

interface FamilyLoad { pos: number; state: number; slot: number; fam: number }
export interface ObjectsCourse {
  name: string;
  segments: { length: number; objects?: number[]; famLoads?: FamilyLoad[] }[];
}

export interface Placement {
  fam: number; // recurso FAM
  index: number; // objeto de la categoría 0 (id & 0x3F)
  xs: number[]; // unidades del juego desde el centro de la carretera
  ys: number[]; // altura del terreno en cada x
  mirror: boolean;
  scale: number; // unidades por píxel del sprite
}

function decode(u: number) {
  const len = (u >>> 24) & 0xf;
  const wide = (u >>> 29) & 1;
  let sp: number;
  if (len === 0) {
    const v = ((u & 0xf000) >>> 8) + (u & 0xf);
    sp = wide ? (v + 0x20) * 0x20 : v * 8;
  } else sp = wide ? ((u & 0xf) + 4) * 0x100 : (u & 0xf) << 6;
  return {
    alt: u >>> 31,
    mirror: ((u >>> 30) & 1) === 1,
    side: (u >>> 28) & 1,
    len,
    rep: len ? (u >>> 12) & 0xf : 0,
    sprite: (u >>> 16) & 0xff,
    random: ((u >>> 11) & 1) === 1,
    count: ((u >>> 8) & 7) + 1,
    scale: (u >>> 4) & 0xf,
    spacing: sp,
  };
}

/** Altura del terreno a `x` unidades del centro (perfil de track.ts; 0 sobre asfalto y arcén). */
function groundHeight(t: Track, step: number, x: number) {
  const side = x < 0 ? 0 : 1;
  const edge = side === 0 ? t.laneL[step] * 250 + t.shoulderL[step] : t.laneR[step] * 250 + t.shoulderR[step];
  const d = Math.abs(x) - edge;
  if (d <= 0) return 0;
  const base = (step * 2 + side) * PROFILE * 2;
  let px = t.profile[base], ph = t.profile[base + 1];
  for (let k = 1; k < PROFILE; k++) {
    const nx = t.profile[base + k * 2], nh = t.profile[base + k * 2 + 1];
    if (d <= nx) return nx > px ? ph + ((nh - ph) * (d - px)) / (nx - px) : nh;
    px = nx;
    ph = nh;
  }
  return ph;
}

/** Familia cargada en cada slot (0-3) para cada paso de la ruta, según RRSM; −1 si ninguna. */
export function familySlots(course: ObjectsCourse, t: Track): Int16Array {
  const out = new Int16Array(t.steps.length * 4).fill(-1);
  const carried = [-1, -1, -1, -1];
  let i = 0;
  while (i < t.steps.length) {
    const seg = course.segments[t.steps[i].segment];
    const loads = (seg.famLoads ?? []).filter((l) => l.state === 1).sort((a, b) => a.pos - b.pos);
    for (let s = 0; s < seg.length && i + s < t.steps.length; s++)
      for (let slot = 0; slot < 4; slot++) {
        let fam = -1;
        for (const l of loads) if (l.slot === slot && l.pos <= s) fam = l.fam;
        if (fam < 0) fam = carried[slot];
        if (fam < 0) fam = loads.find((l) => l.slot === slot)?.fam ?? -1;
        out[(i + s) * 4 + slot] = fam;
      }
    for (const l of loads) carried[l.slot] = l.fam;
    i += seg.length;
  }
  return out;
}

export function buildObjects(course: ObjectsCourse, t: Track): (Placement | null)[] {
  const out: (Placement | null)[] = new Array(t.steps.length).fill(null);
  let seed = [...course.name].reduce((h, c) => h * 31 + c.charCodeAt(0), 11) >>> 0;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 0x7fff;
  const carried = [-1, -1, -1, -1];

  let i = 0;
  while (i < t.steps.length) {
    const segIndex = t.steps[i].segment;
    const seg = course.segments[segIndex];
    const entries = seg.objects ?? [];
    const loads = (seg.famLoads ?? []).filter((l) => l.state === 1).sort((a, b) => a.pos - b.pos);
    const famAt = (slot: number, s: number) => {
      let fam = -1;
      for (const l of loads) if (l.slot === slot && l.pos <= s) fam = l.fam;
      if (fam < 0) fam = carried[slot];
      if (fam < 0) fam = loads.find((l) => l.slot === slot)?.fam ?? -1;
      return fam;
    };

    let k = 0;
    let e = entries.length ? decode(entries[0]) : null;
    let start = 0;
    let end = e ? (e.rep + 1) * e.len : 0;
    for (let s = 0; s < seg.length && i + s < t.steps.length; s++) {
      if (e && s > end) {
        k++;
        e = k < entries.length ? decode(entries[k]) : null;
        start = s;
        end = e ? s + (e.rep + 1) * e.len : s;
      }
      if (!e || (e.sprite & 0x3f) === 0x3f) continue;
      if (e.rep !== 0 && (s - start) % (e.rep + 1) !== 0) continue;
      const step = i + s;
      const right = (e.alt ? (((s - start) & 1) === 0 ? 1 - e.side : e.side) : e.side) === 0;
      let x = right ? t.laneR[step] * 250 - 224 + e.spacing : -t.laneL[step] * 250 + 224 - e.spacing;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let n = 0; n < e.count; n++) {
        xs.push(x);
        const h = groundHeight(t, step, x);
        ys.push(h > 998 ? 0 : h);
        const half = e.spacing >>> 1;
        const d = e.random ? half + (rand() % (e.spacing - half + 1)) : e.spacing;
        x += right ? d : -d;
      }
      const fam = famAt(e.sprite >>> 6, s);
      if (fam >= 0) out[step] = { fam, index: e.sprite & 0x3f, xs, ys, mirror: e.mirror, scale: e.scale / 4 };
    }
    for (const l of loads) carried[l.slot] = l.fam;
    i += seg.length;
  }
  return out;
}

// --- Dibujo: una malla por familia con quads dinámicos (una llamada de dibujo por familia) ----------

interface FamFrame { x: number; y: number; w: number; h: number; hx: number; hy: number; boxes?: [number, number, number, number][] }
interface FamAtlas { width: number; height: number; frames: (FamFrame | null)[] }

const CAPACITY = 512;

class FamilyBatch {
  readonly mesh: THREE.Mesh;
  readonly atlas: FamAtlas;
  private pos = new Float32Array(CAPACITY * 4 * 3);
  private uv = new Float32Array(CAPACITY * 4 * 2);
  private geo = new THREE.BufferGeometry();
  private last = 0;
  count = 0;
  constructor(texture: THREE.Texture, atlas: FamAtlas) {
    this.atlas = atlas;
    const idx = new Uint32Array(CAPACITY * 6);
    for (let q = 0; q < CAPACITY; q++) idx.set([q * 4, q * 4 + 2, q * 4 + 1, q * 4 + 1, q * 4 + 2, q * 4 + 3], q * 6);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("uv", new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }
  /** Quad vertical con el anclaje (hx, hy) del sprite en (x, y, z); todo en unidades de la escena. */
  add(f: FamFrame, x: number, y: number, z: number, pix: number, mirror: boolean) {
    if (this.count >= CAPACITY) return;
    const q = this.count++;
    const left = mirror ? x - (f.w - f.hx) * pix : x - f.hx * pix;
    const right = left + f.w * pix;
    const top = y + f.hy * pix;
    const bottom = top - f.h * pix;
    this.pos.set([left, top, z, right, top, z, left, bottom, z, right, bottom, z], q * 12);
    const { width: W, height: H } = this.atlas;
    let u0 = f.x / W, u1 = (f.x + f.w) / W;
    if (mirror) [u0, u1] = [u1, u0];
    const v0 = 1 - f.y / H, v1 = 1 - (f.y + f.h) / H;
    this.uv.set([u0, v0, u1, v0, u0, v1, u1, v1], q * 8);
  }
  /** Solo sube la parte usada; vacío, ni se sube ni se dibuja. */
  commit() {
    const n = this.count;
    this.mesh.visible = n > 0;
    if (n > 0 || this.last > 0) {
      for (const [name, per] of [["position", 12], ["uv", 8]] as const) {
        const a = this.geo.attributes[name] as THREE.BufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(0, Math.max(1, n) * per);
        a.needsUpdate = true;
      }
      this.geo.setDrawRange(0, n * 6);
    }
    this.last = n;
    this.count = 0;
  }
  dispose() {
    this.geo.dispose();
    const m = this.mesh.material as THREE.MeshBasicMaterial;
    m.map?.dispose();
    m.dispose();
  }
}

export class RoadsideObjects {
  private batches = new Map<number, FamilyBatch>();
  private loading = new Set<number>();
  private placements: (Placement | null)[] = [];
  private group = new THREE.Group();
  private unit: number;
  constructor(scene: THREE.Scene, unit: number) {
    this.unit = unit;
    scene.add(this.group);
  }

  /** Libera las familias cargadas (al cambiar de circuito). */
  reset() {
    for (const b of this.batches.values()) { this.group.remove(b.mesh); b.dispose(); }
    this.batches.clear();
    this.loading.clear();
    this.placements = [];
  }

  /** Las familias ya cargadas se conservan (al cambiar de rama solo se cargan las nuevas). */
  async setCourse(placements: (Placement | null)[], families: SpriteManifest["families"]) {
    this.placements = placements;
    const used = new Set(placements.flatMap((p) => (p ? [p.fam] : [])));
    await Promise.all(
      [...used].filter((fam) => !this.batches.has(fam) && !this.loading.has(fam)).map(async (fam) => {
        const entry = families[fam];
        if (!entry) return;
        this.loading.add(fam);
        const [tex, atlas] = await Promise.all([pixelTexture(`${entry.atlas}.png`), fetch(`${entry.atlas}.json`).then((r) => r.json() as Promise<FamAtlas>)]);
        const batch = new FamilyBatch(tex, atlas);
        this.batches.set(fam, batch);
        this.group.add(batch.mesh);
      }),
    );
  }

  /** Objetos del paso con sus cajas de choque (FUN_0044b630 → corte+0x61/+0x68; FUN_004373f0). */
  obstacles(step: number): { x: number; boxes: [number, number, number, number][] }[] {
    const p = this.placements[step];
    const boxes = p ? this.batches.get(p.fam)?.atlas.frames[p.index]?.boxes : undefined;
    if (!p || !boxes?.length) return [];
    return p.xs.map((x) => ({ x, boxes })); // el original no las invierte con el espejo
  }

  /**
   * Coloca los objetos de los cortes visibles (`view[1..]` = pasos desde el actual). `hide(paso, x)`
   * oculta los que caen sobre la otra carretera en una zona doble.
   */
  update(view: ViewSlice[], hide?: (index: number, x: number) => boolean) {
    const U = this.unit;
    for (let k = 1; k + 1 < view.length; k++) {
      const p = this.placements[view[k].index];
      if (!p) continue;
      const batch = this.batches.get(p.fam);
      const f = batch?.atlas.frames[p.index];
      if (!batch || !f) continue;
      // Mitad del corte (FUN_0044b630 promedia x/y de los dos bordes y usa z + 0x80).
      const a = view[k], b = view[k + 1];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
      p.xs.forEach((x, n) => {
        if (!hide?.(a.index, x)) batch.add(f, (mx + x) / U, (my + p.ys[n]) / U, -mz / U, p.scale / U, p.mirror);
      });
    }
    for (const b of this.batches.values()) b.commit();
  }
}

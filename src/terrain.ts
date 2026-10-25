// Terreno a los lados de la carretera, texturizado con el arte original.
//
//   FUN_0040b8e0 / FUN_0040ccb0  el byte de estilo de cada lado (corte+0x148 / +0x149) es un id de sprite:
//                slot = id >> 6 (familia cargada por RRSM), índice = id & 0x3F en la categoría 1 de la familia.
//                Montaña/bosque/colinas toman los PGLC 0 y 1 de ese índice; edificios, el PGLC directo.
//   FUN_004180b0 el motor de cels mapea la textura entera a cada cuadrilátero (3DO); aquí, una repetición
//                por corte y por tramo del perfil.
//   [I] qué tramo del perfil lleva cada PGLC: tramo j → PGLC j (colinas); en montañas, la cara usa el 0.

import * as THREE from "three/webgpu";
import { Ground, PROFILE, type Track } from "./track.ts";
import type { ViewSlice } from "./road.ts";
import { pixelTexture, type SpriteManifest } from "./sprites.ts";

const LANE = 250;
const MAX_QUADS = 4096; // cuadriláteros por lote como mucho

/**
 * Lote de cuadriláteros dinámicos (una llamada de dibujo). Crece bajo demanda y en cada fotograma solo sube a la
 * GPU la parte usada; vacío, ni se sube ni se dibuja.
 */
export class QuadBatch {
  readonly mesh: THREE.Mesh;
  private pos = new Float32Array(0);
  private uv = new Float32Array(0);
  private col = new Float32Array(0);
  private geo = new THREE.BufferGeometry();
  private capacity = 0;
  private colored = false;
  private last = 0;
  count = 0;
  constructor(material: THREE.Material) {
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.grow(16);
  }
  private grow(n: number) {
    const cap = Math.min(MAX_QUADS, n);
    const pos = new Float32Array(cap * 12), uv = new Float32Array(cap * 8), col = new Float32Array(cap * 12).fill(1);
    pos.set(this.pos);
    uv.set(this.uv);
    col.set(this.col);
    this.pos = pos;
    this.uv = uv;
    this.col = col;
    const idx = new Uint32Array(cap * 6);
    for (let q = 0; q < cap; q++) idx.set([q * 4, q * 4 + 2, q * 4 + 1, q * 4 + 1, q * 4 + 2, q * 4 + 3], q * 6);
    this.geo.dispose();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("uv", new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.capacity = cap;
  }
  /** a0,a1 = borde cercano (interior, exterior); b0,b1 = borde lejano; `u1` = u del borde exterior. */
  add(a0: THREE.Vector3, a1: THREE.Vector3, b0: THREE.Vector3, b1: THREE.Vector3, c?: THREE.Color, u1 = 1) {
    if (this.count >= this.capacity) {
      if (this.capacity >= MAX_QUADS) return;
      this.grow(this.capacity * 2);
    }
    const q = this.count++;
    this.pos.set([b0.x, b0.y, b0.z, b1.x, b1.y, b1.z, a0.x, a0.y, a0.z, a1.x, a1.y, a1.z], q * 12);
    this.uv.set([0, 1, u1, 1, 0, 0, u1, 0], q * 8);
    if (c) {
      this.colored = true;
      for (let k = 0; k < 4; k++) this.col.set([c.r, c.g, c.b], (q * 4 + k) * 3);
    }
  }
  commit() {
    const n = this.count;
    this.mesh.visible = n > 0;
    if (n > 0 || this.last > 0) {
      const used: [string, number][] = [["position", 12], ["uv", 8]];
      if (this.colored) used.push(["color", 12]);
      for (const [name, per] of used) {
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

const GROUND_COLORS: Record<number, [number, number]> = {
  [Ground.Flat]: [0x6f8f3e, 0x67853a],
  [Ground.Mountain]: [0x8a7a66, 0x7c6d5a],
  [Ground.Woods]: [0x3f5f2e, 0x37552a],
  [Ground.Hills]: [0x76963f, 0x6d8c3a],
  [Ground.Buildings]: [0x8d8a86, 0x85827e],
};

/** Altura del perfil (puntos [x, h] desde `base`) a `x` unidades del borde del arcén. */
function profileHeight(profile: Float32Array, base: number, x: number) {
  let px = profile[base], ph = profile[base + 1];
  for (let k = 1; k < PROFILE; k++) {
    const nx = profile[base + k * 2], nh = profile[base + k * 2 + 1];
    if (x <= nx) return nx > px ? ph + ((nh - ph) * (x - px)) / (nx - px) : nh;
    px = nx;
    ph = nh;
  }
  return ph;
}

export class Terrain {
  private group = new THREE.Group();
  private textured = new Map<string, QuadBatch>();
  private loading = new Set<string>();
  private plain: QuadBatch;
  private track: Track | null = null;
  private slots: Int16Array = new Int16Array(0);
  private families: SpriteManifest["families"] = {};
  private unit: number;
  private v = [0, 1, 2, 3].map(() => new THREE.Vector3());
  private tmp = new THREE.Color();
  constructor(scene: THREE.Scene, unit: number) {
    this.unit = unit;
    this.plain = new QuadBatch(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.group.add(this.plain.mesh);
    scene.add(this.group);
  }

  /** Libera las texturas cargadas (al cambiar de circuito). */
  reset() {
    for (const b of this.textured.values()) { this.group.remove(b.mesh); b.dispose(); }
    this.textured.clear();
    this.loading.clear();
  }

  /** Las texturas ya cargadas se conservan (al cambiar de rama solo se cargan las nuevas). */
  async setCourse(track: Track, slots: Int16Array, families: SpriteManifest["families"]) {
    this.track = track;
    this.slots = slots;
    this.families = families;
    const urls = new Set<string>();
    for (let i = 0; i < track.steps.length; i++)
      for (const side of [0, 1] as const) for (const u of this.textures(i, side)) if (u && !this.textured.has(u) && !this.loading.has(u)) urls.add(u);
    await Promise.all(
      [...urls].map(async (url) => {
        this.loading.add(url);
        const tex = await pixelTexture(url);
        const b = new QuadBatch(new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
        this.textured.set(url, b);
        this.group.add(b.mesh);
      }),
    );
  }

  /** Texturas (PGLC 0, 1, …) del estilo del lado `side` en el paso `i`. */
  private textures(i: number, side: 0 | 1): (string | null)[] {
    const t = this.track!;
    if (t.groundL[i] === Ground.Flat && side === 0) return [];
    if (t.groundR[i] === Ground.Flat && side === 1) return [];
    const style = (side === 0 ? t.styleL : t.styleR)[i];
    const fam = this.slots[i * 4 + ((style >> 6) & 3)];
    return this.families[fam]?.terrain?.[style & 0x3f] ?? [];
  }

  /**
   * `clip(paso, lado)`: alcance máximo del perfil desde el borde del arcén (zonas dobles: el lado que da a
   * la otra carretera llega solo hasta la mitad del hueco entre las dos).
   */
  update(slices: ViewSlice[], clip?: (index: number, side: 0 | 1) => number) {
    const t = this.track;
    if (!t) return;
    const U = this.unit;
    const [a0, a1, b0, b1] = this.v;
    for (let r = 0; r + 1 < slices.length; r++) {
      const s0 = slices[r], s1 = slices[r + 1];
      const i = s0.index;
      for (const side of [0, 1] as const) {
        const sign = side === 0 ? -1 : 1;
        const ground = (side === 0 ? t.groundL : t.groundR)[i];
        if (ground === Ground.Buildings) continue; // edificios y acera: src/buildings.ts
        const texs = this.textures(i, side);
        const pt = (s: ViewSlice, k: number, out: THREE.Vector3) => {
          const j = s.index;
          const edge = side === 0 ? -(t.laneL[j] * LANE + t.shoulderL[j]) : t.laneR[j] * LANE + t.shoulderR[j];
          const base = (j * 2 + side) * PROFILE * 2;
          let px = t.profile[base + k * 2], ph = t.profile[base + k * 2 + 1];
          const c = clip ? clip(j, side) : Infinity;
          if (px > c) [px, ph] = [c, profileHeight(t.profile, base, c)]; // el perfil se corta ahí
          out.set((s.x + edge + sign * px) / U, (s.y + ph) / U - 0.02, -s.z / U);
          return out;
        };
        for (let k = 0; k + 1 < PROFILE; k++) {
          const near0 = pt(s0, k, a0), near1 = pt(s0, k + 1, a1), far0 = pt(s1, k, b0), far1 = pt(s1, k + 1, b1);
          if (Math.abs(near1.x - near0.x) < 1e-4 && Math.abs(near1.y - near0.y) < 1e-4) continue;
          let url: string | null = null;
          if (texs.length) {
            const which = ground === Ground.Mountain || ground === Ground.Woods ? (k === 1 ? 0 : 1) : k;
            url = texs[Math.min(which, texs.length - 1)] ?? texs[0];
          }
          const batch = url ? this.textured.get(url) : undefined;
          if (batch) batch.add(near0, near1, far0, far1);
          else {
            const [ca, cb] = GROUND_COLORS[ground] ?? GROUND_COLORS[Ground.Flat];
            this.tmp.setHex(Math.floor(i / 4) % 2 ? ca : cb).multiplyScalar(1 - k * 0.06);
            this.plain.add(near0, near1, far0, far1, this.tmp);
          }
        }
      }
    }
    this.plain.commit();
    for (const b of this.textured.values()) b.commit();
  }
}

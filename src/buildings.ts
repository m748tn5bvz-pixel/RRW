// Edificios y aceras de ciudad (terreno RBLD, corte +0x3C = 0), port de ROADRASH.EXE.
//
//   FUN_004517b0  RBLD: estilo de cada lado por paso (+0x148/+0x149).
//   FUN_0040b8e0  fachada = objeto de la categoría 1 de la familia (slot = estilo >> 6, índice = estilo & 0x3F,
//                 FUN_0044ac00); alto = byte +0x16 del PGLC · 16 (+0xF4/+0xFC; 560-1200 en The Peninsula);
//                 ≤ 0x10 → sin edificio (solar).
//   FUN_00444630  proyección: suelo +0x4C; bordes del asfalto +0x50/+0x58 y del arcén +0x60/+0x68; parte de
//                 arriba de la acera +0x54/+0x5C = suelo − par B de RSLD (+0x140/+0x144); alto de la fachada
//                 +0x74/+0x7C y la mitad hacia fuera +0x70/+0x78.
//   FUN_0043bef0  caso 0 (edificios): FUN_0040bde0 + FUN_0040c770; en la calle que cruza (+0x37 & 0x20), solo
//                 FUN_0043b970 (src/crossing.ts).
//   FUN_0040bde0  acera: parte de arriba del borde del asfalto al del arcén, a la altura del par B, con la
//                 variante 0 de la categoría 5 (id = banderas de RSLD +0x14A, FUN_0040bd80 → FUN_0044acd0); frente
//                 del bordillo, vertical en el borde del asfalto, con la variante 1.
//   FUN_0040c770  fachada: plano vertical en el borde exterior de la acera, desde la acera hasta su alto, con la
//                 textura entera por paso (FUN_0040c410).
//   FUN_0040c930  tejado: plano a lo alto de la fachada, de fondo la mitad del alto, color 0xFD de la paleta
//                 (FUN_0044fd00). [I] El rebaje de 3/16 de las fachadas con transparencia (+0x90) no se aplica.
//   FUN_0040cbb0  lateral: donde el edificio vecino es más alto, su cara lateral con su textura y la mitad de su
//                 alto de fondo.

import * as THREE from "three/webgpu";
import type { ViewSlice } from "./road.ts";
import { QuadBatch } from "./terrain.ts";
import { pixelTexture, type SpriteManifest } from "./sprites.ts";
import { Ground, type Track } from "./track.ts";

const LANE = 250;

export class Buildings {
  private group = new THREE.Group();
  private textured = new Map<string, QuadBatch>();
  private loading = new Set<string>();
  private roof: QuadBatch;
  private track: Track | null = null;
  private slots: Int16Array = new Int16Array(0);
  private families: SpriteManifest["families"] = {};
  private unit: number;
  private v = [0, 1, 2, 3].map(() => new THREE.Vector3());
  private roofColor = new THREE.Color(0x6b6b6b);
  constructor(scene: THREE.Scene, unit: number) {
    this.unit = unit;
    this.roof = new QuadBatch(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.group.add(this.roof.mesh);
    scene.add(this.group);
  }

  /** Libera las texturas cargadas (al cambiar de circuito). */
  reset() {
    for (const b of this.textured.values()) { this.group.remove(b.mesh); b.dispose(); }
    this.textured.clear();
    this.loading.clear();
  }

  /** Las texturas ya cargadas se conservan. `roof` = color 0xFD de la paleta. */
  async setCourse(track: Track, slots: Int16Array, families: SpriteManifest["families"], roof?: string) {
    this.track = track;
    this.slots = slots;
    this.families = families;
    if (roof) this.roofColor.set(roof).convertSRGBToLinear();
    const urls = new Set<string>();
    for (let i = 0; i < track.steps.length; i++)
      for (const side of [0, 1] as const) {
        const f = this.facade(i, side);
        if (f) urls.add(f.url);
        for (const k of [0, 1]) {
          const w = this.walk(i, side, k);
          if (w) urls.add(w);
        }
      }
    await Promise.all(
      [...urls].filter((u) => !this.textured.has(u) && !this.loading.has(u)).map(async (url) => {
        this.loading.add(url);
        const tex = await pixelTexture(url);
        const b = new QuadBatch(new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, alphaTest: 0.5 }));
        this.textured.set(url, b);
        this.group.add(b.mesh);
      }),
    );
  }

  private famOf(i: number, id: number) { return this.families[this.slots[i * 4 + ((id >> 6) & 3)]]; }

  /** FUN_0040b8e0: textura y alto de la fachada del lado `side` en el paso `i`; null = sin edificio. */
  facade(i: number, side: 0 | 1): { url: string; h: number } | null {
    const t = this.track;
    if (!t || i < 0 || i >= t.steps.length) return null;
    if ((side ? t.groundR : t.groundL)[i] !== Ground.Buildings || t.cross[i] & 0x20) return null;
    const id = (side ? t.styleR : t.styleL)[i];
    if (id === 0xff) return null;
    const fam = this.famOf(i, id), k = id & 0x3f;
    const h = fam?.heights?.[k] ?? 0, url = fam?.terrain?.[k]?.[0];
    return url && h > 0x10 ? { url, h } : null;
  }

  /** FUN_0040bd80: variante `k` de la acera (categoría 5) del lado `side`. */
  private walk(i: number, side: 0 | 1, k: number): string | null {
    const t = this.track!;
    if ((side ? t.groundR : t.groundL)[i] !== Ground.Buildings || t.cross[i] & 0x20) return null;
    const id = (side ? t.walkR : t.walkL)[i];
    return this.famOf(i, id)?.sidewalk?.[id & 0x3f]?.[k] ?? null;
  }

  /** `slices` con el desplazamiento del centro ya sumado (roadView). `skip(paso, lado)`: lado tapado por otra carretera. */
  update(slices: ViewSlice[], skip?: (index: number, side: 0 | 1) => boolean) {
    const t = this.track;
    if (!t) return;
    const U = this.unit;
    const [a0, a1, b0, b1] = this.v;
    const P = (out: THREE.Vector3, s: ViewSlice, x: number, y: number) => out.set((s.x + x) / U, (s.y + y) / U, -s.z / U);
    for (let r = 0; r + 1 < slices.length; r++) {
      const s0 = slices[r], s1 = slices[r + 1];
      const i = s0.index, j = s1.index;
      if (i === j) continue;
      for (const side of [0, 1] as const) {
        if (skip?.(i, side)) continue;
        const sg = side ? 1 : -1;
        const lanes = side ? t.laneR : t.laneL, sh = side ? t.shoulderR : t.shoulderL, curb = side ? t.curbR : t.curbL;
        const e0 = sg * lanes[i] * LANE, e1 = sg * lanes[j] * LANE;
        const o0 = e0 + sg * sh[i], o1 = e1 + sg * sh[j];
        const c0 = curb[i], c1 = curb[j];
        // Acera: parte de arriba y frente del bordillo.
        const top = this.walk(i, side, 0), face = this.walk(i, side, 1);
        if (top) this.textured.get(top)?.add(P(a0, s0, e0, c0), P(a1, s0, o0, c0), P(b0, s1, e1, c1), P(b1, s1, o1, c1));
        if (face && (c0 > 0 || c1 > 0)) this.textured.get(face)?.add(P(a0, s0, e0, 0), P(a1, s1, e1, 0), P(b0, s0, e0, c0), P(b1, s1, e1, c1));
        const f = this.facade(i, side);
        if (!f) continue;
        const batch = this.textured.get(f.url);
        if (!batch) continue;
        const h = f.h, d = (sg * h) / 2;
        // Fachada (u a lo largo de la carretera, v hacia arriba).
        batch.add(P(a0, s0, o0, c0), P(a1, s1, o1, c1), P(b0, s0, o0, c0 + h), P(b1, s1, o1, c1 + h));
        // Tejado.
        this.roof.add(P(a0, s0, o0, c0 + h), P(a1, s0, o0 + d, c0 + h), P(b0, s1, o1, c1 + h), P(b1, s1, o1 + d, c1 + h), this.roofColor);
        // Laterales donde el vecino es más bajo (o no hay edificio).
        const prev = this.facade(i - 1, side)?.h ?? 0, next = this.facade(i + 1, side)?.h ?? 0;
        if (prev < h) batch.add(P(a0, s0, o0, c0), P(a1, s0, o0 + d, c0), P(b0, s0, o0, c0 + h), P(b1, s0, o0 + d, c0 + h));
        if (next < h) batch.add(P(a0, s1, o1, c1), P(a1, s1, o1 + d, c1), P(b0, s1, o1, c1 + h), P(b1, s1, o1 + d, c1 + h));
      }
    }
    this.roof.commit();
    for (const b of this.textured.values()) b.commit();
  }
}

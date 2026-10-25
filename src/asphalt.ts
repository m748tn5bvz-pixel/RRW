// Asfalto con las texturas originales de GLOBAL.RSC, un cuadrilátero por carril y corte.
//
//   FUN_00441940  carga 'CEL ' 1..14 de GLOBAL.RSC (tabla 0x46df70): 1 PLAIN → 0x4c3ce0, 2 WHITE → 0x4c3ce4,
//                 3 YELLOW → 0x4c3ce8, 4/5 START160/162, 6 PLAIN → 0x4c3cb0, 10 FINISH → 0x4c3cc0.
//   FUN_0043c170  dibuja la carretera del corte en tiras de un carril (0xFA de ancho) desde el borde izquierdo:
//                 ceil(izq) + ceil(der) tiras; la textura entera (128×32) se mapea a cada tira (cel de la 3DO).
//   FUN_0043c0b0  textura de la tira k: k = 0 → PLAIN; k = ceil(izq) → YELLOW (línea central a su izquierda);
//                 si no, WHITE (raya discontinua a su izquierda), salvo carriles fraccionarios (PLAIN).
//   [I] fila 0 de la textura en el borde lejano del corte (las texturas de salida encadenan sus filas así).
//   Intersecciones (corte +0x37, FUN_00452710): con 8 (entrada) o 0x10 (salida) la tira usa 0x4c3cd0[k]:
//                 k = 0 START160 (CEL 4, línea de detención), k = 2 START162 (CEL 5, con la línea central);
//                 [I] k = 1 no se carga (0x4c3cd4 → textura por defecto DAT_004b7e74): aquí START160.
//                 Con 0x20 (la calle que cruza), PLAIN alternativo (CEL 6 → 0x4c3cb0), sin marcas.
//   [?] Salida/meta (corte +0x36) aún no se usa.

import * as THREE from "three/webgpu";
import type { ViewSlice } from "./road.ts";
import type { Track } from "./track.ts";
import { pixelTexture } from "./sprites.ts";
import { QuadBatch } from "./terrain.ts";

const LANE = 250;
const PLAIN = 0, WHITE = 1, YELLOW = 2, STOP = 3, STOP_CENTER = 4, CROSS = 5;

/** FUN_0043c0b0: `left`/`right` = carriles a cada lado en 8.8, `k` = tira desde la izquierda. */
export function laneTexture(left: number, right: number, k: number): number {
  if (k <= 0) return PLAIN;
  const ceilL = (left + 0xff) >> 8;
  if (k === ceilL) return YELLOW;
  if ((left & 0xff) !== 0 && k <= 1) return PLAIN;
  if ((right & 0xff) === 0) return WHITE;
  return k < (right >> 8) + ceilL ? WHITE : PLAIN;
}

export class Asphalt {
  private batches: QuadBatch[] = [];
  private track: Track | null = null;
  private unit: number;
  private v = [0, 1, 2, 3].map(() => new THREE.Vector3());
  constructor(scene: THREE.Scene, unit: number, urls: string[]) {
    this.unit = unit;
    for (const url of urls) {
      const b = new QuadBatch(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      b.mesh.visible = false;
      pixelTexture(url).then((tex) => {
        const m = b.mesh.material as THREE.MeshBasicMaterial;
        m.map = tex;
        m.needsUpdate = true;
        b.mesh.visible = true;
      });
      this.batches.push(b);
      scene.add(b.mesh);
    }
  }
  get ready() { return this.batches.every((b) => b.mesh.visible); }
  setCourse(track: Track) { this.track = track; }

  update(slices: ViewSlice[]) {
    const t = this.track;
    if (!t || !this.batches.length) return;
    const U = this.unit;
    const [a0, a1, b0, b1] = this.v;
    for (let r = 0; r + 1 < slices.length; r++) {
      const s0 = slices[r], s1 = slices[r + 1];
      const i = s0.index, j = s1.index;
      const left = Math.round(t.laneL[i] * 256), right = Math.round(t.laneR[i] * 256);
      const strips = ((left + 0xff) >> 8) + ((right + 0xff) >> 8);
      const l0 = -t.laneL[i] * LANE, r0 = t.laneR[i] * LANE;
      const l1 = -t.laneL[j] * LANE, r1 = t.laneR[j] * LANE;
      for (let k = 0; k < strips; k++) {
        // Tiras de un carril desde el borde izquierdo; la última se recorta al borde derecho.
        const x0 = l0 + k * LANE, x1 = Math.min(r0, x0 + LANE);
        const y0 = l1 + k * LANE, y1 = Math.min(r1, y0 + LANE);
        if (x1 <= x0 && y1 <= y0) continue;
        const u = Math.max(0, Math.min(1, Math.max(x1 - x0, y1 - y0) / LANE));
        a0.set((s0.x + x0) / U, s0.y / U, -s0.z / U);
        a1.set((s0.x + Math.max(x0, x1)) / U, s0.y / U, -s0.z / U);
        b0.set((s1.x + y0) / U, s1.y / U, -s1.z / U);
        b1.set((s1.x + Math.max(y0, y1)) / U, s1.y / U, -s1.z / U);
        let tex = laneTexture(left, right, k);
        const f = t.cross[i];
        if (f & 0x20) tex = CROSS;
        else if (f & 0x18) tex = tex === YELLOW ? STOP_CENTER : STOP;
        this.batches[Math.min(tex, this.batches.length - 1)].add(a0, a1, b0, b1, undefined, u);
      }
    }
    for (const b of this.batches) b.commit();
  }
}

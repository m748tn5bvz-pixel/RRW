// Intersecciones: semáforos, tráfico que cruza y la calle transversal, port de ROADRASH.EXE.
//
//   Datos: secciones RSEC de tipo 0 (cruce), 1 y 2 (en T) (src/track.ts `crossings`). FUN_00454240 llama a
//   FUN_0041ec70 → FUN_0041eca0 al construir el corte de la sección.
//   FUN_0041eca0  controlador (plantilla 0x468f10, piensa con FUN_0041f040): fases verde/ámbar/rojo de
//                 600/180/780 ticks (+0xFC/+0x100/+0x104; 75/0/240 en un caso especial sin semáforos que aquí
//                 no se distingue [I]). Semáforos (FUN_0041ef60, plantilla 0x468f30, dibujo FUN_0041f220):
//                   0 (tu sentido)      si hay carriles derechos: paso fin − 1, lado derecho, +0x50;
//                   2 (sentido contrario) si hay izquierdos:     paso inicio,   lado izquierdo, +0xB0;
//                   3 (cruce, tipo 0/1): paso fin − 1, lado izquierdo, +0x50;
//                   1 (cruce, tipo 0/2): paso inicio,  lado derecho,   +0xB0.
//                 Lateral = mitad entre el borde del asfalto y el del arcén de ese lado (+0xE0/+0xE8 o
//                 +0xE4/+0xEC). Fase inicial (~tipo & 1)·2 con el reloj a 0x30C: los de tu calle se ponen en
//                 verde y los de la que cruza en rojo. Con extra[2] = 0 (+0xB) los semáforos no se ven (+0xDC = 0).
//   FUN_0041f040  cada tick suma el tiempo a cada semáforo; dentro del anillo de cortes (cámara − 0x3000 +
//                 0x100 … + 0x5000 − 0x200) pasa de fase. Al ponerse en verde uno de la calle que cruza
//                 (tipo impar) y con el bit 3 del contador de ticks, sale un coche de tipo 1 o 3 en un carril
//                 al azar de la calle que cruza (extra[0]: en un cruce la mitad por sentido; en una T todos y
//                 tipo 3 si la sección es de tipo 1, 1 si es de tipo 2), en el paso inicio + carril + 1.
//   FUN_0041f220  poste STOP3E (CEL 11) a escala 0x200, anclado abajo en el centro, en espejo para los tipos
//                 0 y 1; encima la luz del semáforo 0 del controlador: STOP3G/STOP3Y/STOP3R (CEL 12-14).
//   FUN_0043b970  calle que cruza (corte +0x37 & 0x20): desde el borde, el paso de cebra SIDCRSS0 (CEL 7) y
//                 luego tiras SIDLANE0/1 (CEL 8/9, según +0x37 & 7) de 0x200 hacia fuera (8 o 16 tiras).

import * as THREE from "three/webgpu";
import type { ViewSlice } from "./road.ts";
import { QuadBatch } from "./terrain.ts";
import { pixelTexture } from "./sprites.ts";
import type { Crossing, Track } from "./track.ts";
import { CAR, CROSS_LEFT, CROSS_RIGHT, ONCOMING, SAME, TRAFFIC_DENSITY, type Car, type Traffic } from "./traffic.ts";

const LANE = 250;
const PHASES = [600, 180, 780];
export const GREEN = 0, YELLOW = 1, RED = 2;

export interface Light {
  type: number; // 0 tu sentido, 2 contrario, 1/3 calle que cruza
  step: number;
  fwd: number; // avance dentro del paso (0x50 / 0xB0)
  side: 0 | 1;
  phase: number;
  timer: number;
}

export class Junction {
  readonly lights: (Light | null)[] = [null, null, null, null];
  readonly c: Crossing;
  constructor(c: Crossing) { this.c = c; }
  get pos() { return this.c.start * 256; }
  /** Fase que enseñan todos los postes: la del semáforo 0 (FUN_0041f220). */
  get shown() { return this.lights[0]?.phase ?? -1; }
}

export class Signals {
  junctions: Junction[] = [];

  /** FUN_0041eca0 para cada intersección de la ruta. */
  setTrack(t: Track) {
    this.junctions = t.crossings.map((c) => {
      const j = new Junction(c);
      const last = Math.max(c.start, c.end - 1);
      const make = (type: number, step: number, side: 0 | 1, fwd: number): Light =>
        ({ type, step, side, fwd, phase: (~type & 1) * 2, timer: 0x30c });
      if (t.laneR[c.start] >= 1) j.lights[0] = make(0, last, 1, 0x50);
      if (t.laneL[last] >= 1) j.lights[2] = make(2, c.start, 0, 0xb0);
      const kind = c.type + 1;
      if (kind === 1 || kind === 2) j.lights[3] = make(3, last, 0, 0x50);
      if (kind === 1 || kind === 3) j.lights[1] = make(1, c.start, 1, 0xb0);
      return j;
    });
  }

  /** FUN_0041f040. `center(paso)` = centro de la carretera en ese paso (unidades). */
  tick(cam: number, tickCount: number, traffic: Traffic, center: (i: number) => number, rand: () => number) {
    for (const j of this.junctions) {
      for (const l of j.lights) {
        if (!l) continue;
        l.timer++;
        const p = l.step * 256 + l.fwd;
        if (p < cam - 0x3000 + 0x100 || p > cam + 0x5000 - 0x200) continue;
        while (PHASES[l.phase] < l.timer) {
          l.timer -= PHASES[l.phase];
          l.phase = (l.phase + 1) % 3;
          if (!(l.type & 1) || l.phase !== GREEN || !(tickCount & 8)) continue;
          const kind = j.c.type + 1;
          let type = l.type, count = j.c.lanes, lane = 0;
          if (kind === 1) {
            count = count >> 1;
            if (type === CROSS_LEFT) lane = count;
          } else type = kind === 2 ? CROSS_LEFT : CROSS_RIGHT;
          if (count <= 0) continue;
          // Ajuste propio: con el 20 % menos de tráfico, también salen menos coches por la calle que cruza.
          if (rand() % 100 >= TRAFFIC_DENSITY * 100) continue;
          lane += rand() % count;
          const step = j.c.start + lane + 1;
          traffic.spawnCross(type, step, center(step));
        }
      }
    }
  }

  /**
   * FUN_0044e710 con el semáforo de su tipo (FUN_00449e60): línea de parada (unidades) si está en rojo, o en
   * ámbar con distancia para frenar (más de mph·3·16), dentro del alcance (mph·6 + 0x80)·16.
   */
  stopFor(c: Car): number | null {
    if (c.type !== SAME && c.type !== ONCOMING) return null;
    const mph = (c.v >> 12) + (c.v >> 7) + (c.v >> 9);
    const reach = (Math.max(20, mph * 3) * 2 + 0x80) * 16;
    for (const j of this.junctions) {
      const l = j.lights[c.type];
      if (!l || l.phase === GREEN) continue;
      const stop = c.type === SAME ? j.c.start * 256 + 0xa0 : j.c.end * 256 - 0xa0;
      const d = (stop - (c.pos + c.dir * CAR.halfL)) * c.dir;
      if (d < -96 || d > reach) continue;
      if (l.phase === YELLOW && d <= mph * 3 * 16) continue;
      return stop;
    }
    return null;
  }
}

/** Postes (STOP3E) y luces (STOP3G/Y/R) de los semáforos visibles. */
export class SignalSprites {
  private group = new THREE.Group();
  private pool: { pole: THREE.Mesh; lamp: THREE.Mesh }[] = [];
  private used = 0;
  private pole: THREE.Texture | null = null;
  private lamps: THREE.Texture[] = [];
  constructor(scene: THREE.Scene) { scene.add(this.group); }

  async load(pole: string, lamps: string[]) {
    this.pole = await pixelTexture(pole);
    this.lamps = await Promise.all(lamps.map((u) => pixelTexture(u)));
  }

  begin() { this.used = 0; }

  /** Coloca un poste con su luz: anclaje abajo en el centro (FUN_0041f220), `upp` unidades de escena por píxel. */
  place(x: number, y: number, z: number, upp: number, mirror: boolean, phase: number) {
    if (!this.pole) return;
    let s = this.pool[this.used];
    if (!s) {
      const mesh = (map: THREE.Texture | null) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
        m.frustumCulled = false;
        this.group.add(m);
        return m;
      };
      s = { pole: mesh(this.pole), lamp: mesh(null) };
      this.pool.push(s);
    }
    this.used++;
    const img = this.pole.image as { width: number; height: number };
    for (const m of [s.pole, s.lamp]) {
      m.position.set(x, y, z);
      m.scale.set(img.width * upp * (mirror ? -1 : 1), img.height * upp, 1);
    }
    s.lamp.position.z += 0.002;
    s.pole.visible = true;
    const lamp = this.lamps[phase];
    s.lamp.visible = !!lamp;
    const mat = s.lamp.material as THREE.MeshBasicMaterial;
    if (lamp && mat.map !== lamp) { mat.map = lamp; mat.needsUpdate = true; }
  }

  end() {
    for (let k = this.used; k < this.pool.length; k++) this.pool[k].pole.visible = this.pool[k].lamp.visible = false;
  }
}

/** FUN_0043b970: la calle que cruza a cada lado de los cortes con +0x37 & 0x20. */
export class CrossStreets {
  private crosswalk: QuadBatch;
  private lanes: QuadBatch[];
  private unit: number;
  private v = [0, 1, 2, 3].map(() => new THREE.Vector3());
  constructor(scene: THREE.Scene, unit: number, urls: { crosswalk: string; lanes: string[] }) {
    this.unit = unit;
    const batch = (url: string) => {
      const b = new QuadBatch(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      b.mesh.visible = false;
      pixelTexture(url).then((tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        (b.mesh.material as THREE.MeshBasicMaterial).map = tex;
        (b.mesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
        b.mesh.visible = true;
      });
      scene.add(b.mesh);
      return b;
    };
    this.crosswalk = batch(urls.crosswalk);
    this.lanes = urls.lanes.map(batch);
  }

  /** `slices` con el desplazamiento del centro ya sumado (roadView). Tiras de 0x200 desde el borde del asfalto. */
  update(slices: ViewSlice[], t: Track) {
    const U = this.unit;
    const [a0, a1, b0, b1] = this.v;
    for (let r = 0; r + 1 < slices.length; r++) {
      const s0 = slices[r], s1 = slices[r + 1];
      const f = t.cross[s0.index];
      if (!(f & 0x20) || s0.index === s1.index) continue;
      const lane = this.lanes[Math.min(this.lanes.length - 1, Math.max(0, (f & 7) - 1))];
      for (const side of [-1, 1]) {
        const e0 = side < 0 ? -t.laneL[s0.index] * LANE : t.laneR[s0.index] * LANE;
        const e1 = side < 0 ? -t.laneL[s1.index] * LANE : t.laneR[s1.index] * LANE;
        for (let k = 0; k < 9; k++) {
          const x0 = e0 + side * k * 0x200, x1 = x0 + side * 0x200;
          const y0 = e1 + side * k * 0x200, y1 = y0 + side * 0x200;
          a0.set((s0.x + Math.min(x0, x1)) / U, s0.y / U, -s0.z / U);
          a1.set((s0.x + Math.max(x0, x1)) / U, s0.y / U, -s0.z / U);
          b0.set((s1.x + Math.min(y0, y1)) / U, s1.y / U, -s1.z / U);
          b1.set((s1.x + Math.max(y0, y1)) / U, s1.y / U, -s1.z / U);
          (k === 0 ? this.crosswalk : lane).add(a0, a1, b0, b1);
        }
      }
    }
    this.crosswalk.commit();
    for (const b of this.lanes) b.commit();
  }
}

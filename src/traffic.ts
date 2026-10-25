// Tráfico: coches por los carriles, port de ROADRASH.EXE.
//
//   FUN_0044db80  al empezar: FUN_0044dd00(−0x19) → escala de velocidad DAT_004b7e8c = 25 y flujo
//                 DAT_004b7e84 = DAT_004b7ea4 = 2500 (avance del tráfico, ·256 por tick); FUN_0044dd00(6) →
//                 separación DAT_004b7e88 = DAT_004b7e9c = 2500·6·60 >> 8 = 3515. Temporizadores: contrario
//                 = 3515, mismo sentido delante = 0, detrás = −3515.
//   FUN_0044dd90  cada tick, con el avance del jugador `adv`:
//                 · contrario: t −= 2500/256 + adv; si < 0, coche de tipo 2 en el corte de delante (cámara
//                   + 0x5000 − 0x100) en un carril izquierdo al azar (−1 − rand % izq.), t += 3515;
//                 · mismo sentido delante: t += 2500/256 − adv; si < 0, tipo 0 delante en un carril derecho
//                   (rand % der.), t += 3515; tope 2·3515;
//                 · mismo sentido detrás: t += 2500/256 − adv; si > 0, tipo 0 en el corte de atrás
//                   (cámara − 0x3000 + 0x100), t −= 3515; tope −2·3515.
//   FUN_0044df60  crea el coche: lateral = (+0xCC + carril·0xFA + 0x7D)·256 (centro del carril), modelo al
//                 azar entre los que no tienen bandera de tipo (0x1C0000) o tienen la suya (0x100000 mismo
//                 sentido, 0x80000 contrario, 0x40000 cruce), sin contar el último; velocidad propia
//                 +0x1C4 = (rand & 0x7F) + 0xC0. Plantilla 0x475698: media anchura 0x4000, media longitud
//                 0x40, altura 0x2300, restitución 0xC0, masa 0x708, choque FUN_0044efa0.
//   FUN_0044e710  conducción: velocidad objetivo = (25·propia >> 8)·100 con aceleración propia·0x12 >> 8
//                 (FUN_004498c0: v += a; tope el objetivo); sigue el centro de su carril; si el vehículo de
//                 delante en su carril está cerca, cambia de carril si hay otro de su sentido o iguala su
//                 velocidad; si su carril desaparece, pasa al contiguo o se para.
//                 [I] Distancias de seguimiento y cambio de carril simplificadas (FUN_0044a070/FUN_00449a80).
//   FUN_00446830  dibujo con escala 0x500 (pilotos 0x200) → 5 unidades por píxel de baja resolución.
//   Tipos 1 y 3 (cruce, src/crossing.ts): FUN_0041f040 los crea al ponerse en verde un semáforo de la calle
//                 que cruza, a ∓0x78000 del centro y en el centro de su carril (paso + 0x80); FUN_0044e710 les da
//                 rumbo lateral (+0x1DC = ±0x32000) y media anchura 0xA000 (plantilla 0x475700 + tipo·0x18);
//                 FUN_0044dc10 los quita al pasar el borde contrario. Al chocar se paran 60 ticks (FUN_0044efa0).
//   Semáforos: los coches de tipo 0/2 buscan el de su tipo por delante (FUN_00449e60, banderas 0x468f00) y,
//                 en rojo o en ámbar con distancia para frenar, paran en la línea (FUN_00449a80).

import * as THREE from "three/webgpu";
import { RiderAnimator, type RiderAnims } from "./riders.ts";
import { PoseSprite, type Atlas } from "./sprites.ts";

export interface CarModel { flags: number; base: number; anims: RiderAnims }

const SPEED = 25; // DAT_004b7e8c
const FLOW = SPEED * 100; // DAT_004b7e84 / DAT_004b7ea4
const GAP = (FLOW * 6 * 60) >> 8; // DAT_004b7e88 / DAT_004b7e9c
// Ajuste propio (no del original): un 20 % menos de tráfico; los temporizadores se recargan con 3515 / 0,8.
export const TRAFFIC_DENSITY = 0.8;
const SPAWN_GAP = Math.round(GAP / TRAFFIC_DENSITY);
export const SAME = 0, ONCOMING = 2, CROSS_RIGHT = 1, CROSS_LEFT = 3;
const TYPE_FLAG: Record<number, number> = { [SAME]: 0x100000, [ONCOMING]: 0x80000, [CROSS_RIGHT]: 0x40000, [CROSS_LEFT]: 0x40000 };
export const CAR = { halfW: 0x4000, halfL: 0x40, height: 0x2300, mass: 0x708 };
/** Escala de dibujo: unidades por píxel del sprite (0x500 frente a 0x200 = 2 unidades de los pilotos). */
export const CAR_UNITS_PER_PIXEL = 5;
const LANE = 250;

/** Carretera en un paso, en el sistema de la ruta principal (centro +0xCC y carriles a cada lado). */
export interface LaneInfo { center: number; left: number; right: number }

export class Car {
  type: number;
  model: CarModel;
  lane: number; // carril con signo: 0.. a la derecha, −1.. a la izquierda (FUN_0044df60)
  pos: number;
  lat: number;
  v = 0; // velocidad (≥ 0) en su sentido
  speed: number; // +0x1C4
  branch: 0 | 1 = 0; // 1: en la otra carretera de una zona doble (tras cambiar de rama el jugador)
  hitTimer = 0; // +0x1F8: parado tras un golpe (solo los que cruzan)
  prevPos: number;
  prevLat: number;
  readonly anim: RiderAnimator;
  readonly sprite: PoseSprite;
  constructor(type: number, model: CarModel, lane: number, pos: number, lat: number, speed: number, sprite: PoseSprite) {
    this.type = type;
    this.model = model;
    this.lane = lane;
    this.pos = this.prevPos = pos;
    this.lat = this.prevLat = lat;
    this.speed = speed;
    this.sprite = sprite;
    this.anim = new RiderAnimator(model.anims);
    this.anim.set(0); // 'Cars' (FUN_004467e0); 'Car1'/'Car2' son los niveles pequeños, sin imagen en el .CAR
    this.v = this.maxV;
  }
  get dir() { return this.type === ONCOMING ? -1 : 1; }
  get crossing() { return (this.type & 1) !== 0; }
  /** Media anchura: 0x4000, o 0xA000 de lado (los que cruzan). */
  get halfW() { return this.crossing ? 0xa000 : CAR.halfW; }
  get maxV() { return ((SPEED * this.speed) >> 8) * 100; }
  get accel() { return (this.speed * 0x12) >> 8; }
  /** Velocidad con signo en el sentido de la ruta. */
  get vel() { return this.crossing ? 0 : this.v * this.dir; }
}

export class Traffic {
  readonly cars: Car[] = [];
  private models: CarModel[] = [];
  private texture: THREE.Texture | null = null;
  private atlas: Atlas | null = null;
  private scene: THREE.Scene;
  private pool: PoseSprite[] = [];
  private tOncoming = SPAWN_GAP;
  private tAhead = 0;
  private tBehind = -SPAWN_GAP;
  /** rand() del juego (FUN_00441750) sustituido por Math.random. */
  rand = () => Math.floor(Math.random() * 0x8000);
  constructor(scene: THREE.Scene) { this.scene = scene; }

  setModels(models: CarModel[], texture: THREE.Texture, atlas: Atlas) {
    this.clear();
    for (const s of this.pool) this.scene.remove(s.mesh);
    this.pool.length = 0;
    this.models = models;
    this.texture = texture;
    this.atlas = atlas;
  }

  clear() {
    for (const c of this.cars) this.release(c);
    this.cars.length = 0;
    this.tOncoming = SPAWN_GAP;
    this.tAhead = 0;
    this.tBehind = -SPAWN_GAP;
  }

  remove(c: Car) {
    const k = this.cars.indexOf(c);
    if (k >= 0) { this.release(c); this.cars.splice(k, 1); }
  }

  private release(c: Car) {
    c.sprite.mesh.visible = false;
    this.pool.push(c.sprite);
  }

  /** FUN_0044dd90. `lanesAt(paso)`; `cam` = posición de la cámara (unidades). */
  spawnTick(adv: number, cam: number, lanesAt: (i: number) => LaneInfo | null) {
    if (!this.models.length) return;
    const flow = FLOW >> 8;
    const front = Math.floor((cam + 0x5000 - 0x100) / 256), back = Math.floor((cam - 0x3000 + 0x100) / 256);
    this.tOncoming -= flow + adv;
    if (this.tOncoming < 0) {
      const l = lanesAt(front);
      const n = l ? Math.floor(l.left) : 0;
      if (l && n > 0) this.spawn(ONCOMING, -1 - (this.rand() % n), front, l);
      this.tOncoming += SPAWN_GAP;
    }
    this.tAhead += flow - adv;
    if (this.tAhead < 0) {
      const l = lanesAt(front);
      const n = l ? Math.floor(l.right) : 0;
      if (l && n > 0) this.spawn(SAME, this.rand() % n, front, l);
      this.tAhead += SPAWN_GAP;
    } else if (this.tAhead > 2 * SPAWN_GAP) this.tAhead = 2 * SPAWN_GAP;
    this.tBehind += flow - adv;
    if (this.tBehind > 0) {
      const l = lanesAt(back);
      const n = l ? Math.floor(l.right) : 0;
      if (l && n > 0) this.spawn(SAME, this.rand() % n, back, l);
      this.tBehind -= SPAWN_GAP;
    } else if (this.tBehind < -2 * SPAWN_GAP) this.tBehind = -2 * SPAWN_GAP;
  }

  /** FUN_0044df60 */
  private spawn(type: number, lane: number, step: number, l: LaneInfo) {
    const flag = TYPE_FLAG[type];
    const pick = this.models.slice(0, -1).filter((m) => (m.flags & 0x1c0000) === 0 || (m.flags & flag) !== 0);
    if (!pick.length || !this.texture || !this.atlas) return;
    const model = pick[this.rand() % pick.length];
    const sprite = this.pool.pop() ?? this.newSprite();
    const lat = (l.center + lane * LANE + 0x7d) * 256;
    this.cars.push(new Car(type, model, lane, step * 256, lat, (this.rand() & 0x7f) + 0xc0, sprite));
  }

  /** FUN_0041f040 → FUN_0044df60 con tipo 1/3: coche que cruza en el paso `step`, desde ∓0x78000 del centro. */
  spawnCross(type: number, step: number, center: number) {
    const flag = TYPE_FLAG[type];
    const pick = this.models.slice(0, -1).filter((m) => (m.flags & 0x1c0000) === 0 || (m.flags & flag) !== 0);
    if (!pick.length || !this.texture || !this.atlas) return;
    const model = pick[this.rand() % pick.length];
    const sprite = this.pool.pop() ?? this.newSprite();
    const lat = center * 256 + (type === CROSS_LEFT ? 0x78000 : -0x78000);
    this.cars.push(new Car(type, model, 0, step * 256 + 0x80, lat, (this.rand() & 0x7f) + 0xc0, sprite));
  }

  private newSprite() {
    const s = new PoseSprite(this.texture!, this.atlas!);
    this.scene.add(s.mesh);
    return s;
  }

  /** FUN_0044e710 (simplificada) + avance. Quita los coches fuera del anillo de cortes (cámara −48 / +80 pasos). */
  /** `stopAt(coche)`: posición de la línea donde debe parar (semáforo en rojo o ámbar), o null. */
  tick(cam: number, lanesAt: (i: number, branch: number, pos: number) => LaneInfo | null, keep: (c: Car) => boolean, stopAt: (c: Car) => number | null) {
    const gone = new Set<Car>();
    for (const c of this.cars) {
      c.prevPos = c.pos;
      c.prevLat = c.lat;
      const i = Math.floor(c.pos / 256);
      const l = lanesAt(i, c.branch, c.pos);
      if (c.crossing) {
        // Cruza de lado; parado mientras dura el golpe; fuera al pasar el borde contrario (FUN_0044dc10).
        if (c.hitTimer > 0) { c.hitTimer--; c.v = 0; } else c.v = Math.min(c.maxV, c.v + c.accel);
        c.lat += c.type === CROSS_LEFT ? -c.v : c.v;
        const off = l ? c.lat / 256 - l.center : 0;
        if (!l || (c.type === CROSS_LEFT ? off < -0x780 - 200 : off > 0x780 + 200)) gone.add(c);
        c.anim.tick();
        continue;
      }
      let target = c.maxV;
      if (!l) target = 0;
      else {
        // Su carril sigue existiendo; si no, al contiguo hacia el centro; sin carriles de su sentido, se para.
        const n = Math.floor(c.type === SAME ? l.right : l.left);
        if (n <= 0) target = 0;
        else if (c.type === SAME && c.lane >= n) c.lane = n - 1;
        else if (c.type === ONCOMING && -c.lane > n) c.lane = -n;
        // Vehículo de delante en su carril.
        const ahead = this.ahead(c);
        if (ahead) {
          const gap = Math.abs(ahead.pos - c.pos);
          const other = c.lane + (c.type === SAME ? 1 : -1), back = c.lane - (c.type === SAME ? 1 : -1);
          const fits = (k: number) => (c.type === SAME ? k >= 0 && k < n : k <= -1 && -k <= n);
          if (gap < 0x600 && ahead.v < c.v && (fits(other) || fits(back)) && !this.blocked(c, fits(other) ? other : back))
            c.lane = fits(other) ? other : back;
          // [I] Se acerca hasta 0x180 detrás del de delante.
          else if (gap < 0x800) target = Math.min(target, ahead.v + Math.max(0, gap - 0x180) * 8);
        }
        // Semáforo: frena hasta la línea; si ya la ha pasado (más de 6·16), sigue (FUN_0044e710).
        const stop = stopAt(c);
        if (stop !== null) {
          const d = (stop - (c.pos + c.dir * CAR.halfL)) * c.dir;
          if (d > -96) target = Math.min(target, d > 4 ? d * 12 : 0);
        }
        // Hacia el centro de su carril (FUN_00449880: rumbo hacia un punto 800 por delante).
        const want = (l.center + c.lane * LANE + 0x7d) * 256;
        const d = want - c.lat, step = Math.max(64, (c.v * 0x100) >> 8);
        c.lat += Math.sign(d) * Math.min(Math.abs(d), step);
      }
      // FUN_004498c0: acelera hasta el objetivo; si el objetivo es menor, lo toma.
      c.v = Math.min(target, c.v + c.accel);
      c.pos += (c.vel * 2) >> 1 >> 8;
      c.anim.tick();
    }
    for (let k = this.cars.length - 1; k >= 0; k--) {
      const c = this.cars[k];
      if (c.pos < cam - 0x3000 || c.pos > cam + 0x5100 || !keep(c) || gone.has(c)) {
        this.release(c);
        this.cars.splice(k, 1);
      }
    }
  }

  /** Vehículo más cercano por delante en el mismo carril y sentido (FUN_0044a070). */
  private ahead(c: Car) {
    let best: Car | null = null, d = 0x1000;
    for (const o of this.cars) {
      if (o === c || o.type !== c.type || o.lane !== c.lane || o.branch !== c.branch) continue;
      const g = (o.pos - c.pos) * c.dir;
      if (g > 0 && g < d) { d = g; best = o; }
    }
    return best;
  }

  private blocked(c: Car, lane: number) {
    return this.cars.some((o) => o !== c && o.lane === lane && o.type === c.type && Math.abs(o.pos - c.pos) < 0x300);
  }
}

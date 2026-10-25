// Choques entre motos y contra los objetos del borde: port de ROADRASH.EXE.
//
//   Plantilla de la moto (0x463ad8 / 0x463ba8 → FUN_004387a0): media anchura +0x174 = 0x1E00 (lateral,
//   1/256 de unidad), media longitud +0x178 = 0x40 (avance), altura +0x17C = 0x2300, restitución
//   +0x180 = 0xC0, masa +0x194 = 0x100, función de choque +0x1A4 = FUN_004049c0.
//
//   FUN_004368f0  cada tick, cada par de objetos que se solapan en avance (|Δ| ≤ suma de +0x178), lateral
//                 (≤ suma de +0x174) y altura → FUN_00436a40 y la función de choque de cada uno.
//                 Si la moto pasa por el centro del corte (|avance & 0xFF − 0x80| < +0x178), FUN_004373f0.
//   FUN_00436a40  con las posiciones del tick anterior decide el eje: si antes no se solapaban en avance,
//                 golpe por detrás/delante → se separan en avance (según la masa) e impulso
//                 Δv·2·m₂/(m₁+m₂); si no se solapaban de lado, se separan de lado (+0x800).
//                 Bandera 0x40: el otro cubre el centro de la moto (|Δlateral| < media anchura/2).
//   FUN_004049c0  respuesta (impulsos · restitución/256):
//                 altura del otro < 0x2000 → nada (se pasa por encima);
//                 sin 0x40 → modo 3 (roce): daño/8, lateral ±|impulso|/2 y velocidad −|impulso|/4;
//                 con 0x40 y altura < 0x2800 → modo 1; si no → modo 2 (daño ·7/4).
//                 Modos 1/2: si la diferencia de velocidad es < 6001 rebota (v += impulso); si no, caída.
//                 [I] El port escala el rebote por BOUNCE (ajuste propio, ver abajo).
//                 Daño = (|impulso de avance| + |lateral|) >> 10 al piloto y a la moto; contra otra moto
//                 o piloto, 0 al piloto y daño/16 a la moto.
//   FUN_004373f0  objetos del corte (x en +0x6C, cajas en +0x68/+0x61, de RRAN nivel 2 [3]/[4] vía
//                 FUN_0044b630): caja [x0, y0, x1, y1] en 1/256 de unidad desde el anclaje (×3 en x si el
//                 objeto está a más de 0x3FF y tiene una sola caja). FUN_00437660 lo convierte en un objeto
//                 fijo: centro del corte, lateral = x del objeto, media anchura = x1 − x0, altura = y1 − y0
//                 (FUN_004049c0 la divide entre 2), masa 0x1000000, restitución 0xC0.
//   FUN_00403d60  caída: modo 2 → animación 29 (rueda), 1 y 3 → 33 (vuela).
//   Coches (plantilla 0x475698): media anchura 0x4000, altura 0x2300, masa 0x708 frente a 0x100 de la moto;
//                 FUN_00436a40 reparte la separación y el impulso según las masas. Contra un coche el daño
//                 es entero (no es moto ni piloto) y con altura < 0x2800 el modo es 1.

import type { Bike } from "./bike.ts";
import type { Fighter } from "./combat.ts";

const HALF_W = 0x1e00;
const HALF_L = 0x40;
const HEIGHT = 0x2300;
const RESTITUTION = 0xc0;
const BOUNCE_LIMIT = 6001; // 0x1771
// Ajuste propio (no del original): rebotes más suaves. El original devuelve el impulso entero (·0xC0/256), así que
// contra un objeto fijo la moto sale hacia atrás a la mitad de su velocidad (hasta −1000). Aquí el rebote, el
// empujón lateral del roce y el del coche se escalan por BOUNCE y la marcha atrás se limita a BACK_MAX.
export const BOUNCE = 0.6;
const BACK_MAX = -400;

export interface Body {
  bike: Bike;
  fight: Fighter;
  down: boolean;
  prevPos: number;
  prevLat: number;
}

export interface Crash { body: Body; anim: number }
/** Un choque: quién (la moto que choca primero), fuerza (|impulsos|) y caídas que provoca. */
export interface Contact { bodies: Body[]; strength: number; crashes: Crash[] }

export interface Obstacle { x: number; boxes: [number, number, number, number][] }

/** FUN_004052c0: aplica el daño del choque; devuelve si el piloto cae (salud o moto a 0). */
function hurt(f: Fighter, rider: number, bike: number, mode: number) {
  if (mode === 2) { rider = Math.trunc((rider * 7) / 4); bike = Math.trunc((bike * 7) / 4); }
  else if (mode === 3) { rider >>= 3; bike >>= 3; }
  f.stamina = Math.max(Math.trunc(f.staminaMax / 2), f.stamina - rider * 4);
  f.health = Math.max(0, f.health - rider * 0x40);
  f.bikeHealth = Math.max(0, f.bikeHealth - bike);
  return f.health === 0 || f.bikeHealth === 0;
}

const CRASH_ANIM = (mode: number) => (mode === 2 ? 29 : 33);

/** Desvía la moto con el cambio de velocidad lateral (FUN_004049c0: +0x288 += k·Δ+0xF0). */
function nudge(b: Bike, dLatVel: number) {
  if (!dLatVel) return;
  const lim = b.p.steerMax;
  b.steer = Math.max(-lim, Math.min(lim, b.steer + Math.trunc((dLatVel * 256) / Math.max(1, b.p.steerK))));
}

/**
 * FUN_004049c0 para una moto. `other`: lateral, velocidad, media anchura, altura y si es moto/piloto.
 * `impZ`/`impL`: impulsos sin restitución de FUN_00436a40.
 */
function respond(me: Body, other: { lat: number; v: number; halfW: number; height: number; isBike: boolean; car?: boolean }, impZ: number, impL: number): Crash | null {
  const b = me.bike;
  if (other.height < 0x2000) return null;
  const covered = Math.abs(other.lat - b.lat) < other.halfW - (HALF_W >> 1);
  const mode = !covered ? 3 : other.height < 0x2800 && (other.isBike || other.car) ? 1 : 2;
  const base = (Math.abs(impZ) + Math.abs(impL)) >> 10;
  const ko = hurt(me.fight, other.isBike ? 0 : base, other.isBike ? base >> 4 : base, mode);
  if (ko) return { body: me, anim: CRASH_ANIM(mode) };
  const rz = Math.trunc(((impZ * RESTITUTION) >> 8) * BOUNCE);
  if (mode !== 3) {
    if (b.v - other.v < BOUNCE_LIMIT) b.v = Math.max(BACK_MAX, b.v + rz);
    else return { body: me, anim: CRASH_ANIM(mode) };
  } else if (rz) {
    const push = Math.abs(rz) >> 1;
    nudge(b, other.lat < b.lat ? push : -push);
    b.v = Math.max(0, b.v - (Math.abs(rz) >> 2));
  }
  return null;
}

/** FUN_004368f0 + FUN_00436a40 + FUN_004049c0 entre dos motos. */
export function collideBikes(a: Body, b: Body): Contact | null {
  if (a.down || b.down) return null;
  const A = a.bike, B = b.bike;
  const dz = A.pos - B.pos, dl = A.lat - B.lat;
  if (Math.abs(dz) > 2 * HALF_L || Math.abs(dl) > 2 * HALF_W) return null;
  let impZ = 0, impL = 0;
  const pdz = a.prevPos - b.prevPos, pdl = a.prevLat - b.prevLat;
  if (Math.abs(pdz) > 2 * HALF_L) {
    // Golpe por detrás: se separan en avance (masas iguales: mitad cada una) e intercambian velocidad.
    const s = Math.sign(pdz) || 1, push = ((2 * HALF_L + 8 - Math.abs(dz)) >> 1) + 3;
    A.pos += s * push;
    B.pos -= s * push;
    impZ = B.v - A.v;
  }
  if (Math.abs(pdl) > 2 * HALF_W || !impZ) {
    // De lado (o ya montados): se separan de lado.
    const s = Math.sign(pdl || dl) || 1, push = ((2 * HALF_W + 0x800 - Math.abs(dl)) >> 1) + 3;
    A.lat += s * push;
    B.lat -= s * push;
    if (Math.abs(pdl) > 2 * HALF_W) impL = B.latVel - A.latVel;
  }
  const crashes: Crash[] = [];
  const va = A.v, vb = B.v, la = A.lat, lb = B.lat;
  const ca = respond(a, { lat: lb, v: vb, halfW: HALF_W, height: HEIGHT, isBike: true }, impZ, impL);
  const cb = respond(b, { lat: la, v: va, halfW: HALF_W, height: HEIGHT, isBike: true }, -impZ, -impL);
  if (ca) crashes.push(ca);
  if (cb) crashes.push(cb);
  return { bodies: [a, b], strength: Math.abs(impZ) + Math.abs(impL), crashes };
}

/** Un coche para los choques: posición, lateral y velocidad con signo, de este tick y del anterior. */
export interface Vehicle { pos: number; lat: number; vel: number; prevPos: number; prevLat: number; halfW: number; halfL: number; height: number; mass: number }

/**
 * FUN_004368f0 + FUN_00436a40 + FUN_004049c0 entre una moto y un coche. Devuelve el choque y el cambio de
 * velocidad del coche (con signo).
 */
export function collideCar(me: Body, car: Vehicle): (Contact & { carDv: number }) | null {
  if (me.down) return null;
  const A = me.bike;
  const dz = A.pos - car.pos, dl = A.lat - car.lat;
  if (Math.abs(dz) > HALF_L + car.halfL || Math.abs(dl) > HALF_W + car.halfW) return null;
  const M = 0x100 + car.mass, wMe = car.mass / M, wCar = 0x100 / M;
  let impZ = 0, impL = 0, carDv = 0;
  const pdz = me.prevPos - car.prevPos, pdl = me.prevLat - car.prevLat;
  if (Math.abs(pdz) > HALF_L + car.halfL) {
    // Por detrás o de frente: se separan en avance según las masas; impulso Δv·2·m₂/(m₁+m₂).
    const s = Math.sign(pdz) || 1, push = HALF_L + car.halfL + 8 - Math.abs(dz) + 3;
    A.pos += s * Math.round(push * wMe);
    car.pos -= s * Math.round(push * wCar);
    impZ = Math.trunc((car.vel - A.v) * 2 * wMe);
    carDv = Math.trunc((((A.v - car.vel) * 2 * wCar * RESTITUTION) / 256) * BOUNCE);
  }
  if (Math.abs(pdl) > HALF_W + car.halfW || !impZ) {
    const s = Math.sign(pdl || dl) || 1, push = HALF_W + car.halfW + 0x800 - Math.abs(dl) + 3;
    A.lat += s * Math.round(push * wMe);
    car.lat -= s * Math.round(push * wCar);
    if (Math.abs(pdl) > HALF_W + car.halfW) impL = Math.trunc(-A.latVel * 2 * wMe);
  }
  const crash = respond(me, { lat: car.lat, v: car.vel, halfW: car.halfW, height: car.height, isBike: false, car: true }, impZ, impL);
  return { bodies: [me], strength: Math.abs(impZ) + Math.abs(impL), crashes: crash ? [crash] : [], carDv };
}

/** FUN_004373f0 + FUN_00437660: objetos del borde del corte `step` (`objects` en unidades desde el centro). */
export function collideObjects(me: Body, step: number, objects: Obstacle[]): Contact | null {
  const b = me.bike;
  if (me.down || objects.length === 0) return null;
  const center = step * 256 + 0x80;
  if (Math.abs((b.pos & 0xff) - 0x80) >= HALF_L) return null;
  for (const o of objects) {
    const X = o.x * 256;
    for (const box of o.boxes) {
      let [x0, y0, x1, y1] = box;
      if (Math.abs(o.x) > 0x3ff && o.boxes.length === 1) { x0 *= 3; x1 *= 3; }
      if (!(x0 + X <= b.lat + HALF_W && b.lat - HALF_W <= x1 + X && y0 <= HEIGHT && -HEIGHT < y1)) continue;
      // Objeto fijo de FUN_00437660 contra la moto (FUN_00436a40 con masa 0x1000000: la moto se lo lleva todo).
      let impZ = 0, impL = 0;
      if (Math.abs(me.prevPos - center) > HALF_L) {
        const s = Math.sign(me.prevPos - center) || -1;
        b.pos = center + s * (HALF_L + 8 + 3);
        impZ = -2 * b.v;
      } else {
        const s = Math.sign(b.lat - X) || 1;
        b.lat = X + s * ((x1 - x0) + HALF_W + 0x800 + 3);
        if (Math.abs(me.prevLat - X) > (x1 - x0) + HALF_W) impL = -2 * b.latVel;
      }
      const crash = respond(me, { lat: X, v: 0, halfW: x1 - x0, height: (y1 - y0) >> 1, isBike: false }, impZ, impL);
      return { bodies: [me], strength: Math.abs(impZ) + Math.abs(impL), crashes: crash ? [crash] : [] };
    }
  }
  return null;
}

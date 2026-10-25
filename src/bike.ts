// Física de la moto: port de ROADRASH.EXE, un tick = 1/60 s (bucle de FUN_004163d0, FUN_0044b2e0).
//
//   FUN_00405ea0  ficha de la moto (BIKESPEC.RSC) → potencia, freno y velocidades de dirección.
//   FUN_0040adb0  acelerar: la potencia (+0x240) va hacia el objetivo; fuerza = par[marcha]·potencia >> 16.
//   FUN_0040aea0  frenar: la potencia va hacia el freno (negativo); fuerza = potencia >> 8.
//   FUN_0040acd0  sin acelerar ni frenar: la potencia vuelve a 0.
//   FUN_0040af50  dirección: ángulo ±0x20 (de 0x400 = 90°) → giro objetivo = sen·v / k, limitado a ±0x2E00.
//   FUN_004390c0  velocidad: v += fuerza − arrastre (130·v>>16 + 8 + superficie·v>>14) − deslizamiento.
//   FUN_004391d0  marchas automáticas por umbrales de la ficha.
//   FUN_004349c0  revoluciones: par de la marcha · v >> 8 + 0x2000, a saltos de ±0x2000.
//   FUN_004395e0  avance: v·dt/256 (posición en 1/256 de paso); lateral += velocidad lateral + empuje de curva.
//   FUN_004394c0  empuje de curva: −curvatura · avance; se suma ·400 >> 8 a la velocidad lateral.
//   FUN_0043a0c0  superficie: asfalto (borde + 48), arcén/tierra, fuera de pista.
//   FUN_00438c70  agarre: ((0x148 o 0x14C)·ficha+0x294 >> 8)·superficie (0x46dce8) >> 8, frente a lo pedido
//                 = |fuerza sobrante| + |(v >> 11)·(giro >> 8)|. Si no llega, derrapa (+0x278 |= 4): en tierra
//                 el giro se bambolea (0x46dd28), +0x118 = (Δgiro·0x46dd08 + giro·0x46dcf8) >> 8 y, con más
//                 de 40 de exceso (+0x164), v −= 0x46dd18. Sin derrape, +0x118 = giro (al frenar ·+0x25C >> 8).
//                 Jugador: con agarre < +0x290 y el giro a tope más de 0x19 ticks, se cae (FUN_00403d60, 6).
//                 Inclinación visual (+0x60): atan2(74, giro >> 8), mitad por debajo de 4000, +1/8 por encima
//                 de 8000.
//   FUN_004390c0  además del arrastre, girar frena: v −= |+0x118| / 16.
//   FUN_004395e0  rumbo propio (+0x5C) = atan2(4v, v. lateral) · (+0x2B8 >> 8) = 0, o · (+0x2BC >> 8) = 10
//                 derrapando; ±0x3F0000 perdiendo el control; ±0x180000 por debajo de 4000. Derrapando con
//                 exceso ≥ 51, el empuje de curva es ·800 (jugador) o ·600 en vez de ·400.
//   Velocidad mostrada (FUN_00409f70): (v>>12) + (v>>7) + (v>>9) ≈ v/100 mph.

export interface PhysicsData {
  bikes: number[][];
  riderWeights: number[];
  aiPower: number[];
  atan: number[];
  surfaceDrag: number[];
  engines: Record<string, number>;
  aiCruise: number[][];
  aiRubber: number[];
  riders: { weapon: number[]; strength: number; stamina: number }[];
  bikesByLevel: number[][];
  grid: { player: [number, number]; rivals: [number, number][]; rivalsLast: [number, number][] };
  attackDamage: number[];
  aggression: number[];
  aiFight: { attitude: number; kickOdds: number; backOdds: number; reach: number }[];
  names: string[];
  copNames?: string[];
  courseMiles?: number[][];
  grip?: GripTables;
}

/** Tablas de FUN_00438c70 por superficie (asfalto, arcén, tierra, fuera de pista). */
export interface GripTables { lean: number; grip: number[]; slideK: number[]; slideD: number[]; slipLoss: number[]; wobble: number[][] }

/** Resistencia de la moto (+0x2EC, ficha SPEC → +0x1C4.., FUN_00405ea0). */
export const bikeDurability = (spec: number[]) => field(spec, 0x2ec);

/** Campo del objeto moto copiado de la ficha: +off → SPEC[7 + (off − 0x1C4)/4] (FUN_00405ea0). */
const field = (spec: number[], off: number) => spec[7 + (off - 0x1c4) / 4];
const trunc = Math.trunc;

/** Seno de FUN_0044f4a0 (0x1000 = 360°, resultado en 16.16). */
const sin16 = (a: number) => Math.round(Math.sin(((a & 0xfff) / 0x1000) * 2 * Math.PI) * 65536);

/** Arcotangente de FUN_0044f5a0: atan2 en 8 bits (0x100 = 360°). */
export function atan2_8(x: number, y: number) {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x), ay = Math.abs(y);
  let k = x < 0 ? 1 : 0;
  if (y < 0) k |= 2;
  if (ax < ay) k |= 4;
  switch (k) {
    case 0: return trunc((ay * 0x20) / ax);
    case 1: return 0x80 - trunc((ay * 0x20) / ax);
    case 2: return -trunc((ay * 0x20) / ax);
    case 3: return trunc((ay * 0x20) / ax) - 0x80;
    case 4: return 0x40 - trunc((ax * 0x20) / ay);
    case 5: return trunc((ax * 0x20) / ay) + 0x40;
    case 6: return trunc((ax * 0x20) / ay) - 0x40;
    default: return -0x40 - trunc((ax * 0x20) / ay);
  }
}

export interface Gear { rpm: number; torque: number; up: number; down: number }

export interface BikeParams {
  gears: Gear[];
  power: number; // +0x260
  powerUp: number; // +0x264
  powerDown: number; // +0x268
  brake: number; // +0x27C (negativo)
  brakeUp: number; // +0x280
  brakeDown: number; // +0x284
  steerMax: number; // +0x29C
  steerIn: number; // +0x2A8
  steerOut: number; // +0x2AC
  steerK: number; // +0x2B0
  steerBoost: number; // +0x2D0
  steerSoft: number; // +0x2D4
  brakeSlide: number; // +0x25C: deslizamiento al frenar
  lossGrip: number; // +0x290: agarre por debajo del cual se pierde el control
  gripK: number; // +0x294
  headK: number; // +0x2B8
  skidHeadK: number; // +0x2BC
}

/** FUN_00405ea0 con la ficha `spec`, el peso del corredor y (IA) el % de potencia del nivel. */
export function bikeParams(spec: number[], riderWeight: number, aiPowerPct = 100, ai = false): BikeParams {
  const w = spec[6];
  const p2 = trunc(riderWeight / 2);
  const gears: Gear[] = [];
  for (let g = 0; g < 7; g++) {
    const base = 0x1cc + g * 16;
    gears.push({ rpm: field(spec, base), torque: field(spec, base + 4), up: field(spec, base + 8), down: field(spec, base + 12) });
  }
  if (ai) for (const [g, d] of [[0, 25], [1, 15], [2, 8], [3, 4]] as const) gears[g].torque -= d; // FUN_00405990
  const powBase = field(spec, 0x250) * (w + 0x4b) * 0x100;
  const brkBase = field(spec, 0x26c) * (w + 0x4b) * 0x100;
  const d1 = w + (p2 >> 2);
  const a0 = trunc((field(spec, 0x2a0) * (w + 0x4b)) / d1);
  const a1 = trunc((field(spec, 0x2a4) * (w + 0x4b)) / d1);
  const d2 = w + 0x4b + (trunc((p2 - 0x4b) / 8));
  let power = trunc(powBase / d2);
  const brake = trunc(brkBase / d2);
  const lim = (n: number) => Math.min(n, 15);
  const powerUp = trunc(power / lim(field(spec, 0x254)));
  const powerDown = trunc(power / lim(field(spec, 0x258)));
  if (ai) power = trunc((aiPowerPct * power) / 100);
  return {
    gears,
    power,
    powerUp,
    powerDown,
    brake,
    brakeUp: trunc(brake / lim(field(spec, 0x270))),
    brakeDown: trunc(brake / lim(field(spec, 0x274))),
    steerMax: 0x2e00,
    steerIn: trunc(0x2e00 / a0),
    steerOut: trunc(0x2e00 / a1),
    steerK: field(spec, 0x2b0),
    steerBoost: field(spec, 0x2d0),
    steerSoft: field(spec, 0x2d4),
    brakeSlide: field(spec, 0x25c),
    lossGrip: field(spec, 0x290),
    gripK: field(spec, 0x294),
    headK: field(spec, 0x2b8),
    skidHeadK: field(spec, 0x2bc),
  };
}

export interface RoadInfo {
  curve: number; // byte0 del paso actual
  left: number; // borde izquierdo del asfalto (negativo, unidades)
  right: number;
  shoulderL: number; // borde exterior del arcén (negativo)
  shoulderR: number;
  sidewalk: boolean; // modo de dibujo 0 (edificios): el arcén es acera
}

export class Bike {
  pos = 0; // en 1/256 de paso (+0x1C)
  lat = 0; // lateral en 1/256 de unidad (+0x28)
  v = 0; // velocidad (+0xEC), ≈ mph·100
  power = 0; // +0x240
  force = 0; // +0x114
  gear = 0; // +0x23C
  rpm = 0x2000; // +0x2DC
  steer = 0; // +0x288
  latVel = 0; // +0xF0
  roll = 0; // inclinación visual (+0x60), ángulo de 24 bits
  heading = 0; // rumbo propio (+0x5C), ángulo de 24 bits
  surface = 0;
  prevSteer = 0; // +0x28C
  slide = 0; // +0x118
  slip = 0; // +0x164: exceso sobre el agarre (int8)
  skid = 0; // +0x278: 1 perdiendo el control, 4 derrapando
  private lossTimer = 0; // DAT_0046dce0
  private drag = 0; // +0x15C del tick anterior
  readonly p: BikeParams;
  private surfaceDrag: number[];
  private grip: GripTables | null;
  constructor(p: BikeParams, surfaceDrag: number[], grip: GripTables | null = null) {
    this.p = p;
    this.surfaceDrag = surfaceDrag;
    this.grip = grip;
  }

  /** Velocidad que muestra el velocímetro (FUN_00409f70). */
  get mph() { return (this.v >> 12) + (this.v >> 7) + (this.v >> 9); }
  get latUnits() { return this.lat / 256; }

  /** FUN_0040adb0 */
  throttle(target: number) {
    const p = this.p;
    target = Math.min(target, p.power);
    let pw = this.power;
    if (pw < target) pw = Math.min(target, pw + p.powerUp);
    else if (target < pw) pw = Math.max(target, pw - p.powerDown);
    this.power = pw;
    this.force = pw < 1 ? pw >> 8 : (p.gears[this.gear].torque * pw) >> 16;
  }
  /** FUN_0040aea0 (target ≤ 0) */
  brake(target: number) {
    const p = this.p;
    if (this.v === 0) { this.power = 0; this.force = 0; return; }
    target = Math.max(target, p.brake);
    let pw = this.power;
    if (pw < target) pw = Math.min(target, pw + Math.abs(p.brakeDown));
    else if (target < pw) pw = Math.max(target, pw - Math.abs(p.brakeUp));
    this.power = pw;
    this.force = pw >> 8;
  }
  /** FUN_0040acd0(…, 0) */
  coast() {
    if (this.power >= 0) this.throttle(0);
    else this.brake(0);
  }

  /** FUN_0040af50: `angle` en unidades de FUN_0040ad30 (±0x20 = 45°), `dir` = −signo del teclado. */
  steerTo(angle: number, dir: number) {
    const p = this.p;
    if (this.v <= 0) { this.latVel = 0; this.slide = 0; return; }
    this.prevSteer = this.steer;
    const a = Math.max(-0x200000, Math.min(0x200000, angle << 16));
    let target = trunc(((sin16((a << 4) >> 16) >> 8) * this.v) / p.steerK);
    const lim = p.steerMax + (dir !== 0 ? p.steerMax >> 2 : 0);
    if (target > lim) target = lim;
    else if (target < -lim) target = -lim;
    let cur = this.steer;
    const rate = target === 0 || Math.abs(target) <= Math.abs(cur) ? p.steerOut : p.steerIn;
    let next: number;
    if (target < cur) {
      next = target;
      if (rate < cur - target) {
        if (dir < 0) cur -= (p.steerBoost * rate) >> 8;
        next = dir < 1 ? cur - rate : cur - ((p.steerSoft * rate) >> 8);
      }
    } else {
      next = cur;
      if (cur < target) {
        next = target;
        if (rate < target - cur) {
          if (dir > 0) cur += (p.steerBoost * rate) >> 8;
          next = dir < 0 ? cur + ((p.steerSoft * rate) >> 8) : cur + rate;
        }
      }
    }
    this.steer = next;
    this.latVel = (next >> 8) * p.steerK;
  }

  /** FUN_00438c70: agarre y derrape. Devuelve si el jugador pierde el control y se cae. */
  private traction(s: number, player: boolean): boolean {
    const g = this.grip, p = this.p;
    this.skid = 0;
    if (!g) { this.slide = this.steer; return false; }
    if (this.v < 1) this.steer = 0;
    const grip = Math.max(0, ((((this.slip ? 0x100 : 300) * p.gripK) >> 8) * g.grip[s]) >> 8);
    let lost = false;
    if (player && grip < p.lossGrip && Math.abs(this.steer) >= p.steerMax) {
      this.skid = 1;
      lost = ++this.lossTimer > 0x19;
    } else this.lossTimer = 0;
    const f = this.force;
    const u = f > this.drag ? f - this.drag : f < 1 ? (this.v < 1 ? 0 : f) : 0;
    const demand = Math.abs(u) + Math.abs((this.v >> 11) * (this.steer >> 8));
    let slide: number;
    if (grip < demand && this.v >= 0) {
      if (s > 1) {
        const w = trunc((g.wobble[(this.pos >> 8) & 7][s] * this.steer) / 256);
        this.steer = Math.max(-p.steerMax, Math.min(p.steerMax, w));
      }
      slide = trunc(((this.steer - this.prevSteer) * g.slideD[s]) / 256) + trunc((g.slideK[s] * this.steer) / 256);
      this.slip = ((demand - grip) << 24) >> 24; // (char) en el original
      if (this.slip > 40) this.v = Math.max(0, this.v - g.slipLoss[s]);
      this.skid |= 4;
    } else {
      this.slip = 0;
      slide = this.steer;
    }
    if (u < 0) slide = trunc((p.brakeSlide * slide) / 256);
    this.slide = slide >> 8;
    return lost;
  }

  /**
   * Un tick de física (FUN_00438c70, FUN_004390c0, FUN_004391d0, FUN_004349c0, FUN_004395e0, FUN_0043a0c0).
   * Devuelve si el jugador pierde el control (`player`) y se cae.
   */
  step(road: RoadInfo, player = false): boolean {
    // Superficie bajo la moto.
    const x = this.lat >> 8;
    let s = 0;
    if (x > road.right) s = x >= road.shoulderR ? 3 : road.sidewalk ? 1 : x <= road.right + 0x30 ? 0 : 2;
    else if (x < road.left) s = x <= road.shoulderL ? 3 : road.sidewalk ? 1 : x >= road.left - 0x30 ? 0 : 2;
    this.surface = s;
    const lost = this.traction(s, player);

    // Velocidad (en el suelo); girar también frena (|+0x118| / 16).
    const av = Math.abs(this.v);
    const roll = ((this.surfaceDrag[s] * av) >> 14) + 8;
    const drag = ((130 * (av >> 8)) >> 8) + roll;
    this.drag = drag;
    const turn = Math.abs(this.slide) >> 4;
    if (this.v >= 0) {
      const nv = this.v + (this.force - drag - turn);
      this.v = nv < 1 ? (this.force < 1 ? 0 : 100) : nv;
    } else {
      // Rebote hacia atrás tras un choque (FUN_004049c0 permite hasta −1000): el arrastre lo frena.
      this.v = Math.min(0, this.v + drag + turn + Math.max(0, this.force));
    }

    // Marchas.
    const g = this.p.gears;
    if (this.v > g[this.gear].up) this.gear = Math.min(6, this.gear + 1);
    else if (this.v < g[this.gear].down) this.gear = Math.max(0, this.gear - 1);

    // Revoluciones.
    const target = ((g[this.gear].rpm * this.v) >> 8) + 0x2000;
    this.rpm = Math.max(this.rpm - 0x2000, Math.min(this.rpm + 0x2000, target));
    this.rpm = Math.max(0x2000, Math.min(0xffff, this.rpm));

    // Avance y desplazamiento lateral.
    const adv = (this.v * 2) >> 1 >> 8; // (2v − a·dt)·dt/2 >> 8 con dt = 1 y a despreciable
    this.pos += adv;
    let lv = this.latVel;
    const push = -road.curve * adv; // FUN_004394c0 (+0x130)
    // Derrapando con mucho exceso, la curva empuja el doble (jugador) o 1,5 veces (IA).
    const k = this.skid & 4 && this.slip >= 51 ? (player ? 800 : 600) : 400;
    lv += (push * k) >> 8;
    if (this.v > 300) this.lat = Math.max(-0xc8000, Math.min(0xc8000, this.lat + lv));

    // Rumbo propio (FUN_004395e0): solo derrapando (+0x2B8 >> 8 = 0 sin derrapar).
    let h = atan2_8(Math.abs(this.v) * 4, this.v < 0 ? -this.latVel : this.latVel) << 16;
    if (h > 0x800000) h -= 0x1000000;
    h *= ((this.skid & 4 ? this.p.skidHeadK : this.p.headK) >> 8);
    if (this.skid & 1) h = h < 1 ? -0x3f0000 : 0x3f0000;
    if (this.v < 4000) h = Math.max(-0x180000, Math.min(0x180000, h));
    this.heading = h;

    // Inclinación visual (FUN_00438c70).
    let st = this.steer;
    if (this.v < 4000) st = trunc(st / 2);
    else if (this.v > 8000) st += st >> 3;
    this.roll = atan2_8(this.grip?.lean ?? 0x4a, st >> 8) << 16;
    if (this.roll > 0x800000) this.roll -= 0x1000000;
    return lost;
  }
}

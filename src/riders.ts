// Animación de pilotos con los datos del original (importer/riders.ts).
//
//   FUN_0043ae10  cambia de animación (reinicia fotograma y temporizador).
//   FUN_0043ae60  deja una animación pendiente para cuando acabe la actual.
//   FUN_0043ae90  avanza: al cumplirse la duración, tipo 0 → siguiente fotograma; 1 → bucle a (sig >> 4)
//                 si no hay pendiente; otro → pasa a la pendiente o reinicia.
//   FUN_0043af60  índice de ángulo con el ángulo de vista (24 bits) y el divisor +8; índice de inclinación
//                 con la inclinación y el rango +7; forma = base + ángulo y fila = inclinación (o al revés).
//   FUN_0044ba40  escala 0x200: un píxel de baja resolución = 2 unidades (HIBOB es el doble de detalle).
//   FUN_00407f30  animación según la velocidad: < 300 parado (8), < 1800 acelerando (4), ≥ 9501 agachado (3),
//                 si no, normal (2).

export interface AnimFrame {
  shape: number;
  row: number;
  byLean: boolean;
  nLean: number;
  nAngle: number;
  leanRange: number;
  angleDiv: number;
  duration: number;
  next: number;
  hit: boolean; // fotograma que golpea (banderas & 0x600000, FUN_004096f0)
}
export interface RiderAnims {
  shapes: number[][];
  flags: number[][];
  hotspots: [number, number, number, number][];
  shadowHotspots: [number, number, number, number][];
  anims: AnimFrame[][];
}

/** Ids de animación (tabla 0x474bd8). */
export const Anim = {
  None: -1, Ride: 2, Tuck: 3, Accelerate: 4, Victory: 5, Taunt: 6, Stop: 8, Hit: 9,
  Fall: 35, Stand: 36, StandIdle: 37, Run: 38, MountL: 41, MountR: 42, BikeFall: 43, BikeDownL: 46, BikeDownR: 47,
} as const;
/** FUN_00407f30: solo estas se sustituyen por la de conducción según la velocidad. */
export const RIDING = new Set<number>([Anim.Ride, Anim.None, Anim.Stop, Anim.Tuck, Anim.Accelerate]);

export interface Pose {
  frame: number; // fotograma de HIBOB (base 0)
  mirror: boolean;
  hx: number; // anclaje en píxeles de HIBOB
  hy: number;
  sx: number; // anclaje de la sombra (HISHADOW, 'ANIM' 3): casi en su borde superior
  sy: number;
  /** Inclinación que dibuja la fila elegida (24 bits), o null si el fotograma no se elige por inclinación. */
  lean: number | null;
}

/**
 * Inclinación de una fila (FUN_0043af60, bits 11-15 de sus banderas; bit 4 = negativa): 0x55555 = 7,5°.
 * Las filas de la conducción dibujan ±7,5°, ±18,75° y ±37,5°.
 */
export function rowLean(u: number) {
  const bit = (b: number) => (u >>> b) & 1;
  const a = (bit(13) ? 0xaaaaa : 0) + (u & 0x8000) * 0x40 + (bit(12) ? 0x55555 : 0) + (bit(14) ? 0x155555 : 0) + (bit(11) ? 0x2aaaa : 0);
  return u & 0x10 ? -a : a;
}

export class RiderAnimator {
  private data: RiderAnims;
  anim: number = Anim.Ride;
  private pending = -1;
  index = 0;
  loops = 0; // +0x18: vueltas de una animación en bucle
  hold = false; // sin animación pendiente, quedarse en el último fotograma (moto tirada, piloto en el suelo)
  private timer = 0;
  constructor(data: RiderAnims) {
    this.data = data;
  }

  /** FUN_0043ae10 (vía FUN_0040ac70): cambia de animación desde el principio. */
  set(id: number) {
    if (id === this.anim || (id >= 0 && !this.data.anims[id]?.length)) return;
    this.anim = id;
    this.index = 0;
    this.timer = 0;
    this.loops = 0;
  }
  /** Si el conjunto trae esa animación (el del policía no tiene todas). */
  has(id: number) { return !!this.data.anims[id]?.length; }
  /** FUN_0043ae60 / FUN_0040aca0: animación para cuando acabe la actual (−1 = ninguna). */
  queue(id: number) { this.pending = id; }

  /** Fotograma actual (la −1 muestra la 0, como FUN_0043ae90). */
  get frame(): AnimFrame | undefined { return this.data.anims[Math.max(0, this.anim)]?.[this.index]; }

  /** FUN_0043ae90: un tick de 60 Hz. Al acabar pasa a la pendiente (o a −1). */
  tick() {
    const frames = this.data.anims[Math.max(0, this.anim)];
    const f = frames?.[this.index];
    if (!f) return;
    if (++this.timer < Math.max(1, f.duration)) return;
    this.timer = 0;
    const kind = f.next & 0xf;
    if (kind === 0) this.index = Math.min(this.index + 1, frames.length - 1);
    else if (kind === 1 && this.pending < 0) { this.index = f.next >> 4; this.loops++; }
    else if (this.hold && this.pending < 0) this.loops++;
    else {
      this.anim = this.pending;
      this.pending = -1;
      this.index = 0;
      this.loops = 0;
    }
  }

  /** FUN_0043af60: `view` = ángulo de vista relativo (24 bits, ±0x800000), `roll` = inclinación (24 bits). */
  pose(view: number, roll: number): Pose | null {
    const f = this.frame;
    if (!f) return null;
    const nA = f.nAngle;
    let ai = 0;
    if (f.angleDiv !== 0 && nA > 0) {
      if (f.angleDiv < 0xfa) {
        let t = Math.trunc(((nA & 0xfe) << 12) / f.angleDiv) * ((f.angleDiv * 0x100) / 2 + (view >> 8));
        t = (t >> 4) + 0x8000;
        ai = t >> 16;
      } else {
        ai = ((view + 0x800000) * nA) >> 24;
      }
      if (ai >= nA) ai = nA - 1;
      if (ai < 0) ai = 0;
    }
    let li = 0;
    if (f.byLean && f.nLean >= 2) {
      const step = Math.trunc((f.leanRange << 16) / f.nLean);
      li = Math.trunc((f.leanRange * 0x8000 + roll) / step);
      li = Math.max(0, Math.min(f.nLean - 1, li));
    }
    const shape = f.byLean ? f.shape + ai : f.shape;
    const row = f.row + (f.byLean ? li : ai);
    const frame = this.data.shapes[shape]?.[row];
    if (frame === undefined || frame < 0 || frame >= this.data.hotspots.length) return null;
    const [hx, hy] = this.data.hotspots[frame];
    const [sx, sy] = this.data.shadowHotspots?.[frame] ?? [hx, 0];
    const flags = this.data.flags[shape]?.[row] ?? 0;
    const mirror = (flags & 1) !== 0;
    const lean = f.byLean && f.nLean >= 2 ? rowLean(flags) : null;
    return { frame, mirror, hx: hx * 2, hy: hy * 2, sx: sx * 2, sy: sy * 2, lean };
  }
}

/** Animación del piloto según la velocidad (FUN_00407f30, jugador). */
export function rideAnim(v: number, force: number): number {
  if (v < 300) return Anim.Stop;
  if (v < 0x708 && force > 0x1e) return Anim.Accelerate;
  if (v >= 0x251d) return Anim.Tuck;
  return Anim.Ride;
}

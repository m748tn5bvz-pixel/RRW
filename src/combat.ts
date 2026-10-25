// Peleas en moto: port de ROADRASH.EXE.
//
//   FUN_00434660  teclado del jugador: Enter (bit 0x40) → ataque de tipo 3 (patada); Insert / 0 del
//                 teclado numérico (0x20) y Espacio (0x80) → ataque con el arma (+0x1C8); Espacio elige
//                 la variante (revés). Tabla de teclas 0x465fe8 / 0x465fb9 / 0x476c00.
//   FUN_004095d0  elige la animación: lado = rival a la derecha (lateral menor que el suyo) → 0x464518,
//                 si no 0x4644f8; índice = tipo + variante·4. Ids: puño 22/23 (24/25 revés), garrote
//                 16/17 (18/19), cadena 10/11 (12/13), patada 26/27.
//   FUN_004096f0  en el fotograma que golpea (banderas & 0x600000) comprueba el alcance (FUN_00409c10):
//                 mismo lado, |Δaltura| < 0x40, |Δlateral| < 5·0x1000 (garrote 7, cadena 8), |Δavance| < 0x3000.
//                 Golpe: daño (FUN_00409ad0), empuje lateral ±3000 a la víctima (±8000 más con patada) y
//                 ∓1000 al atacante, revés: −300/+300 de velocidad; la víctima no puede recibir otro golpe
//                 hasta (5 − nivel)·6 ticks; al azar (1/(6 − nivel)) repite el ataque.
//   FUN_00409ad0  fuerza = ficha+0x30 · aguante/aguante máx (≥ mitad); daño = 0x465a00[tipo]·fuerza >> 8;
//                 patada: además daño a la moto = daño/4 + 1.
//   FUN_004050c0  piloto: aguante (+0x38) −= 4·daño (mínimo la mitad del máximo), salud (+0x3C) −= 0x40·daño.
//   FUN_004051e0  moto (+0x2F0) −= daño a la moto. Salud o moto a 0 → caída (FUN_00403d60);
//                 si no, el golpeado pone la animación 9 (FUN_004052c0).
//   FUN_00407d40  recuperación: salud += 1 por tick hasta el aguante.
//   FUN_004092e0  la IA ataca si ninguno está en espera, el rival está a |Δavance + Δv/16| < alcance·16
//                 y |Δlateral| < alcance·0x2000 (alcance = bloque de IA +0x1D4), y rand & 0xFF < 0x465a10[nivel].
//   FUN_00409460  tipo de la IA: patada si rand % [+0x1D0] = 0; si no su arma, revés si rand % [+0x1D1] = 0.
//   Añadido del port: el golpeado pierde un 3 % de velocidad (puño o arma) o un 5 % (patada).

import type { Bike } from "./bike.ts";
import { Anim, type RiderAnimator } from "./riders.ts";

const ATTACK_LEFT = [[0x16, 0x10, 0x0a, 0x1a], [0x18, 0x12, 0x0c, 0x1a]]; // 0x4644f8, 0x464508
const ATTACK_RIGHT = [[0x17, 0x11, 0x0b, 0x1b], [0x19, 0x13, 0x0d, 0x1b]]; // 0x464518, 0x464528
const ATTACKS = new Set([...ATTACK_LEFT.flat(), ...ATTACK_RIGHT.flat()]);
const RIGHT = new Set(ATTACK_RIGHT.flat());
const BACKHAND = new Set([...ATTACK_LEFT[1], ...ATTACK_RIGHT[1]].filter((id) => id !== 0x1a && id !== 0x1b));
const REACH = [5, 7, 8, 5]; // FUN_00409c10: ×0x1000 de lateral según el tipo

export const KICK = 3;

export interface FightData {
  attackDamage: number[];
  aggression: number[];
}

export class Fighter {
  weapon: number; // +0x1C8
  type = 0; // +0x1D4
  strength: number; // ficha +0x30
  staminaMax: number; // ficha +0x34
  stamina: number; // ficha +0x38
  health: number; // ficha +0x3C
  bikeMax: number; // +0x2EC
  bikeHealth: number; // +0x2F0
  guardUntil = 0; // +0x1D0
  constructor(weapon: number, strength: number, stamina: number, bikeMax: number) {
    this.weapon = weapon;
    this.strength = strength;
    this.staminaMax = this.stamina = this.health = stamina;
    this.bikeMax = this.bikeHealth = bikeMax;
  }
  /** FUN_00407d40: la salud se recupera 1 por tick hasta el aguante. */
  recover() { if (this.health < this.stamina) this.health = Math.min(this.stamina, this.health + 1); }
  /** Barras del tablero (FUN_00446b00 / FUN_00446b40): 0-31. */
  get healthBar() { return this.health ? 1 + Math.trunc(((this.health * 2 - 2) * 15) / (this.staminaMax - 1)) : 0; }
  get bikeBar() { return this.bikeHealth ? 1 + Math.trunc(((this.bikeHealth * 2 - 2) * 15) / (this.bikeMax - 1)) : 0; }
}

export interface Combatant {
  bike: Bike;
  anim: RiderAnimator;
  fight: Fighter;
  down: boolean; // en el suelo (sin moto)
}

export const isAttacking = (c: Combatant) => ATTACKS.has(c.anim.anim);

/** FUN_004095d0: empieza un ataque contra `target` (o hacia donde gira si no hay nadie cerca). */
export function startAttack(c: Combatant, target: Combatant | null, type: number, backhand: boolean) {
  if (c.down || isAttacking(c) || c.anim.anim === Anim.Hit) return;
  c.fight.type = type;
  const right = target ? c.bike.lat < target.bike.lat : c.bike.latVel >= 0;
  c.anim.set((right ? ATTACK_RIGHT : ATTACK_LEFT)[backhand ? 1 : 0][type]);
}

/** FUN_00409c10 */
function inReach(a: Combatant, b: Combatant) {
  const right = a.bike.lat < b.bike.lat;
  if (right !== RIGHT.has(a.anim.anim)) return false;
  if (Math.abs(a.bike.pos - b.bike.pos) >= 0x40) return false; // avance (unidades)
  return Math.abs(a.bike.lat - b.bike.lat) < REACH[a.fight.type] * 0x1000;
}

/** Rival más cercano en la carretera (FUN_00409400: hasta 0x1E0 unidades). */
export function nearest(c: Combatant, all: Combatant[]) {
  let best: Combatant | null = null, d = 0x1e0;
  for (const o of all) {
    if (o === c || o.down) continue;
    const dz = Math.abs(o.bike.pos - c.bike.pos);
    if (dz < d) { d = dz; best = o; }
  }
  return best;
}

export interface HitEvent { attacker: Combatant; victim: Combatant; type: number; knockedOut: boolean }

/** FUN_004096f0: resuelve el golpe en el fotograma activo. `tick` = contador de ticks de la carrera. */
export function resolveAttack(c: Combatant, all: Combatant[], tick: number, level: number, data: FightData): HitEvent | null {
  if (!isAttacking(c) || c.down) return null;
  const f = c.anim.frame;
  if (!f || !(f.hit || c.anim.index === 2)) return null;
  const v = nearest(c, all);
  if (!v || v.anim.anim === Anim.Hit || tick < v.fight.guardUntil || !inReach(c, v)) return null;
  const type = c.fight.type, right = RIGHT.has(c.anim.anim);
  // FUN_00409ad0
  const a = c.fight;
  const st = Math.max(Math.trunc(a.strength / 2), (Math.trunc((a.stamina << 8) / a.staminaMax) * a.strength) >> 8);
  const dmg = (data.attackDamage[type] * st) >> 8;
  const bikeDmg = type === KICK ? (dmg >> 2) + 1 : 0;
  // FUN_004050c0 / FUN_004051e0
  const vf = v.fight;
  vf.stamina = Math.max(Math.trunc(vf.staminaMax / 2), vf.stamina - dmg * 4);
  vf.health = Math.max(0, vf.health - dmg * 0x40);
  vf.bikeHealth = Math.max(0, vf.bikeHealth - bikeDmg);
  vf.guardUntil = tick + (5 - level) * 6;
  const knockedOut = vf.health === 0 || vf.bikeHealth === 0;
  if (!knockedOut && type !== KICK) v.anim.set(Anim.Hit);
  // Empujes laterales (+0x288) y, con el revés, intercambio de velocidad (FUN_00409bd0).
  const lim = v.bike.p.steerMax;
  v.bike.steer = Math.max(-lim, Math.min(lim, v.bike.steer + (right ? 3000 : -3000) + (type === KICK ? (right ? 8000 : -8000) : 0)));
  c.bike.steer = Math.max(-c.bike.p.steerMax, Math.min(c.bike.p.steerMax, c.bike.steer + (right ? -1000 : 1000)));
  if (BACKHAND.has(c.anim.anim)) { v.bike.v = Math.max(0, v.bike.v - 300); c.bike.v += 300; }
  // Del port (no del original): quien recibe el golpe pierde un 3 % de velocidad (un 5 % con la patada).
  v.bike.v = Math.trunc(v.bike.v * (type === KICK ? 0.95 : 0.97));
  if (Math.floor(Math.random() * (6 - level)) === 0) c.anim.queue(c.anim.anim);
  return { attacker: c, victim: v, type, knockedOut };
}

/** FUN_004092e0 + FUN_00409460: decisión de ataque de la IA. */
export function aiWantsAttack(c: Combatant, target: Combatant, tick: number, level: number, reach: number, data: FightData) {
  if (c.down || target.down || isAttacking(c) || tick < c.fight.guardUntil || tick < target.fight.guardUntil) return false;
  if (Math.abs(((c.bike.v - target.bike.v) >> 4) + c.bike.pos - target.bike.pos) >= reach * 16) return false;
  if (Math.abs(c.bike.lat - target.bike.lat) >= reach * 0x2000) return false;
  return (Math.random() * 256) < data.aggression[level];
}

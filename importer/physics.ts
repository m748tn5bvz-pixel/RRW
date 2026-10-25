// Datos de física y sonido que el motor web necesita, leídos de la instalación del usuario.
//
//   BIKESPEC.RSC 'SPEC' ×15 (FUN_00405e30 / FUN_00405ea0): [0] byte, [1..5] → +0x168/+0x16C/+0x170/+0x1B4/+0x1B8,
//                [6] peso de la moto, [7..82] → +0x1C4.. del objeto moto (marchas, potencia, freno, dirección).
//   0x463c78     fichas de corredores (0x40 B): +0xC peso (FUN_00405990 pasa la mitad a FUN_00405ea0).
//   0x4642a0     potencia de la IA por nivel, en % (FUN_00405990).
//   0x476768     tabla de arcotangente de FUN_0044f720 (257 B, 0x100 = 90°).
//   0x46dce4     arrastre por superficie (FUN_004390c0): asfalto, arcén, tierra, fuera de pista.
//   FUN_00435e60 sonidos de AUDIO/EFFECTS; el motor del jugador depende de la moto (Rat/Sport/Super).
//   0x464558     bloques de IA (0x204 B por corredor); 0x4659d4 ajuste de ritmo cerca del jugador.
//   Carrera y combate:
//   0x463c78     ficha: +0x18 + nivel·4 arma (0 puño, 1 garrote, 2 cadena), +0x30 fuerza, +0x34 aguante
//                (FUN_00405c80, FUN_00409ad0, FUN_004050c0).
//   0x4641c8     moto de cada corredor por nivel: [nivel + corredor·5] (FUN_00405990).
//   0x464218     parrilla del jugador; 0x464088 (niveles 1-4) y 0x464108 (nivel 5) la de los rivales
//                (FUN_00405600): [lateral en 1/256, (paso & 0x7F) << 8].
//   0x465a00     daño base por tipo de ataque (puño, garrote, cadena, patada) (FUN_00409ad0).
//   0x465a10     agresividad de la IA por nivel (FUN_004092e0).
//   0x464410     nombres del policía (FUN_00406b80); su ficha es la 15 y su bloque de IA el 9 (FUN_00407990).
//   0x46dcd8…    agarre y derrape (FUN_00438c70): x de la inclinación, agarre, deslizamiento, pérdida y bamboleo.
//   Bloque de IA +0x174 actitud (FUN_00408ad0), +0x1D0/+0x1D1 probabilidad de patada / revés
//                (FUN_00409460), +0x1D4 alcance para atacar (FUN_004092e0).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseResourceFile } from "./rsrc.ts";
import { vaToFileOffset } from "./exe.ts";
import { readStringTable } from "./strings.ts";

export interface PhysicsData {
  bikes: number[][]; // SPEC en i32
  riderWeights: number[];
  aiPower: number[];
  atan: number[];
  surfaceDrag: number[];
  engines: Record<string, number>; // nombre → frecuencia de muestreo del WAV
  aiCruise: number[][]; // [corredor 0-9][nivel 0-4], mph (bloques de IA, +0x1BC)
  aiRubber: number[]; // % extra según pasos de ventaja sobre el jugador, de −9 a +10 (DAT_004659d4)
  riders: { weapon: number[]; strength: number; stamina: number }[]; // fichas 0-15
  bikesByLevel: number[][]; // [corredor][nivel] → ficha de BIKESPEC
  grid: { player: [number, number]; rivals: [number, number][]; rivalsLast: [number, number][] }; // [lateral, paso]
  attackDamage: number[];
  aggression: number[];
  aiFight: { attitude: number; kickOdds: number; backOdds: number; reach: number }[]; // bloques 0-9
  names: string[]; // corredores 0-8: cadena 0x464188[r] de la DLL de idioma (FUN_00446bf0)
  copNames: string[]; // 0x464410 (Ortega, Marshall…)
  courseMiles: number[][]; // 0x468f58: [circuito 1-5][nivel], décimas de milla (FUN_00420810)
  grip: { lean: number; grip: number[]; slideK: number[]; slideD: number[]; slipLoss: number[]; wobble: number[][] };
}

function wavRate(file: string) {
  const b = readFileSync(file);
  return b.readUInt32LE(24);
}

export function exportPhysics(game: string): PhysicsData {
  const exe = new Uint8Array(readFileSync(join(game, "ROADRASH.EXE")));
  const ev = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  const at = (va: number) => vaToFileOffset(exe, va);
  const spec = parseResourceFile(new Uint8Array(readFileSync(join(game, "DATA", "BIKESPEC.RSC"))));
  const bikes = spec.entries
    .filter((e) => e.type === "SPEC")
    .sort((a, b) => a.id - b.id)
    .map((e) => {
      const v = new DataView(spec.data.buffer, spec.data.byteOffset + e.offset, e.size);
      return Array.from({ length: e.size / 4 }, (_, i) => v.getInt32(i * 4, true));
    });
  const riderWeights = Array.from({ length: 16 }, (_, i) => ev.getInt32(at(0x463c78 + i * 0x40 + 0xc), true));
  const aiPower = Array.from({ length: 5 }, (_, i) => ev.getInt32(at(0x4642a0 + i * 4), true));
  const atan = Array.from(exe.subarray(at(0x476768), at(0x476768) + 257));
  const surfaceDrag = Array.from(exe.subarray(at(0x46dce4), at(0x46dce4) + 4), (b) => (b << 24) >> 24);
  const engines: Record<string, number> = {};
  for (const n of ["ENGRAT", "ENGSPORT", "ENGSUPER", "ENGOTHER", "ENGCAR11", "SIREN", "SIRENFST"]) engines[n] = wavRate(join(game, "AUDIO", "EFFECTS", `${n}.WAV`));
  // FUN_004078f0 copia 10 bloques de IA de 0x204 B desde 0x464558; FUN_004082f0 toma +0x1BC + nivel·4.
  const aiCruise = Array.from({ length: 10 }, (_, r) =>
    Array.from({ length: 5 }, (_, l) => ev.getInt32(at(0x464558 + r * 0x204 + 0x1bc + l * 4), true)),
  );
  const aiRubber = Array.from({ length: 20 }, (_, k) => ev.getInt32(at(0x4659d4 + (k - 9) * 4), true));
  const i32 = (va: number) => ev.getInt32(at(va), true);
  const riders = Array.from({ length: 16 }, (_, r) => {
    const f = 0x463c78 + r * 0x40;
    return { weapon: Array.from({ length: 5 }, (_, l) => i32(f + 0x18 + l * 4)), strength: i32(f + 0x30), stamina: i32(f + 0x34) };
  });
  const bikesByLevel = Array.from({ length: 16 }, (_, r) => Array.from({ length: 5 }, (_, l) => exe[at(0x4641c8) + l + r * 5]));
  const gridEntry = (va: number): [number, number] => [i32(va), (i32(va + 4) >> 8) & 0x7f];
  const grid = {
    player: gridEntry(0x464218),
    rivals: Array.from({ length: 16 }, (_, k) => gridEntry(0x464088 + k * 8)),
    rivalsLast: Array.from({ length: 16 }, (_, k) => gridEntry(0x464108 + k * 8)),
  };
  const attackDamage = Array.from({ length: 4 }, (_, k) => i32(0x465a00 + k * 4));
  const aggression = Array.from({ length: 5 }, (_, l) => i32(0x465a10 + l * 4));
  const aiFight = Array.from({ length: 10 }, (_, r) => {
    const b = 0x464558 + r * 0x204;
    return { attitude: i32(b + 0x174), kickOdds: exe[at(b + 0x1d0)], backOdds: exe[at(b + 0x1d1)], reach: i32(b + 0x1d4) };
  });
  const lang = ["ESP", "ENU"].map((l) => join(game, "TEXT", `${l}.DLL`)).find((p) => existsSync(p));
  const table = lang ? readStringTable(new Uint8Array(readFileSync(lang))) : new Map<number, string>();
  const names = Array.from({ length: 9 }, (_, r) => table.get(i32(0x464188 + r * 4)) ?? "");
  // FUN_00406b80: nombre del policía = cadena 0x464410[DAT_004642e0], que da la vuelta tras 8.
  const copNames = Array.from({ length: 8 }, (_, k) => table.get(i32(0x464410 + k * 4)) ?? "");
  // FUN_00420810: distancia de cada circuito (1-5) por nivel, en décimas de milla.
  const courseMiles = Array.from({ length: 5 }, (_, c) => Array.from({ length: 5 }, (_, l) => i32(0x468f58 + (c * 5 + l) * 4)));
  // FUN_00438c70: agarre y derrape por superficie (asfalto, arcén, tierra, fuera de pista).
  const row = (va: number, n = 4) => Array.from({ length: n }, (_, k) => i32(va + k * 4));
  const grip = {
    lean: i32(0x46dcd8), // x de atan2 para la inclinación (0x4A)
    grip: row(0x46dce8),
    slideK: row(0x46dcf8),
    slideD: row(0x46dd08),
    slipLoss: row(0x46dd18),
    wobble: Array.from({ length: 8 }, (_, r) => row(0x46dd28 + r * 16)), // [paso & 7][superficie]
  };
  return { bikes, riderWeights, aiPower, atan, surfaceDrag, engines, aiCruise, aiRubber, riders, bikesByLevel, grid, attackDamage, aggression, aiFight, names, copNames, courseMiles, grip };
}

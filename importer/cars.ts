// Coches del tráfico (DATA/CARS/<circuito>.CAR): un modelo por 'ANIM' (RRAN con un nivel por fotograma)
// y sus formas 'CANS'.
//
// Evidencia en ROADRASH.EXE:
//   FUN_004465f0  carga "Data/Cars/<circuito>.CAR" (o "Data/Cars/Hi…" en alta resolución, si existe); por
//                 modelo k (hasta 15): 'ANIM' k + 1 (RRAN → FUN_0044a200; OFSS → FUN_0044a1d0) y el siguiente
//                 'CANS' (si no quedan, el del modelo anterior). Tres animaciones de un fotograma con las
//                 plantillas 0x474da0 'Cars', 0x474da8 'Car1' y 0x474db0 'Car2' (FUN_0040b6a0); banderas
//                 del modelo = forma 0, fila 0 (FUN_0040b6f0 → DAT_004b8fe0[k]).
//   FUN_0044e710  la animación sale de la distancia a la cámara: > 0xA00 'Car2', > 0x500 'Car1', si no 'Cars'.
//   FUN_00446830  dibuja con escala 0x500 (pilotos: 0x200 → 2 unidades por píxel de baja resolución).

import { decodePdat, PDAT_MAGIC, type IndexedImage } from "./cel.ts";
import { vaToFileOffset } from "./exe.ts";
import { buildFrame, Cans, readShapes, type RiderAnims } from "./riders.ts";
import { getResource, type ResourceFile } from "./rsrc.ts";

const TEMPLATES = [0x474da0, 0x474da8, 0x474db0];
const RRAN = 0x5252414e;

export interface CarModel {
  flags: number; // forma 0, fila 0: 0x100000 mismo sentido, 0x80000 contrario, 0x40000 cruce (FUN_0044df60)
  base: number; // primer fotograma del modelo en el atlas del circuito
  anims: RiderAnims; // fotogramas relativos a `base`; anclajes de cada nivel del RRAN
}

function tryResource(file: ResourceFile, type: string, id: number) {
  try { return getResource(file, type, id); } catch { return null; }
}

/** Niveles de un RRAN: imagen (PDAT del nivel [1]) y anclaje [2] (FUN_0044a200). */
function rranLevels(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(0, true) !== RRAN) return [];
  const n = v.getUint32(v.getUint32(8, true) + 0x10, true);
  const out: { image: IndexedImage | null; hot: [number, number, number, number] }[] = [];
  for (let l = 0; l < n; l++) {
    const e = 0x1c + l * 0x1c;
    const pdat = v.getUint32(e + 4, true) + 8;
    const image = pdat + 0x40 <= b.length && v.getUint32(pdat, true) === PDAT_MAGIC ? decodePdat(b.subarray(pdat)) : null;
    const hot = v.getUint32(e + 8, true);
    out.push({ image, hot: [v.getInt32(hot, true), v.getInt32(hot + 4, true), v.getInt32(e + 0x14, true), v.getInt32(e + 0x18, true)] });
  }
  return out;
}

export function readCars(exe: Uint8Array, file: ResourceFile): { images: IndexedImage[]; models: CarModel[] } {
  const ev = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  const images: IndexedImage[] = [];
  const models: CarModel[] = [];
  let cans: Cans | null = null;
  let nextCans = 1;
  for (let k = 0; k < 15; k++) {
    const anim = tryResource(file, "ANIM", k + 1);
    if (!anim) break;
    const own = tryResource(file, "CANS", nextCans);
    if (own) { cans = new Cans(own); nextCans++; }
    if (!cans) break;
    const levels = rranLevels(anim);
    const base = images.length;
    for (const l of levels) images.push(l.image ?? { name: "", width: 0, height: 0, pixels: new Uint8Array(0), transparent: true });
    const { shapes, flags } = readShapes(cans);
    const anims = TEMPLATES.map((va) => {
      const o = vaToFileOffset(exe, va);
      const f = buildFrame(cans!, ev.getInt32(o, true), exe[o + 4], exe[o + 5]);
      return f ? [f] : [];
    });
    const hotspots = levels.map((l) => l.hot);
    models.push({ flags: cans.flag(0, 0), base, anims: { shapes, flags, hotspots, shadowHotspots: hotspots, anims } });
  }
  return { images, models };
}

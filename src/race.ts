// Carrera: salida, meta por nivel, puestos y resultado, con los datos y reglas de ROADRASH.EXE.
//
//   FUN_00405600  crea 15 corredores (jugador + 14) en la parrilla: jugador en 0x464218, rival k en
//                 0x464088[k] (0x464108 en el nivel 5): [lateral en 1/256 de unidad, paso].
//   FUN_00405990  ficha del corredor 0x463c78 + r·0x40; moto = 0x4641c8[nivel + r·5].
//   FUN_00454240  meta: sección RSEC de tipo 6 (FUN_00452690 guarda tipo + 1 = 7) con extra[0] = nivel + 1;
//                 marca el corte (+0x36 |= 0x20 → textura FINISH en FUN_0043c0b0).
//   FUN_00407410  distancia a la meta (+0x1F8); FUN_00437800 al llegar a 0: orden de llegada.
//   FUN_00407550  puesto = 1 + corredores con menos distancia a la meta.
//   FUN_00434660  tras la meta el jugador frena solo; parado (< 300) → FUN_00416010(0x7F, 180):
//                 puestos 1-3 ganan (estado 2), el resto pierde (3); 180 ticks después acaba la carrera.
//   FUN_00407f30  con la meta cruzada y puesto < 4 el piloto levanta el brazo (animación 5).
//   FUN_00416120  resultado → FUN_00449150: Win1-6, Lose1-10, Wreck1-6, Busted1-6 (vídeo al azar),
//                 o la imagen Results/Win%d, Lose%d… si no hay vídeo (FUN_0041d7d0).

import type { CourseJson } from "./road.ts";
import type { Track } from "./track.ts";

export type Outcome = "win" | "lose" | "wreck" | "busted";

interface SectionJson { start: number; end: number; type: number; extra: [number, number, number] }

/** Paso de la ruta donde está la meta del nivel (0-4), o el final de la ruta si esa meta no está en ella. */
export function finishStep(course: CourseJson, track: Track, level: number): number {
  const segs = course.segments as unknown as { sections?: SectionJson[] }[];
  let best = -1;
  for (let i = 0; i < track.steps.length; i++) {
    const s = track.steps[i];
    const sec = segs[s.segment]?.sections?.find((e) => e.type === 6 && e.extra[0] === level + 1 && e.start === s.step);
    if (sec) { best = i; break; }
  }
  return best >= 0 ? best : track.steps.length - 40;
}

/** Puesto de cada corredor: los que ya llegaron, por orden; el resto, por distancia a la meta (FUN_00407550). */
export function places(pos: number[], finishedOrder: number[]): number[] {
  const out = new Array(pos.length).fill(0);
  finishedOrder.forEach((r, k) => (out[r] = k + 1));
  const running = pos.map((p, r) => r).filter((r) => !finishedOrder.includes(r)).sort((a, b) => pos[b] - pos[a]);
  running.forEach((r, k) => (out[r] = finishedOrder.length + k + 1));
  return out;
}

/** Vídeo o imagen del resultado (FUN_00449150 / FUN_0041d7d0). */
export function resultMedia(outcome: Outcome, videos: string[], images: string[]) {
  const [name, n] = outcome === "win" ? ["win", 6] : outcome === "lose" ? ["lose", 10] : outcome === "busted" ? ["busted", 6] : ["wreck", 6];
  const k = 1 + Math.floor(Math.random() * n);
  const video = videos.find((u) => u.endsWith(`/video/${name}${k}.webm`));
  // Imágenes Results/Win%d, Lose%d, Wreck%d y Bust%d (FUN_0041d7d0).
  const file = name === "busted" ? "bust" : name;
  const image = images.find((u) => u.endsWith(`/images/results/${file}${1 + ((k - 1) % 6)}.jpg`));
  return { video, image };
}

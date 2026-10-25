// Bifurcaciones: la ruta que sigue el jugador y la otra rama, como el cursor doble de ROADRASH.EXE.
//
//   FUN_00453030  avanza el cursor de carretera. En una bifurcación (nodo tipo 1) pasa a estado doble con
//                 un subcursor por rama (+0x28 rama 0, +0x21C rama 1) que avanzan a la vez; la separación
//                 lateral entre ramas se integra dos veces: al entrar, +0x14 = curva₁ − curva₀ y +0x18 = 0;
//                 en cada paso, +0x18 += +0x14 y +0x14 += curva₁ − curva₀ (FUN_00451a40 da la curva).
//                 Pasados 0x51 pasos (+0x14 del nodo, FUN_00453b60) y con la rama ya elegida, FUN_00452fd0
//                 se queda con la elegida (estado simple). 0x51 pasos antes de una unión (nodo tipo 2) vuelve
//                 al estado doble con el estado precalculado hacia atrás desde la unión (FUN_00453b60 con
//                 sentido negativo), así que la otra rama reaparece y converge en la unión.
//   FUN_00453b60  precálculo al cargar: 0x50 pasos por las dos ramas; +0x410 = paso en que dejan de
//                 solaparse (arcenes + terreno).
//   FUN_00454c80  cada corte guarda las dos carreteras (+0x30 y +0x194) y la separación (+0x24/+0x28).
//   FUN_00443d70  dibuja las dos: la segunda con x + separación y dx + Δ, cada una con su curva y su
//                 pendiente desde el corte de la cámara (la altura se reparte desde ahí).
//   FUN_00439390  al cruzar un paso, si el corte siguiente tiene dos carreteras, la moto toma la rama 0 si
//                 su lateral está a la izquierda del borde derecho de esa rama (+0xE4), si no la 1; el
//                 jugador fija así la rama elegida (FUN_004540e0 → DAT_00476ce4).
//
// Aquí la ruta principal es la del jugador (`choices`) y la alternativa toma la otra rama en cada
// bifurcación. Todo lateral está en el sistema de la principal; la otra carretera de una zona doble se
// coloca con `shift` (separación + diferencia de desplazamientos) y `rise` (pendientes).

import type { CourseJson } from "./road.ts";
import { buildTrack, type Track } from "./track.ts";

/** Pasos en estado doble tras una bifurcación y antes de una unión (nodo +0x14 = 0x5100, FUN_00453b60). */
export const DUAL_STEPS = 0x51;

export interface Region {
  kind: "fork" | "merge";
  fork: number; // índice de la bifurcación en la ruta
  from: number; // índices de la ruta principal [from, to)
  to: number;
  alt: number; // índice de la ruta alternativa que corresponde a `from`
  shift: Float32Array; // centro de la otra carretera − su desplazamiento propio, en el sistema principal
  rise: Float32Array; // Σ (pendiente de la otra − pendiente de la principal)
}

export class Route {
  main!: Track;
  alt!: Track;
  regions: Region[] = [];
  choices: number[] = [];
  private course: CourseJson;

  constructor(course: CourseJson, choices: number[] = []) {
    this.course = course;
    this.rebuild(choices);
  }

  rebuild(choices: number[]) {
    this.choices = choices.slice();
    this.main = buildTrack(this.course, this.choices);
    this.alt = buildTrack(this.course, this.main.forks.map((f) => 1 - f.branch));
    this.regions = [];
    this.main.forks.forEach((f, k) => {
      const g = this.alt.forks[k];
      if (!g || f.merge < 0 || g.merge < 0) return;
      const n = Math.min(DUAL_STEPS, f.merge - f.start, g.merge - g.start);
      this.regions.push(this.region("fork", k, f.start, g.start, n));
      this.regions.push(this.region("merge", k, f.merge - n, g.merge - n, n));
    });
  }

  private region(kind: Region["kind"], fork: number, from: number, alt: number, n: number): Region {
    const m = this.main, a = this.alt;
    const diff = (k: number) => a.steps[alt + k].curve - m.steps[from + k].curve;
    const dslope = (k: number) => a.steps[alt + k].slope - m.steps[from + k].slope;
    const sep = new Float32Array(n), rise = new Float32Array(n);
    if (kind === "fork") {
      // Integración hacia delante desde la bifurcación (separación 0).
      let ds = diff(0);
      for (let k = 1; k < n; k++) {
        sep[k] = sep[k - 1] + ds;
        ds += diff(k);
        rise[k] = rise[k - 1] + dslope(k - 1);
      }
    } else {
      // Hacia atrás desde la unión (FUN_00453030 con avance negativo): separación 0 al unirse.
      let ds = 0;
      let r = 0;
      for (let k = n - 1; k >= 0; k--) {
        if (k < n - 1) {
          ds -= diff(k + 1);
          sep[k] = sep[k + 1] - ds;
        }
        r -= dslope(k);
        rise[k] = r;
      }
    }
    // Ancla: el paso anterior a la bifurcación o el primero tras la unión es la misma carretera en las dos.
    const base = kind === "fork"
      ? (from > 0 ? m.offset[from - 1] - a.offset[alt - 1] : 0)
      : m.offset[Math.min(from + n, m.offset.length - 1)] - a.offset[Math.min(alt + n, a.offset.length - 1)];
    const shift = sep.map((s) => s + base);
    return { kind, fork, from, to: from + n, alt, shift, rise };
  }

  /** Zona doble que contiene el paso `i` de la ruta principal. */
  regionAt(i: number): Region | null {
    for (const r of this.regions) if (i >= r.from && i < r.to) return r;
    return null;
  }

  /** Bifurcación que empieza en el paso `i`, si la hay. */
  forkAt(i: number): number {
    return this.main.forks.findIndex((f) => f.start === i);
  }
}

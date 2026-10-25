// Carretera de Road Rash tal como la construye el motor original (pseudo-3D, estilo OutRun).
//
// Observado en ROADRASH.EXE (Ghidra vía REA):
//   FUN_00443d70  arma la vista: parte del corte actual con dx = b0·(256−frac)/256, x = 0,
//                 y = −frac·b1/256, z = 256 − frac; al pasar al siguiente corte: dx += b0, slope = b1.
//   FUN_00444630  proyecta un corte y luego avanza: z += 256; x += dx; y += slope.
//   Bordes del corte: ±500 (asfalto, +0xE0/+0xE4) y ±650 (+0xE8/+0xEC); ver FUN_004551c0.
// No hay rotación ni mundo global: cada fotograma se reconstruye relativo a la cámara.

export interface CourseJson {
  name: string;
  root: number;
  nodes: Node[];
  segments: { index: number; length: number; curve: number[]; slope: number[]; blockTags: Record<string, string | null> }[];
}
type Node =
  | { kind: "start"; offset: number; next: number }
  | { kind: "end"; offset: number }
  | { kind: "run"; offset: number; segment: number; length: number; next: number; prev: number }
  | { kind: "fork" | "merge"; offset: number; links: [number, number, number] };

export interface Step {
  curve: number; // byte0
  slope: number; // byte1
  segment: number;
  step: number;
}

/** Bifurcación recorrida por una ruta: la rama tomada empieza en `start` y se une en `merge` (índices). */
export interface RouteFork {
  node: number; // offset del nodo de bifurcación
  branch: number; // 0 = enlace [2], 1 = enlace [3] (FUN_00453030: subcursores +0x28 y +0x21C)
  start: number;
  merge: number;
}

/**
 * Ruta lineal tomando en cada bifurcación la rama `choices[k]` (k = orden de aparición; por defecto 0,
 * el byte +0x19 del nodo en todos los circuitos).
 */
export function flattenRoute(course: CourseJson, choices: readonly number[] = []): { steps: Step[]; forks: RouteFork[] } {
  const byOffset = new Map(course.nodes.map((n) => [n.offset, n]));
  const steps: Step[] = [];
  const forks: RouteFork[] = [];
  const visited = new Set<number>();
  let off: number | undefined = course.root;
  while (off !== undefined && !visited.has(off)) {
    visited.add(off);
    const n = byOffset.get(off);
    if (!n) break;
    if (n.kind === "run") {
      const s = course.segments[n.segment];
      for (let i = 0; i < s.length; i++) steps.push({ curve: s.curve[i], slope: s.slope[i], segment: n.segment, step: i });
      off = n.next;
    } else if (n.kind === "fork") {
      const branch = choices[forks.length] ?? 0;
      forks.push({ node: n.offset, branch, start: steps.length, merge: -1 });
      off = n.links[branch];
    } else if (n.kind === "merge") {
      const f = forks.findLast((k) => k.merge < 0);
      if (f) f.merge = steps.length;
      off = n.links[2];
    } else break;
  }
  return { steps, forks };
}

/** Ruta principal (primera rama en cada bifurcación) como lista lineal de pasos. */
export function flattenMainRoute(course: CourseJson): Step[] {
  return flattenRoute(course).steps;
}

export interface ViewSlice {
  x: number; // unidades del juego, relativas a la cámara
  y: number;
  z: number;
  index: number; // índice en la ruta (para colores/bandas)
}

/**
 * Reproduce FUN_00443d70 + FUN_00444630: cortes visibles desde la posición `t` (en pasos, fraccional).
 * `count` como máximo 128 en el original (búfer circular DAT_0049e820).
 */
export function buildView(steps: Step[], t: number, count: number, out: ViewSlice[]): ViewSlice[] {
  out.length = 0;
  const i0 = Math.floor(t);
  const frac = Math.round((t - i0) * 256);
  const first = steps[i0];
  if (!first) return out;
  let dx = (first.curve * (256 - frac)) / 256;
  let slope = first.slope;
  let x = 0;
  let y = -(frac * slope) / 256;
  let z = 256 - frac;
  // El original empieza en z = 256 − frac (debajo va la moto). Para una cámara libre
  // se añade un corte por detrás que tapa el suelo bajo la cámara; no viene de los datos.
  out.push({ x: 0, y, z: z - 1024, index: i0 });
  for (let k = 0; k < count; k++) {
    const idx = i0 + k;
    if (idx >= steps.length) break;
    out.push({ x, y, z, index: idx });
    // FUN_00444630: avance tras proyectar el corte
    z += 256;
    x += dx;
    y += slope;
    // FUN_00443d70: siguiente corte
    const next = steps[idx + 1];
    if (!next) break;
    dx += next.curve;
    slope = next.slope;
  }
  return out;
}

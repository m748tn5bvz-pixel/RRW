// Importador: lee TU instalación de Road Rash y genera assets/ para el motor web.
// Nada de assets/ se publica (.gitignore).
//
// Uso:
//   npm run import -- "C:\Program Files (x86)\MagiPacks\Road Rash" [--videos | --videos=carrera]
//
// --videos convierte los AVI Cinepak a WebM (VP9/Opus) con ffmpeg; tarda varios minutos.
// --videos=carrera solo convierte los que usa el port: final de carrera (Win/Lose/Wreck/Busted, FUN_00449150),
// salida (Start, FUN_004213c0 → FUN_004023e0) e Intro (menú).

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, relative, extname, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { parseResourceFile } from "./rsrc.ts";
import { parseCourse, type CourseNode } from "./course.ts";
import { parseFamilyLoads, parseLanes, parseRoadsideObjects, parseSections, parseShoulders, parseTerrain } from "./blocks.ts";
import { exportSprites, type SpriteManifest } from "./sprites.ts";
import { exportPhysics } from "./physics.ts";
import { readStringTable } from "./strings.ts";

const args = process.argv.slice(2);
const gameDir = args.find((a) => !a.startsWith("--"));
const withVideos = args.includes("--videos") || args.includes("--videos=carrera");
const raceVideosOnly = args.includes("--videos=carrera");
const RACE_VIDEO = /^((win|lose|wreck|busted|start)\d+|intro)\.avi$/i;
if (!gameDir || !existsSync(join(gameDir, "ROADRASH.EXE"))) {
  console.error('Uso: npm run import -- "<carpeta de Road Rash con ROADRASH.EXE>" [--videos]');
  process.exit(1);
}
const outDir = join(import.meta.dirname, "..", "assets");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Ruta de salida en minúsculas, conservando la estructura de carpetas del juego. */
function outPath(src: string, newExt: string) {
  const rel = relative(gameDir!, src).toLowerCase();
  const target = join(outDir, rel.slice(0, rel.length - extname(rel).length) + newExt);
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

// Circuito → horizonte y nombre en el juego (tablas PTR_DAT_0046df58 y PTR_DAT_00467aa0 de ROADRASH.EXE).
const COURSE_INFO: Record<string, { title: string; horizon: string }> = {
  CITY: { title: "The City", horizon: "CITY" },
  HIWAY: { title: "Sierra Nevada", horizon: "SIERRA" },
  MEDLY: { title: "The Peninsula", horizon: "PENIN" },
  NAPA: { title: "Napa Valley", horizon: "NAPA" },
  CANYN: { title: "Pacific Coast Highway", horizon: "PCH" },
};

const manifest: {
  generatedAt: string;
  courses: { name: string; title: string; horizon: string; file: string; segments: number; steps: number }[];
  sprites?: SpriteManifest;
  physics?: string;
  images: string[];
  audio: string[];
  music: string[];
  soundfonts: string[];
  videos: string[];
  font?: string;
  menuFonts?: Record<string, string>;
  strings?: string;
  pending: { file: string; reason: string }[];
} = { generatedAt: new Date().toISOString(), courses: [], images: [], audio: [], music: [], soundfonts: [], videos: [], pending: [] };

const url = (p: string) => "/" + relative(outDir, p).replaceAll("\\", "/");
const files = walk(gameDir);

// --- Circuitos -------------------------------------------------------------
for (const src of files.filter((f) => extname(f).toUpperCase() === ".CRS")) {
  const course = parseCourse(parseResourceFile(new Uint8Array(readFileSync(src))));
  const nodes = [...course.nodes.values()].map((n: CourseNode) => n);
  const json = {
    name: basename(src, extname(src)).toUpperCase(),
    root: course.root,
    nodes,
    segments: course.segments.map((s) => ({
      index: s.index,
      length: s.path.length,
      startHeight: s.path.startHeight,
      endHeight: s.path.endHeight,
      curve: Array.from(s.path.curve),
      slope: Array.from(s.path.slope),
      lanes: s.blocks.lanes ? parseLanes(s.blocks.lanes.bytes) : [],
      shoulders: s.blocks.slide ? parseShoulders(s.blocks.slide.bytes) : [],
      sections: s.blocks.sections ? parseSections(s.blocks.sections.bytes) : [],
      terrain: s.blocks.terrain ? parseTerrain(s.blocks.terrain.bytes, s.path.length) : null,
      objects: s.blocks.objects ? parseRoadsideObjects(s.blocks.objects.bytes) : [],
      famLoads: s.blocks.sprites ? parseFamilyLoads(s.blocks.sprites.bytes) : [],
      // Etiqueta de cada bloque (RHZD y otros siguen sin decodificar).
      blockTags: Object.fromEntries(Object.entries(s.blocks).map(([k, b]) => [k, b?.tag ?? null])),
    })),
  };
  const target = outPath(src, ".json");
  writeFileSync(target, JSON.stringify(json));
  const steps = course.segments.reduce((n, s) => n + s.path.length, 0);
  const info = COURSE_INFO[json.name] ?? { title: json.name, horizon: "SIERRA" };
  manifest.courses.push({ name: json.name, ...info, file: url(target), segments: course.segments.length, steps });
  console.log(`circuito ${json.name}: ${course.segments.length} segmentos, ${steps} pasos`);
}

// --- Formatos estándar (solo se copian con la extensión correcta) ----------
const magic = (f: string) => readFileSync(f).subarray(0, 12);
for (const src of files) {
  const ext = extname(src).toUpperCase();
  const head = magic(src);
  const ascii = (o: number, n: number) => String.fromCharCode(...head.subarray(o, o + n));
  if (ext === ".RRI" && head[0] === 0xff && head[1] === 0xd8) {
    const t = outPath(src, ".jpg"); copyFileSync(src, t); manifest.images.push(url(t));
  } else if ((ext === ".RRA" || ext === ".WAV") && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") {
    const t = outPath(src, ".wav"); copyFileSync(src, t); manifest.audio.push(url(t));
  } else if (ext === ".SBK" && ascii(0, 4) === "RIFF" && ascii(8, 4) === "sfbk") {
    const t = outPath(src, ".sf2"); copyFileSync(src, t); manifest.soundfonts.push(url(t));
  } else if (ext === ".MID") {
    const t = outPath(src, ".mid"); copyFileSync(src, t); manifest.music.push(url(t));
  } else if (ext === ".AVI") {
    const t = outPath(src, ".webm");
    if (!withVideos || (raceVideosOnly && !RACE_VIDEO.test(basename(src)))) {
      if (existsSync(t)) manifest.videos.push(url(t));
      continue;
    }
    if (!existsSync(t)) {
      console.log(`video ${basename(src)} → webm…`);
      const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", t], { stdio: "inherit" });
      if (r.status !== 0) { manifest.pending.push({ file: relative(gameDir, src), reason: "ffmpeg falló" }); continue; }
    }
    manifest.videos.push(url(t));
  }
}

// --- Fuente del HUD: TEXT/BADLOC.DLL es una TrueType ("Badloc", FUN_00442990 la carga con CreateFontA).
const badloc = join(gameDir, "TEXT", "BADLOC.DLL");
if (existsSync(badloc) && readFileSync(badloc).readUInt32BE(0) === 0x00010000) {
  mkdirSync(join(outDir, "fonts"), { recursive: true });
  copyFileSync(badloc, join(outDir, "fonts", "badloc.ttf"));
  manifest.font = "/fonts/badloc.ttf";
}
// Menús (fuentes de CreateFontA en la creación de la ventana del menú, 0x4239ed…): Badloc para los títulos y
// "Futura Condensed" Regular/Bold/Demi (TEXT/FUTR, FUTB, FUTD.DLL, también TrueType) para botones y textos.
manifest.menuFonts = {};
for (const [name, file] of [["regular", "FUTR"], ["bold", "FUTB"], ["demi", "FUTD"]] as const) {
  const src = join(gameDir, "TEXT", `${file}.DLL`);
  if (!existsSync(src) || readFileSync(src).readUInt32BE(0) !== 0x00010000) continue;
  mkdirSync(join(outDir, "fonts"), { recursive: true });
  copyFileSync(src, join(outDir, "fonts", `futura-${name}.ttf`));
  manifest.menuFonts[name] = `/fonts/futura-${name}.ttf`;
}

// --- Arte original: pilotos, familias de objetos, texturas, coches, horizontes, tableros -----
manifest.sprites = exportSprites(gameDir, outDir, (s) => console.log(s));
mkdirSync(join(outDir, "data"), { recursive: true });
writeFileSync(join(outDir, "data", "physics.json"), JSON.stringify(exportPhysics(gameDir)));
manifest.physics = "/data/physics.json";
// Textos de los menús y resultados: la tabla de cadenas de la DLL de idioma (español si está, si no inglés).
const langDll = ["ESP", "ENU"].map((l) => join(gameDir, "TEXT", `${l}.DLL`)).find((p) => existsSync(p));
if (langDll) {
  writeFileSync(join(outDir, "data", "strings.json"), JSON.stringify(Object.fromEntries(readStringTable(new Uint8Array(readFileSync(langDll))))));
  manifest.strings = "/data/strings.json";
}
// Pendiente: TEMPLATE.MIP y los recursos ANIM/CANS sin PDAT del port.
manifest.pending.push({ file: "DATA/BIKERS/TEMPLATE.MIP", reason: "uso aún desconocido" });

writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(
  `\nlisto → ${outDir}\n  circuitos: ${manifest.courses.length}  imágenes: ${manifest.images.length}  audio: ${manifest.audio.length}` +
    `  midi: ${manifest.music.length}  soundfonts: ${manifest.soundfonts.length}  videos: ${manifest.videos.length}` +
    `  pendientes: ${manifest.pending.length}`,
);

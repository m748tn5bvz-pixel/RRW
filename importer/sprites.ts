// Exportación del arte original (pixel art de 8 bits) a atlas PNG + JSON para el motor web.
// Formatos y evidencia en importer/cel.ts y docs/FORMATS.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getResource, parseResourceFile } from "./rsrc.ts";
import { readCars } from "./cars.ts";
import { readRiderAnims } from "./riders.ts";
import { explode } from "./dcl.ts";
import { decodeBikerFrames, readPalette, scanPdats, type IndexedImage } from "./cel.ts";
import { readRiderRemaps, RIDER_COUNT } from "./exe.ts";
import { familyObjects, familySidewalks, familyTerrain, familyTerrainHeights } from "./fam.ts";
import { encodePng } from "./png.ts";

export interface AtlasFrame {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Empaquetado por estantes (alto descendente), ancho máximo fijo. */
function pack(images: IndexedImage[], maxWidth = 2048) {
  const order = images.map((im, i) => i).sort((a, b) => images[b].height - images[a].height);
  const frames: AtlasFrame[] = new Array(images.length);
  let x = 1, y = 1, shelf = 0, width = 1;
  for (const i of order) {
    const im = images[i];
    if (x + im.width + 1 > maxWidth) { x = 1; y += shelf + 1; shelf = 0; }
    frames[i] = { name: im.name, x, y, w: im.width, h: im.height };
    x += im.width + 1;
    shelf = Math.max(shelf, im.height);
    width = Math.max(width, x);
  }
  return { frames, width, height: y + shelf + 1 };
}

function render(images: IndexedImage[], layout: ReturnType<typeof pack>, palette: Uint8Array, remap?: Uint8Array) {
  const { width, height, frames } = layout;
  const rgba = new Uint8Array(width * height * 4);
  images.forEach((im, k) => {
    const f = frames[k];
    for (let y = 0; y < im.height; y++)
      for (let x = 0; x < im.width; x++) {
        let c = im.pixels[y * im.width + x];
        if (im.transparent && c === 0) continue;
        if (remap) c = remap[c];
        rgba.set(palette.subarray(c * 4, c * 4 + 4), ((f.y + y) * width + f.x + x) * 4);
      }
  });
  return encodePng(width, height, rgba);
}

function writeAtlas(dir: string, base: string, images: IndexedImage[], palette: Uint8Array) {
  const layout = pack(images);
  writeFileSync(join(dir, `${base}.png`), render(images, layout, palette));
  writeFileSync(join(dir, `${base}.json`), JSON.stringify({ width: layout.width, height: layout.height, frames: layout.frames }));
  return layout;
}

/** Imagen .BOB cruda (8 bits, sin cabecera). `keyed`: índice 0 transparente (azul clave). */
function writeBob(src: string, dst: string, width: number, palette: Uint8Array, keyed: boolean) {
  const data = new Uint8Array(readFileSync(src));
  const height = Math.floor(data.length / width);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (keyed && data[i] === 0) continue;
    rgba.set(palette.subarray(data[i] * 4, data[i] * 4 + 4), i * 4);
  }
  writeFileSync(dst, encodePng(width, height, rgba));
  return { width, height };
}

export interface SpriteManifest {
  riders: { frames: string; textures: string[]; shadow: string; cop: string; copShadow: string; anims: string; copAnims: string };
  families: Record<string, { atlas: string; objects: number; terrain: (string | null)[][]; heights?: number[]; sidewalk?: (string | null)[][] }>;
  /** Color del tejado de los edificios: índice 0xFD de la paleta (FUN_0040c930 → FUN_0044fd00(…, 0xFD)). */
  roof?: string;
  global: Record<string, string>;
  cars: Record<string, string>;
  horizons: Record<string, string>;
  dashboards: Record<string, string>;
  meter: string;
  clouds: string[];
}

export function exportSprites(game: string, outDir: string, log: (s: string) => void): SpriteManifest {
  const rel = (p: string) => "/" + p.replaceAll("\\", "/");
  const palette = readPalette(new Uint8Array(readFileSync(join(game, "DATA", "PALETTE.RAW"))));
  const dir = (p: string) => (mkdirSync(join(outDir, p), { recursive: true }), join(outDir, p));
  const m: SpriteManifest = {
    riders: { frames: "", textures: [], shadow: "", cop: "", copShadow: "", anims: "", copAnims: "" },
    families: {},
    global: {},
    cars: {},
    horizons: {},
    dashboards: {},
    meter: "",
    clouds: [],
  };
  m.roof = "#" + Array.from(palette.subarray(0xfd * 4, 0xfd * 4 + 3), (c) => c.toString(16).padStart(2, "0")).join("");

  // --- Pilotos: un atlas por corredor (mismo layout) + sombras y policía (FUN_00443610/FUN_00443820)
  const riders = dir("sprites/riders");
  const bikers = (name: string) => decodeBikerFrames(new Uint8Array(readFileSync(join(game, "DATA", "BIKERS", `${name}.DAT`))), name);
  const bob = bikers("HIBOB");
  const layout = pack(bob);
  writeFileSync(join(riders, "frames.json"), JSON.stringify({ width: layout.width, height: layout.height, frames: layout.frames }));
  m.riders.frames = rel("sprites/riders/frames.json");
  const remaps = readRiderRemaps(new Uint8Array(readFileSync(join(game, "ROADRASH.EXE"))));
  for (let r = 0; r < RIDER_COUNT; r++) {
    writeFileSync(join(riders, `rider_${String(r).padStart(2, "0")}.png`), render(bob, layout, palette, remaps.subarray(r * 256, r * 256 + 256)));
    m.riders.textures.push(rel(`sprites/riders/rider_${String(r).padStart(2, "0")}.png`));
  }
  writeAtlas(riders, "shadow", bikers("HISHADOW"), palette);
  writeAtlas(riders, "cop", bikers("LOCOP"), palette);
  writeAtlas(riders, "cop_shadow", bikers("HISHADOC"), palette);
  m.riders.shadow = rel("sprites/riders/shadow");
  m.riders.cop = rel("sprites/riders/cop");
  m.riders.copShadow = rel("sprites/riders/cop_shadow");
  // Animaciones (formas, anclajes y plantillas del EXE): ver importer/riders.ts.
  const globalRsc = parseResourceFile(new Uint8Array(readFileSync(join(game, "DATA", "GLOBAL.RSC"))));
  const anims = readRiderAnims(new Uint8Array(readFileSync(join(game, "ROADRASH.EXE"))), getResource(globalRsc, "CANS", 1), getResource(globalRsc, "ANIM", 1), getResource(globalRsc, "ANIM", 3));
  writeFileSync(join(riders, "anims.json"), JSON.stringify(anims));
  m.riders.anims = rel("sprites/riders/anims.json");
  // Policía: conjunto 1 ('CANS' 2, 'ANIM' 2/4) sobre LOCOP (no hay HICOP: FUN_004436a0 cae en Lo) y HISHADOC.
  const copAnims = readRiderAnims(new Uint8Array(readFileSync(join(game, "ROADRASH.EXE"))), getResource(globalRsc, "CANS", 2), getResource(globalRsc, "ANIM", 2), getResource(globalRsc, "ANIM", 4), 1);
  writeFileSync(join(riders, "cop_anims.json"), JSON.stringify(copAnims));
  m.riders.copAnims = rel("sprites/riders/cop_anims.json");
  log(`pilotos: ${bob.length} fotogramas × ${RIDER_COUNT} corredores; ${anims.anims.length} animaciones, ${anims.shapes.length} formas, ${anims.hotspots.length} anclajes`);

  // --- Familias de objetos (FAMILIES.RSC, comprimidas con PKWARE DCL). El atlas contiene los objetos
  //     de borde (categoría 0) en el orden de su índice, con su anclaje; null = índice sin objeto.
  const famDir = dir("sprites/families");
  const fam = parseResourceFile(new Uint8Array(readFileSync(join(game, "DATA", "FAMILIES.RSC"))));
  // Texturas de terreno (categoría 1): una PNG por textura, para repetirla por cara de terreno.
  const terDir = dir("sprites/terrain");
  let famObjects = 0, famTextures = 0;
  for (const e of fam.entries) {
    if (e.type !== "FAM " || e.size <= 24) continue;
    const d = fam.data.subarray(e.offset, e.offset + e.size);
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const data = explode(d.subarray(16, 16 + v.getUint32(4, true)), v.getUint32(0, true));
    const id = String(e.id).padStart(3, "0");
    const entry: SpriteManifest["families"][string] = { atlas: "", objects: 0, terrain: [] };
    const objects = familyObjects(data);
    const present = objects.flatMap((o) => (o ? [o] : []));
    if (present.length) {
      const layout = pack(present.map((o) => o.image));
      writeFileSync(join(famDir, `fam_${id}.png`), render(present.map((o) => o.image), layout, palette));
      let k = 0;
      const frames = objects.map((o) => (o ? { ...layout.frames[k++], hx: o.hx, hy: o.hy, boxes: o.boxes } : null));
      writeFileSync(join(famDir, `fam_${id}.json`), JSON.stringify({ width: layout.width, height: layout.height, frames }));
      entry.atlas = rel(`sprites/families/fam_${id}`);
      entry.objects = objects.length;
      famObjects += present.length;
    }
    entry.terrain = familyTerrain(data).map((list, i) =>
      list.map((im, k) => {
        if (!im) return null;
        const file = `fam_${id}_${i}_${k}.png`;
        writeFileSync(join(terDir, file), render([im], { frames: [{ name: im.name, x: 0, y: 0, w: im.width, h: im.height }], width: im.width, height: im.height }, palette));
        famTextures++;
        return rel(`sprites/terrain/${file}`);
      }),
    );
    entry.heights = familyTerrainHeights(data);
    entry.sidewalk = familySidewalks(data).map((list, i) =>
      list.map((im, k) => {
        if (!im) return null;
        const file = `fam_${id}_walk_${i}_${k}.png`;
        writeFileSync(join(terDir, file), render([im], { frames: [{ name: im.name, x: 0, y: 0, w: im.width, h: im.height }], width: im.width, height: im.height }, palette));
        return rel(`sprites/terrain/${file}`);
      }),
    );
    if (entry.atlas || entry.terrain.some((l) => l.some(Boolean)) || entry.sidewalk.some((l) => l.some(Boolean))) m.families[e.id] = entry;
  }
  log(`familias: ${Object.keys(m.families).length} (${famObjects} objetos de borde, ${famTextures} texturas de terreno)`);

  // --- Texturas globales (asfalto, líneas, meta, semáforo, agua) de GLOBAL.RSC. Además del nombre, cada
  //     'CEL ' queda como "CEL <id>": el juego las pide por id (FUN_00441940) y hay nombres repetidos (PLAIN 1 y 6).
  const glob = dir("sprites/global");
  const g = parseResourceFile(new Uint8Array(readFileSync(join(game, "DATA", "GLOBAL.RSC"))));
  for (const e of g.entries)
    for (const im of scanPdats(g.data.subarray(e.offset, e.offset + e.size))) {
      const file = e.type === "CEL " ? `cel_${String(e.id).padStart(2, "0")}_${im.name.toLowerCase()}.png` : `${im.name.toLowerCase() || `${e.type.trim()}_${e.id}`}.png`;
      writeFileSync(join(glob, file), render([im], { frames: [{ name: im.name, x: 0, y: 0, w: im.width, h: im.height }], width: im.width, height: im.height }, palette));
      if (im.name) m.global[im.name] = rel(`sprites/global/${file}`);
      if (e.type === "CEL ") m.global[`CEL ${e.id}`] = rel(`sprites/global/${file}`);
    }

  // --- Coches de cada circuito (.CAR): atlas con los niveles de cada modelo y `<circuito>_models.json`
  //     con sus formas, anclajes y animaciones (importer/cars.ts).
  const cars = dir("sprites/cars");
  const exeBytes = new Uint8Array(readFileSync(join(game, "ROADRASH.EXE")));
  for (const course of ["CANYN", "CITY", "HIWAY", "MEDLY", "NAPA"]) {
    const p = join(game, "DATA", "CARS", `${course}.CAR`);
    if (!existsSync(p)) continue;
    const { images, models } = readCars(exeBytes, parseResourceFile(new Uint8Array(readFileSync(p))));
    writeAtlas(cars, course.toLowerCase(), images, palette);
    writeFileSync(join(cars, `${course.toLowerCase()}_models.json`), JSON.stringify(models));
    m.cars[course] = rel(`sprites/cars/${course.toLowerCase()}`);
  }
  log(`coches: ${Object.keys(m.cars).length} circuitos`);

  // --- Imágenes .BOB: horizontes 720 de ancho (FUN_0044c440), tablero 640 (FUN_0044c710),
  //     velocímetro 190×64 (FUN_0044c5d0), nubes, fondo.
  const imgDir = dir("images");
  for (const h of ["CITY", "NAPA", "PCH", "PENIN", "SIERRA"]) {
    writeBob(join(game, "IMAGES", "HORIZONS", `${h}.BOB`), join(imgDir, `horizon_${h.toLowerCase()}.png`), 720, palette, false);
    m.horizons[h] = rel(`images/horizon_${h.toLowerCase()}.png`);
  }
  for (const cls of ["RAT", "SPORT", "SUPER"]) {
    writeBob(join(game, "IMAGES", "BIKES", cls, "KHIDASH.BOB"), join(imgDir, `dash_${cls.toLowerCase()}.png`), 640, palette, true);
    m.dashboards[cls] = rel(`images/dash_${cls.toLowerCase()}.png`);
  }
  writeBob(join(game, "IMAGES", "BIGMETER.BOB"), join(imgDir, "meter.png"), 190, palette, true);
  m.meter = rel("images/meter.png");
  writeBob(join(game, "IMAGES", "BIGCLOUD.BOB"), join(imgDir, "cloud_big.png"), 512, palette, true);
  writeBob(join(game, "IMAGES", "LILCLOUD.BOB"), join(imgDir, "cloud_small.png"), 256, palette, true);
  m.clouds = [rel("images/cloud_big.png"), rel("images/cloud_small.png")];
  log("imágenes: 5 horizontes, 3 tableros, velocímetro, nubes");
  return m;
}

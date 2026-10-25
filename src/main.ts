import * as THREE from "three/webgpu";
import { buildView, type CourseJson, type ViewSlice } from "./road.ts";
import { Ground, type Track } from "./track.ts";
import { loadAtlas, pixelTexture, PoseSprite, type Atlas, type SpriteManifest } from "./sprites.ts";
import { buildObjects, familySlots, RoadsideObjects } from "./objects.ts";
import { Terrain } from "./terrain.ts";
import { Asphalt } from "./asphalt.ts";
import { atan2_8, Bike, bikeDurability, bikeParams, type PhysicsData, type RoadInfo } from "./bike.ts";
import { Anim, RIDING, RiderAnimator, rideAnim, type RiderAnims } from "./riders.ts";
import { engineVolume, GameAudio } from "./audio.ts";
import { aiWantsAttack, Fighter, KICK, nearest, resolveAttack, startAttack, type Combatant, type HitEvent } from "./combat.ts";
import { finishStep, places, resultMedia, type Outcome } from "./race.ts";
import { Hud } from "./hud.ts";
import { collideBikes, collideCar, collideObjects, type Body, type Contact } from "./collide.ts";
import { Route, type Region } from "./route.ts";
import { Buildings } from "./buildings.ts";
import { CAR, CAR_UNITS_PER_PIXEL, CROSS_LEFT, ONCOMING, Traffic, type Car, type CarModel, type LaneInfo } from "./traffic.ts";
import { CrossStreets, Signals, SignalSprites } from "./crossing.ts";
import { Menu, THRASH_COURSES } from "./menu.ts";

// Escala de la vista: 64 unidades del juego = 1 unidad de escena.
const U = 64;
// Distancia de dibujo: el original pide 0x21 = 33 cortes (FUN_00443a00). Con GPU se puede ampliar.
const DRAW_ORIGINAL = 33;
const DRAW_EXTENDED = 96;
const DRAW_MAX = DRAW_EXTENDED;
const LANE = 250; // 0xFA (FUN_00454240)
// Cámara del original (FUN_00437c30): un corte (256) detrás de la moto, altura mínima 150,
// x = ¾ del desplazamiento de la moto y a no más de 200 de ella.
const CAM_HEIGHT = 150;
// Proyección del original: focal 128 px en una pantalla interna de 320×240, horizonte en la línea 90.
const FOCAL = 128;
const HORIZON_TOP = 90;
const SCREEN_H = 240;
const TICK = 1 / 60; // FUN_004163d0: la simulación avanza a 60 Hz

const $ = (id: string) => document.getElementById(id)!;

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.autoClear = false; // tres pasadas: horizonte, escena, cabina
document.body.appendChild(renderer.domElement);

// --- Capas 2D: horizonte (BOB 720×320, FUN_0044c440) y tablero (BOB 640 de ancho, FUN_0044c710) ---
const hudCam = new THREE.OrthographicCamera(0, innerWidth, innerHeight, 0, -1, 1);
const bgScene = new THREE.Scene();
const hudScene = new THREE.Scene();
const horizon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0), new THREE.MeshBasicMaterial({ transparent: false }));
const dash = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0), new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.5 }));
const horizonFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0x335533 }));
horizon.visible = dash.visible = false;
bgScene.add(horizonFill, horizon);
hudScene.add(dash);
let horizonScroll = 0;
let showDash = true;

function layoutOverlays() {
  const W = innerWidth, H = innerHeight;
  hudCam.right = W;
  hudCam.top = H;
  hudCam.updateProjectionMatrix();
  const s = H / 480;
  horizon.position.set(0, H * (1 - 90 / 240), 0);
  horizon.scale.set(W, 320 * s, 1);
  const map = (horizon.material as THREE.MeshBasicMaterial).map;
  if (map) map.repeat.set(W / (720 * s), 1);
  dash.position.set((W - 640 * s) / 2, 0, 0);
  dash.scale.set(640 * s, 121 * s, 1);
  hud.layout(W, H);
}

const scene = new THREE.Scene();
const sky = new THREE.Color(0x8fb8de);
renderer.setClearColor(sky);
const fog = new THREE.Fog(sky, 100, 140);
scene.fog = fog;

const camera = new THREE.PerspectiveCamera();
function applyOriginalProjection() {
  const near = 0.05, far = 2000;
  const aspect = innerWidth / innerHeight;
  const top = HORIZON_TOP / FOCAL;
  const bottom = -(SCREEN_H - HORIZON_TOP) / FOCAL;
  const halfW = ((top - bottom) * aspect) / 2;
  camera.projectionMatrix.makePerspective(-halfW * near, halfW * near, top * near, bottom * near, near, far, camera.coordinateSystem);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}
// El renderizador llama a updateProjectionMatrix al fijar su sistema de coordenadas (WebGPU/WebGL):
// sin esto volvería a la proyección por defecto (fov 50) y perdería la del original.
camera.updateProjectionMatrix = applyOriginalProjection;
applyOriginalProjection();
const aerialCam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 4000);

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  applyOriginalProjection();
  layoutOverlays();
  aerialCam.aspect = innerWidth / innerHeight;
  aerialCam.updateProjectionMatrix();
});

// --- Carretera: tiras por corte, como el original ------------------------------
type Offsets = (s: ViewSlice) => [number, number];

class Ribbon {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private col: Float32Array;
  private geo = new THREE.BufferGeometry();
  private offsets: Offsets;
  private color: (s: ViewSlice) => THREE.Color;
  private lift: number;
  constructor(offsets: Offsets, color: (s: ViewSlice) => THREE.Color, lift = 0) {
    this.offsets = offsets;
    this.color = color;
    this.lift = lift;
    const verts = (DRAW_MAX + 2) * 2;
    this.pos = new Float32Array(verts * 3);
    this.col = new Float32Array(verts * 3);
    const idx: number[] = [];
    for (let i = 1; i < DRAW_MAX + 2; i++) {
      const k = i * 2;
      idx.push(k - 2, k, k - 1, k - 1, k, k + 1);
    }
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
  }
  update(slices: ViewSlice[]) {
    let v = 0;
    for (const s of slices) {
      const c = this.color(s);
      for (const off of this.offsets(s)) {
        this.pos[v * 3] = (s.x + off) / U;
        this.pos[v * 3 + 1] = s.y / U + this.lift;
        this.pos[v * 3 + 2] = -s.z / U;
        this.col.set([c.r, c.g, c.b], v * 3);
        v++;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.setDrawRange(0, Math.max(0, (slices.length - 1) * 6));
  }
}

// Arcén provisional (color plano) hasta decodificar sus texturas (familias, categorías 3/5).
const C = {
  dirtA: new THREE.Color(0x8c6c4c),
  dirtB: new THREE.Color(0x846446),
};
const band = (a: THREE.Color, b: THREE.Color) => (s: ViewSlice) => (Math.floor(s.index / 4) % 2 ? a : b);

let route: Route | null = null; // ruta del jugador y la otra rama de cada bifurcación (src/route.ts)
let track: Track | null = null; // = route.main

/** Arcenes de una carretera (los cortes ya llevan el desplazamiento del centro). */
function shoulderRibbons(get: () => Track) {
  const L = (s: ViewSlice) => get().laneL[s.index] * LANE;
  const R = (s: ViewSlice) => get().laneR[s.index] * LANE;
  const out = [
    new Ribbon((s) => [-L(s) - get().shoulderL[s.index], -L(s)], band(C.dirtA, C.dirtB), -0.01),
    new Ribbon((s) => [R(s), R(s) + get().shoulderR[s.index]], band(C.dirtA, C.dirtB), -0.01),
  ];
  for (const r of out) scene.add(r.mesh);
  return out;
}
const ribbons = shoulderRibbons(() => track!);
const altRibbons = shoulderRibbons(() => route!.alt);
let asphalt: Asphalt | null = null; // texturas de GLOBAL.RSC (src/asphalt.ts), al cargar el manifiesto
let altAsphalt: Asphalt | null = null;
const terrain = new Terrain(scene, U);
const altTerrain = new Terrain(scene, U);
const buildings = new Buildings(scene, U); // edificios y aceras de ciudad (src/buildings.ts)
const altBuildings = new Buildings(scene, U);
const roadside = new RoadsideObjects(scene, U);
const altRoadside = new RoadsideObjects(scene, U);

// Mar bajo los acantilados de PCH (provisional: plano fijo a la altura del precipicio de CANYN).
const sea = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, -0.5), new THREE.MeshBasicMaterial());
sea.position.set(0, -1200 / U, -256 / U);
sea.visible = false;
scene.add(sea);

// --- Corredores: jugador e IA con la física del original ------------------------
interface Crash { phase: "fly" | "ground" | "run" | "mount"; pos: number; lat: number; v: number }
interface Racer extends Combatant, Body {
  rider: number; // ficha (0 = jugador)
  name: string;
  sprite: PoseSprite;
  shadow: PoseSprite;
  foot: RiderAnimator; // piloto a pie tras una caída (FUN_00403d60 lo separa de la moto)
  footSprite: PoseSprite;
  footShadow: PoseSprite;
  crash: Crash | null;
  /**
   * Carretera en una bifurcación: 0 la del jugador; 1 la otra, en una zona doble (se ve); 2 la otra, entre
   * las zonas dobles (no se ve ni choca; vuelve a verse en la zona doble de la unión).
   */
  branch: 0 | 1 | 2;
  out: boolean; // moto destrozada
  finished: boolean;
  ai: {
    cruise: number; lane: number; offset: number; tgtPos: number; tgtLat: number;
    reach: number; kickOdds: number; backOdds: number; grudge: number; aggressive: boolean;
  } | null;
  engine: ReturnType<GameAudio["engine"]> | null;
  look?: Look; // escala y anclaje del sprite (el policía usa LOCOP, de baja resolución)
}
let physics: PhysicsData | null = null;
let riderAnims: RiderAnims | null = null;
let riderAtlas: Atlas | null = null;
let shadowAtlas: Atlas | null = null;
const riderTextures: THREE.Texture[] = [];
let shadowTexture: THREE.Texture | null = null;
const racers: Racer[] = [];
let player: Racer | null = null;
const PLAYER_BIKE = 0; // ficha de BIKESPEC (0-4 Rat, 5-9 Sport, 10-14 Super)
const RIVAL_COUNT = 14; // FUN_00405600: 16 plazas − 1 en un jugador, menos el jugador
// Ajuste propio (no del original): rivales un 20 % más competitivos (crucero y potencia de la moto).
const AI_BOOST = 1.2;
let level = 0; // nivel de carrera (DAT_004b8a12, 0-4)
const traffic = new Traffic(scene);
const signals = new Signals(); // semáforos de las intersecciones (src/crossing.ts)
const signalSprites = new SignalSprites(scene);
let crossStreets: CrossStreets | null = null;
let carEngine: ReturnType<GameAudio["engine"]> | null = null; // FUN_00434c40: voz del coche más cercano
const audio = new GameAudio();
let audioStarted = false;
// Policía (DAT_004642dc): ficha 15 y bloque de IA 9 (FUN_00407990), conjunto de animaciones 1 sobre LOCOP.
const COP = 15, COP_AI = 9;
let cop: Racer | null = null;
let copName = 0; // DAT_004642e0
let copAnims: RiderAnims | null = null;
let copAtlas: Atlas | null = null, copShadowAtlas: Atlas | null = null;
let copTexture: THREE.Texture | null = null, copShadowTexture: THREE.Texture | null = null;
let siren: ReturnType<GameAudio["engine"]> | null = null;
/** Corredores más el policía, si lo hay (no cuenta en los puestos). */
const everyone = () => (cop ? [...racers, cop] : racers);
const hud = new Hud();
hudScene.add(hud.under.mesh, hud.over.mesh); // barras detrás del tablero, agujas y textos delante

function makeSprites(texture = shadowTexture!, atlas = shadowAtlas!) {
  const shadow = new PoseSprite(texture, atlas);
  // La sombra cuelga por debajo del punto de apoyo (anclaje arriba): sin prueba de profundidad, como el
  // pintor del original. FUN_004463e0 pinta la sombra antes que el piloto, cuya rueda también cuelga por
  // debajo del punto de apoyo: las sombras van antes que todos los sprites (renderOrder −1). Ordenarlas por
  // distancia no basta: three.js ordena por la esquina de cada malla, no por el piloto, y a veces la sombra
  // quedaba encima y tapaba media rueda.
  const sm = shadow.mesh.material as THREE.MeshBasicMaterial;
  sm.depthTest = false;
  sm.depthWrite = false;
  shadow.mesh.renderOrder = -1;
  return shadow;
}

function makeRacer(k: number, ai: boolean): Racer {
  const ph = physics!;
  const bikeIndex = ai ? ph.bikesByLevel[k][level] : PLAYER_BIKE;
  const spec = ph.bikes[bikeIndex];
  const p = bikeParams(spec, ph.riderWeights[k % ph.riderWeights.length], ph.aiPower[level] * AI_BOOST, ai);
  // Color (FUN_004460c0 / FUN_00446190): el jugador, el de su moto; el rival k, el k (0 si coincide).
  const color = ai ? (k === PLAYER_BIKE ? 0 : k) : PLAYER_BIKE;
  const sprite = new PoseSprite(riderTextures[color], riderAtlas!);
  const footSprite = new PoseSprite(riderTextures[color], riderAtlas!);
  const shadow = makeSprites(), footShadow = makeSprites();
  scene.add(shadow.mesh, sprite.mesh, footShadow.mesh, footSprite.mesh);
  const stats = ph.riders[k];
  const fight = ph.aiFight[k < 10 ? k : 0];
  return {
    rider: k,
    name: ph.names[k] ?? "",
    bike: new Bike(p, ph.surfaceDrag, ph.grip),
    anim: new RiderAnimator(riderAnims!),
    fight: new Fighter(stats.weapon[level], stats.strength, stats.stamina, bikeDurability(spec)),
    down: false,
    sprite,
    shadow,
    foot: new RiderAnimator(riderAnims!),
    footSprite,
    footShadow,
    crash: null,
    branch: 0,
    prevPos: 0,
    prevLat: 0,
    out: false,
    finished: false,
    // FUN_004078f0: los corredores 0-8 tienen su bloque de IA; el resto, el del 0 con ±6 al azar.
    ai: ai
      ? {
          cruise: Math.round((k < 9 ? ph.aiCruise[k][level] : ph.aiCruise[0][level] + Math.floor(Math.random() * 13) - 6) * AI_BOOST),
          lane: 0, offset: 0, tgtPos: 0, tgtLat: 0,
          reach: fight.reach, kickOdds: fight.kickOdds, backOdds: fight.backOdds,
          grudge: 0,
          // [I] La actitud del original (bloque de IA +0x174, FUN_004082f0) sale de un rencor que crece con
          // cada golpe (FUN_00408d50) y del nivel; aquí, una parte de los rivales busca pelea desde el principio.
          aggressive: Math.random() < [0.25, 0.4, 0.55, 0.7, 0.85][level],
        }
      : null,
    engine: null,
  };
}

/** FUN_00405600: jugador + 14 rivales; se rehace al cambiar de nivel (cambian motos, armas y crucero). */
function buildRacers() {
  removeCop();
  for (const r of racers) {
    scene.remove(r.sprite.mesh, r.shadow.mesh, r.footSprite.mesh, r.footShadow.mesh);
    r.engine?.stop();
  }
  racers.length = 0;
  player = makeRacer(0, false);
  racers.push(player);
  for (let k = 1; k <= RIVAL_COUNT; k++) racers.push(makeRacer(k, true));
  if (audioStarted) attachEngines();
}

/**
 * FUN_00406b80: policía con las plantillas 0x464310/0x464378 (las mismas que la IA), tipo 2, ficha 15, moto
 * 0x4641c8[nivel + 15·5] y potencia de la IA; FUN_00446060 le da el conjunto de animaciones 0x4746b8[2] = 1
 * (LOCOP, 'CANS' 2). Sale en el centro de la carretera (+0xCC) y parado (+0xEC = 0); nombre 0x464410[k].
 */
function spawnCop(pos: number) {
  if (cop || !copAnims || !copAtlas || !copTexture || !copShadowAtlas || !copShadowTexture || !physics || !track) return;
  const ph = physics;
  const spec = ph.bikes[ph.bikesByLevel[COP][level]];
  const bike = new Bike(bikeParams(spec, ph.riderWeights[COP] ?? ph.riderWeights[0], ph.aiPower[level] * AI_BOOST, true), ph.surfaceDrag, ph.grip);
  bike.pos = pos;
  bike.lat = Math.round(track.offset[stepOf(pos)] * 256);
  const sprite = new PoseSprite(copTexture, copAtlas), footSprite = new PoseSprite(copTexture, copAtlas);
  const shadow = makeSprites(copShadowTexture, copShadowAtlas), footShadow = makeSprites(copShadowTexture, copShadowAtlas);
  scene.add(shadow.mesh, sprite.mesh, footShadow.mesh, footSprite.mesh);
  const st = ph.riders[COP], fight = ph.aiFight[COP_AI];
  // [I] La octava entrada de la tabla es ".": el port solo usa los siete nombres.
  const names = (ph.copNames ?? []).filter((n) => n.length > 1);
  cop = {
    rider: COP,
    name: names.length ? names[copName++ % names.length] : "",
    bike,
    anim: new RiderAnimator(copAnims),
    fight: new Fighter(st.weapon[level], st.strength, st.stamina, bikeDurability(spec)),
    down: false,
    sprite,
    shadow,
    foot: new RiderAnimator(copAnims),
    footSprite,
    footShadow,
    crash: null,
    branch: 0,
    prevPos: pos,
    prevLat: bike.lat,
    out: false,
    finished: false,
    ai: {
      cruise: Math.round(ph.aiCruise[COP_AI][level] * AI_BOOST),
      lane: 0, offset: 0, tgtPos: 0, tgtLat: 0,
      reach: fight.reach, kickOdds: fight.kickOdds, backOdds: fight.backOdds,
      // FUN_00406b80 le pone un rencor enorme hacia el jugador ((16 − x)·4000 − nivel·6000): siempre va a por él.
      grudge: 1, aggressive: true,
    },
    engine: audioStarted ? audio.engine("ENGOTHER") : null,
    look: COP_LOOK,
  };
  cop.anim.set(Anim.Stop);
  if (audioStarted) siren ??= audio.engine("SIREN");
}

/** FUN_004073a0: quita el policía (y su sirena). */
function removeCop() {
  if (!cop) return;
  for (const s of [cop.sprite, cop.shadow, cop.footSprite, cop.footShadow]) {
    scene.remove(s.mesh);
    const m = s.mesh.material as THREE.MeshBasicMaterial;
    m.map?.dispose();
    m.dispose();
  }
  cop.engine?.stop();
  siren?.stop();
  siren = null;
  if (rival === cop) rival = null;
  cop = null;
}

/**
 * FUN_00407f30 (piloto del jugador) y FUN_00406940: cada 0x1000 ticks, si no hay policía y el jugador no ha
 * llegado, sale uno 0x27 pasos por detrás (FUN_00449910(corte, −0x2700)); desaparece al salir de la zona activa
 * (la misma que el tráfico, cámara − 0x3000 + 0x100 … + 0x5000 − 0x200).
 * [?] Las entradas RHZD de tipo ≥ 0xB lo crean por delante (FUN_004409e0), pero su paso no encaja con los datos.
 */
function copTick() {
  const p = player!;
  if (!cop) {
    if ((tick & 0xfff) === 0 && !p.finished) spawnCop(Math.max(128, p.bike.pos - 0x2700));
    return;
  }
  const d = cop.bike.pos - p.bike.pos;
  if (d < -0x3000 + 0x100 || d > 0x5000 - 0x200) { removeCop(); return; }
  // Detención: parado (< 300) o, con el piloto a pie (+0x2F4 = 2), con la moto a menos de 0x708; el policía
  // montado (FUN_00407860), a menos de 0x200 de avance del piloto y con menos de 5000 de diferencia de velocidad
  // → FUN_00416010(4, 180): Busted.
  if (p.finished || outcome || cop.crash) return;
  const c = p.crash, b = p.bike;
  const onFoot = !!c && (c.phase === "ground" || c.phase === "run");
  if (onFoot ? Math.abs(b.v) >= 0x708 : b.v >= 300) return;
  const pos = c ? c.pos : b.pos;
  if (Math.abs(cop.bike.pos - pos) < 0x200 && Math.abs(cop.bike.v - b.v) < 5000) setOutcome("busted");
}

// --- Carrera ---------------------------------------------------------------------
type Phase = "grid" | "racing" | "over";
let phase: Phase = "grid";
let tick = 0; // DAT_004b7ecc
let finishPos = 0; // unidades (paso · 256)
const finishedOrder: number[] = [];
let outcome: Outcome | null = null;
let outcomeTimer = 0;
let rival: Racer | null = null; // DAT_004b8a30: último corredor con el que se ha peleado el jugador
let placeOf: number[] = [];
const attackQueue: { type: number; backhand: boolean }[] = [];

/** Parrilla de FUN_00405600: [lateral en 1/256 de unidad, paso desde el inicio del circuito]. */
function grid() {
  // La salida vuelve a las ramas por defecto (byte +0x19 de cada bifurcación).
  if (route && route.choices.some((c) => c)) {
    route = new Route(course!);
    applyRoute();
  }
  const g = physics!.grid;
  const table = level === 4 ? g.rivalsLast : g.rivals;
  racers.forEach((r, i) => {
    const [lat, step] = i === 0 ? g.player : table[i];
    const b = r.bike;
    b.pos = r.prevPos = step * 256 + 128;
    b.lat = r.prevLat = lat;
    b.v = b.power = b.force = b.gear = b.steer = b.latVel = 0;
    const st = physics!.riders[r.rider];
    r.fight = new Fighter(st.weapon[level], st.strength, st.stamina, r.fight.bikeMax);
    r.down = r.out = r.finished = false;
    r.crash = null;
    r.branch = 0;
    r.anim.hold = r.foot.hold = false;
    r.anim.set(Anim.Stop);
    if (r.ai) { r.ai.tgtPos = 0; r.ai.grudge = 0; r.ai.lane = lat > 0x8000 ? 1 : 0; }
  });
  removeCop();
  phase = "grid";
  tick = 0;
  finishedOrder.length = 0;
  outcome = null;
  rival = null;
  attackQueue.length = 0;
  traffic.clear();
  if (track) signals.setTrack(track);
  placeOf = places(racers.map((r) => r.bike.pos), finishedOrder);
  hideResult();
  banner(`${courseTitle} · nivel ${level + 1}`);
}

const totalLength = () => (track ? (track.steps.length - 2) * 256 : 1);
const stepOf = (pos: number) => Math.max(0, Math.min(track!.steps.length - 1, Math.floor(pos / 256)));

/** Separación de la otra carretera de una zona doble en `pos` (interpolada entre pasos). */
function shiftAt(reg: Region, pos: number) {
  const n = reg.shift.length;
  const k = Math.max(0, Math.min(n - 1, pos / 256 - 0.5 - reg.from));
  const k0 = Math.floor(k), k1 = Math.min(n - 1, k0 + 1);
  return reg.shift[k0] + (reg.shift[k1] - reg.shift[k0]) * (k - k0);
}

/** Carretera de un corredor en el paso `i`: ruta, índice en ella y centro en el sistema principal. */
function laneOf(i: number, branch: number, pos = i * 256 + 128): { t: Track; idx: number; center: number } {
  const reg = branch === 1 ? route!.regionAt(i) : null;
  if (!reg) return { t: track!, idx: i, center: track!.offset[i] };
  const a = reg.alt + (i - reg.from);
  return { t: route!.alt, idx: a, center: shiftAt(reg, pos) + route!.alt.offset[a] };
}
const altCenter = (reg: Region, i: number) => reg.shift[i - reg.from] + route!.alt.offset[reg.alt + (i - reg.from)];

function roadAt(i: number, branch = 0, pos?: number): RoadInfo {
  const { t, idx, center } = laneOf(i, branch, pos);
  const left = center - t.laneL[idx] * LANE, right = center + t.laneR[idx] * LANE;
  return {
    curve: t.steps[idx].curve,
    left,
    right,
    shoulderL: left - t.shoulderL[idx],
    shoulderR: right + t.shoulderR[idx],
    sidewalk: t.groundL[idx] === Ground.Buildings || t.groundR[idx] === Ground.Buildings,
  };
}

/** Ángulo de la curvatura de un paso (atan de FUN_0044f720, 24 bits) — media de FUN_00449b40. */
function curveAngle(t: Track, i: number) {
  const b = t.steps[Math.min(i, t.steps.length - 1)].curve;
  const a = Math.abs(b) <= 256 ? physics!.atan[Math.abs(b)] : 0x100 - physics!.atan[Math.trunc(65536 / Math.abs(b))];
  return Math.sign(b) * (a << 14);
}
const avgCurve = (t: Track, i: number, n: number) => {
  let s = 0;
  for (let k = 0; k < n; k++) s += curveAngle(t, i + k);
  return Math.trunc(s / n);
};

/**
 * FUN_00439390: al entrar en el primer paso de una rama, la rama 0 si el lateral queda a la izquierda de su
 * borde derecho (+0xE4), si no la 1. La del jugador fija la ruta (FUN_004540e0).
 */
function chooseBranch(r: Racer, f: number, i: number) {
  const fork = route!.main.forks[f];
  const reg = route!.regions.find((g) => g.fork === f && g.kind === "fork");
  if (!reg) return;
  const edge0 = fork.branch === 0
    ? track!.offset[i] + track!.laneR[i] * LANE
    : altCenter(reg, i) + route!.alt.laneR[reg.alt] * LANE;
  const choice = r.bike.lat / 256 < edge0 ? 0 : 1;
  if (r === player) {
    if (choice !== fork.branch) switchRoute(f);
    r.branch = 0;
  } else r.branch = choice === fork.branch ? 0 : 1;
}

/** Desplaza un corredor (moto y, si va a pie, el piloto) `d` en lateral (1/256 de unidad). */
function shiftRider(r: Racer, d: number) {
  r.bike.lat += d;
  r.prevLat += d;
  if (r.crash) r.crash.lat += d;
}

/** Cada tick: elección de rama al entrar y paso entre la zona doble y el tramo oculto de la otra rama. */
function followBranch(r: Racer) {
  const s0 = stepOf(r.prevPos), s1 = stepOf(r.bike.pos);
  for (let i = s0 + 1; i <= s1; i++) {
    const f = route!.forkAt(i);
    if (f >= 0) chooseBranch(r, f, i);
  }
  if (r.branch === 0) return;
  const reg0 = route!.regionAt(s0), reg1 = route!.regionAt(s1);
  if (r.branch === 1) {
    if (reg1 && reg1 === reg0) { shiftRider(r, (shiftAt(reg1, r.bike.pos) - shiftAt(reg1, r.prevPos)) * 256); return; }
    if (reg1 || !reg0) return;
    // Sale de la zona doble: tras la bifurcación pasa al tramo oculto (conserva su posición respecto al
    // centro de su carretera); tras la unión, o hacia atrás antes de la bifurcación, la carretera es la misma.
    const forward = s1 >= reg0.to;
    if (forward === (reg0.kind === "fork")) {
      const k = forward ? reg0.to - 1 : reg0.from;
      shiftRider(r, -(altCenter(reg0, k) - track!.offset[k]) * 256);
      r.branch = 2;
    } else r.branch = 0;
  } else if (reg1) {
    // Del tramo oculto a la zona doble de la unión (o, hacia atrás, a la de la bifurcación).
    const k = reg1.kind === "merge" ? reg1.from : reg1.to - 1;
    shiftRider(r, (altCenter(reg1, k) - track!.offset[k]) * 256);
    r.branch = 1;
  } else if (!route!.main.forks.some((f) => s1 >= f.start && s1 < f.merge)) r.branch = 0;
}

/**
 * El jugador toma la otra rama de la bifurcación `f`: la ruta principal pasa a ser la otra y cada corredor
 * se lleva a la nueva (mismo sitio en las zonas dobles; en proporción entre ellas; desplazado tras la unión).
 */
function switchRoute(f: number) {
  const old = route!;
  const next = new Route(course!, old.main.forks.map((k, j) => (j === f ? 1 - k.branch : k.branch)));
  const fo = old.main.forks[f], fn = next.main.forks[f];
  const of = old.regions.find((g) => g.fork === f && g.kind === "fork")!, om = old.regions.find((g) => g.fork === f && g.kind === "merge")!;
  const nf = next.regions.find((g) => g.fork === f && g.kind === "fork")!, nm = next.regions.find((g) => g.fork === f && g.kind === "merge")!;
  const dLen = fn.merge - fo.merge;
  const oldAltCenter = (reg: Region, i: number) => reg.shift[i - reg.from] + old.alt.offset[reg.alt + (i - reg.from)];
  /** [pos, Δlat, ¿cambia de carretera?] */
  const map = (pos: number): [number, number, boolean] => {
    const i = Math.max(0, Math.min(old.main.steps.length - 1, Math.floor(pos / 256)));
    const frac = pos - i * 256;
    if (i < fo.start) return [pos, 0, false];
    if (i >= fo.merge) return [pos + dLen * 256, (next.main.offset[i + dLen] - old.main.offset[i]) * 256, false];
    if (i < of.to || i >= om.from) {
      // Zona doble: la nueva principal es la antigua otra carretera.
      const reg = i < of.to ? of : om, j = i < of.to ? i : i + dLen;
      return [j * 256 + frac, -(oldAltCenter(reg, i) - next.main.offset[j]) * 256, true];
    }
    const t = (i - of.to + frac / 256) / Math.max(1, om.from - of.to);
    const j = Math.min(nm.from - 1, Math.floor(nf.to + t * (nm.from - nf.to)));
    return [j * 256 + frac, (next.main.offset[j] - old.main.offset[i]) * 256, true];
  };
  for (const r of everyone()) {
    const [pos, dLat, swap] = map(r.bike.pos);
    const dPos = pos - r.bike.pos;
    r.bike.pos = pos;
    r.prevPos += dPos;
    if (r.crash) r.crash.pos += dPos;
    shiftRider(r, dLat);
    const i = stepOf(pos);
    if (swap && i >= fn.start && i < fn.merge) {
      const dual = i < nf.to || i >= nm.from;
      r.branch = r.branch === 0 ? (dual ? 1 : 2) : 0;
    }
    if (r.ai) r.ai.tgtPos = 0;
  }
  for (const c of [...traffic.cars]) {
    const [pos, dLat, swap] = map(c.pos);
    c.prevPos += pos - c.pos;
    c.pos = pos;
    c.lat += dLat;
    c.prevLat += dLat;
    const i = stepOf(pos);
    if (swap && i >= fn.start && i < fn.merge) {
      if (i < nf.to || i >= nm.from) c.branch = c.branch === 0 ? 1 : 0;
      else traffic.remove(c);
    }
  }
  route = next;
  applyRoute();
}

/** Ruta nueva: meta, texturas y objetos de las dos carreteras. */
function applyRoute() {
  track = route!.main;
  finishPos = finishStep(course!, track, level) * 256;
  signals.setTrack(track);
  if (!sprites) return;
  asphalt?.setCourse(track);
  altAsphalt?.setCourse(route!.alt);
  void roadside.setCourse(buildObjects(course!, track), sprites.families);
  void altRoadside.setCourse(buildObjects(course!, route!.alt), sprites.families);
  void terrain.setCourse(track, familySlots(course!, track), sprites.families);
  void altTerrain.setCourse(route!.alt, familySlots(course!, route!.alt), sprites.families);
  void buildings.setCourse(track, familySlots(course!, track), sprites.families, sprites.roof);
  void altBuildings.setCourse(route!.alt, familySlots(course!, route!.alt), sprites.families, sprites.roof);
}

/** Corredores en la carretera visible (los del tramo oculto de la otra rama no chocan ni pelean). */
const onRoad = () => everyone().filter((r) => r.branch !== 2);
/**
 * Corredor más cercano que se pueda golpear (FUN_00409400). El policía solo va a por el jugador y los rivales no
 * van a por él (su rencor hacia el policía empieza en 0).
 */
const fightTarget = (r: Racer) =>
  r.branch === 2 ? null : (nearest(r, r === cop ? [player!] : onRoad().filter((o) => r === player || o !== cop)) as Racer | null);

/** Objetos del borde de la carretera del corredor, con x en el sistema principal. */
function obstaclesFor(r: Racer, i: number) {
  if (r.branch === 2) return [];
  const { idx, center } = laneOf(i, r.branch, r.bike.pos);
  return (r.branch === 1 ? altRoadside : roadside).obstacles(idx).map((o) => ({ x: o.x + center, boxes: o.boxes }));
}

/** IA en carrera (FUN_004091f0, FUN_00409020, FUN_00409f70) y en pelea (FUN_00409ca0, FUN_00409460). */
function aiTick(r: Racer) {
  const b = r.bike, ai = r.ai!;
  const i = stepOf(b.pos);
  const road = laneOf(i, r.branch, b.pos);
  if (b.pos >= ai.tgtPos - 0x100 || ai.tgtPos - b.pos > 0x800) {
    // FUN_004091f0: punto 3,75 pasos por delante, en su carril, desplazado hacia el interior de la curva;
    // lateral = centro de su carretera (+0xCC) + carril. Se guarda respecto al centro: en la otra rama de una
    // zona doble el centro se mueve con la separación.
    // [I] En carreteras sin carriles a la derecha (sentido único a la izquierda) usa los de la izquierda.
    const t = road.t, j = road.idx;
    const right = t.laneR[j] >= 1;
    const lane = Math.min(ai.lane, Math.max(0, Math.floor(right ? t.laneR[j] : t.laneL[j]) - 1));
    ai.tgtPos = b.pos + 0x3c0;
    ai.tgtLat = (avgCurve(t, j, 8) >> 3) + (right ? 1 : -1) * (lane * LANE + LANE / 2) * 256 + ai.offset;
  }
  let tgtLatAbs = ai.tgtLat + Math.round(road.center * 256);
  // FUN_004082f0: crucero del nivel; con el jugador cerca, ajuste por pasos de ventaja (DAT_004659d4).
  let want = ai.cruise;
  const lead = Math.trunc((b.pos - player!.bike.pos) / 256);
  if (Math.abs(lead) <= 20) want = Math.trunc(((physics!.aiRubber[Math.max(-9, Math.min(10, lead)) + 9] + 100) * want) / 100);
  // FUN_00409020: menor en curva.
  const c = Math.abs(avgCurve(road.t, road.idx + 8, 4));
  if (c > 0x30000) {
    const base = want - (want >> 2), half = base >> 1;
    want = base - (((Math.trunc((half << 8) / 0x600)) * (c >> 8)) >> 8) + half;
  }
  // FUN_00409ca0: con un rival a mano, ponerse a su lado (14000 + distancia·0x1000, hasta 28000) y a su ritmo.
  const t = fightTarget(r);
  const hunting = t && !r.finished && r.branch !== 2 && (r === cop || (t === player ? ai.aggressive || ai.grudge > 0 : ai.aggressive && ai.grudge > 0));
  let tgtPos = ai.tgtPos;
  if (t && hunting) {
    const d = Math.abs(t.bike.pos - b.pos) >> 4;
    const off = Math.min(28000, d * 0x1000 + 14000);
    tgtPos = t.bike.pos + 0x3c0;
    tgtLatAbs = t.bike.lat + (b.lat > t.bike.lat ? off : -off);
    want = t.bike.mph + (t.bike.pos > b.pos ? 3 : -3);
    // FUN_004092e0 + FUN_00409460
    if (aiWantsAttack(r, t, tick, level, ai.reach, physics!)) {
      // El conjunto del policía solo trae el garrote (16/17): la patada o el revés no llegan a empezar.
      const type = Math.floor(Math.random() * ai.kickOdds) === 0 ? KICK : r.fight.weapon;
      const before = r.anim.anim;
      startAttack(r, t, type, type !== KICK && Math.floor(Math.random() * ai.backOdds) === 0);
      if (r.anim.anim !== before && type !== KICK && r.fight.weapon > 0) sfx(r.fight.weapon === 2 ? "swishcha" : "swishgen", r);
    }
  }
  if (r.finished) want = 0;
  // [I] El policía frena al acercarse al jugador (o a su piloto, si se ha caído): su velocidad + 1 mph por cada 64
  // unidades de distancia. En el original lo lleva su rencor (FUN_00408ad0), que el port no reproduce.
  if (r === cop && !hunting) {
    const p = player!, gap = (p.crash ? p.crash.pos : p.bike.pos) - b.pos;
    if (gap > -0x400 && gap < 0x2000) want = Math.min(want, Math.max(0, (p.crash ? 0 : p.bike.mph) + (gap >> 6)));
  }
  // [I] Esquiva los coches que tiene delante (más lejos si vienen de frente): pasa por el lado en que
  // cabe dentro de la carretera y, si lo tiene encima sin hueco, frena a su velocidad.
  const edges = roadAt(i, r.branch, b.pos);
  for (const c of traffic.cars) {
    const dz = c.pos - b.pos;
    if (dz <= 0 || dz > (c.type === ONCOMING ? 0x1400 : 0x900) || c.branch !== (r.branch === 1 ? 1 : 0)) continue;
    const w = c.halfW + 0x1e00 + 0x1000;
    if (Math.abs(c.lat - tgtLatAbs) >= w) continue;
    const okL = (c.lat - w) / 256 > edges.left + 40, okR = (c.lat + w) / 256 < edges.right - 40;
    const side = b.lat < c.lat ? (okL || !okR ? -1 : 1) : (okR || !okL ? 1 : -1);
    tgtLatAbs = c.lat + side * w;
    tgtPos = Math.min(tgtPos, c.pos);
    if (c.type !== ONCOMING && dz < 0x600 && Math.abs(c.lat - b.lat) < w) want = Math.min(want, (c.v >> 12) + (c.v >> 7) + (c.v >> 9));
  }
  // FUN_00409f70: dirección hacia el punto (atan2 en 8 bits ·8 = unidades de FUN_0040af50).
  const dLat = (-4 * b.steer - b.lat + tgtLatAbs) >> 8;
  let a = atan2_8(tgtPos - b.pos, dLat) & 0xff;
  if (a > 0x7f) a -= 0x100;
  b.steerTo(a * 8, 0);
  const shown = b.mph;
  if (shown < want) b.throttle(b.p.power);
  else if (shown === want) b.coast();
  else b.brake(b.p.brake);
}

const keys = new Set<string>();
/** FUN_00434660 */
function playerTick(r: Racer) {
  const b = r.bike;
  if (r.finished) {
    // Tras la meta: frena solo y va recto; parado (< 300) → FUN_00416010(0x7F, 180).
    b.brake(b.p.brake);
    b.steerTo(0, 0);
    if (b.v < 300 && !outcome) setOutcome(placeOf[0] <= 3 ? "win" : "lose");
    return;
  }
  if (keys.has("w") || keys.has("arrowup")) b.throttle(b.p.power); // FUN_0040acd0(…, 1)
  else if (keys.has("s") || keys.has("arrowdown")) b.brake(b.p.brake); // FUN_0040acd0(…, 2)
  else b.coast();
  // FUN_00434660 → FUN_0040ad30: las flechas (bits 4 / 0x200) giran ±0x20 con sentido 0; "Inclinarse"
  // (Inicio / RePág, bits 8 / 0x400) pasa el sentido −1/+1, que sube el tope un 25 % y acelera el giro. Solo
  // con la de inclinarse: ángulo = sentido·0x20 y sentido contrario.
  const left = keys.has("a") || keys.has("arrowleft"), right = keys.has("d") || keys.has("arrowright");
  const lean = keys.has("pageup") ? 1 : keys.has("home") ? -1 : 0;
  if (left !== right) b.steerTo(right ? 0x20 : -0x20, lean);
  else b.steerTo(lean << 5, -lean);
  const req = attackQueue.shift();
  if (req) {
    const before = r.anim.anim;
    startAttack(r, fightTarget(r), req.type, req.backhand);
    if (r.anim.anim !== before && req.type !== KICK && r.fight.weapon > 0) sfx(r.fight.weapon === 2 ? "swishcha" : "swishgen", r);
  }
  attackQueue.length = 0;
}

/**
 * FUN_00403d60: el piloto sale despedido 75 unidades por delante de la moto (+0x4B00 en 8.8).
 * Animación según el modo: golpe en pelea '#' (35), choque 29 (rueda) o 33 (vuela).
 */
function startCrash(r: Racer, anim: number = Anim.Fall) {
  const b = r.bike;
  r.down = true;
  r.crash = { phase: "fly", pos: b.pos + 75, lat: b.lat, v: Math.max(0, b.v) };
  r.foot.hold = true;
  r.foot.set(r.foot.has(anim) ? anim : 33); // el policía solo tiene la de salir volando
  r.anim.hold = true;
  r.anim.set(Anim.BikeFall);
  const down = b.latVel >= 0 ? Anim.BikeDownR : Anim.BikeDownL;
  r.anim.queue(r.anim.has(down) ? down : Anim.BikeDownL);
  b.power = b.force = b.steer = b.latVel = 0;
  sfx("crashhar", r);
}

/** Caída: moto y piloto frenan (+0x154 = 0x5F y 0x46); el piloto se levanta, corre a la moto y monta (FUN_0040a600). */
function crashTick(r: Racer) {
  const c = r.crash!, b = r.bike;
  // FUN_004349c0 con +0x2F4 (caído): las rpm bajan 0x1000 por tick hasta el ralentí.
  b.rpm = Math.max(0x2000, b.rpm - 0x1000);
  b.v = Math.max(0, b.v - 0x5f - ((130 * (b.v >> 8)) >> 8));
  b.pos += b.v >> 8;
  switch (c.phase) {
    case "fly":
      c.v = Math.max(0, c.v - 0x46 - ((130 * (c.v >> 8)) >> 8));
      c.pos += c.v >> 8;
      if (c.v === 0) {
        // FUN_00407f30: parado → se levanta ('$') y queda de pie ('%').
        c.phase = "ground";
        r.foot.hold = false;
        r.foot.set(Anim.Stand);
        r.foot.queue(Anim.StandIdle);
      }
      break;
    case "ground":
      // [I] El conjunto del policía no trae correr ni montar (38/41): se queda de pie hasta desaparecer.
      if (r === cop) break;
      if (r.foot.anim === Anim.StandIdle && r.foot.loops > 1) {
        if (r.fight.bikeHealth === 0) {
          // FUN_0040a600: moto destrozada; el jugador pierde la carrera (FUN_00416010(5, 180)).
          if (!r.out) { r.out = true; if (r === player) setOutcome("wreck"); }
        } else {
          c.phase = "run";
          r.foot.set(Anim.Run);
        }
      }
      break;
    case "run": {
      // [I] FUN_0040a9d0 da la velocidad de carrera a pie; el jugador también la controla con las flechas.
      const dz = b.pos - c.pos, dl = b.lat + 6000 - c.lat;
      c.pos += Math.sign(dz) * Math.min(Math.abs(dz), 3);
      c.lat += Math.sign(dl) * Math.min(Math.abs(dl), 3 * 256);
      if (Math.abs(dz) <= 3 && Math.abs(dl) < 6001) {
        c.phase = "mount";
        r.anim.hold = false;
        r.anim.set(Anim.MountL); // ')'
        r.anim.queue(Anim.Ride);
      }
      break;
    }
    case "mount":
      if (r.anim.anim !== Anim.MountL) {
        r.crash = null;
        r.down = false;
        r.fight.guardUntil = tick + 120;
      }
      break;
  }
}

function setOutcome(o: Outcome) {
  // FUN_00416010: el resultado se fija una vez y la carrera acaba 180 ticks después.
  if (outcome) return;
  outcome = o;
  outcomeTimer = 180;
  if (o === "win") sfx("m_yeah", player!);
}

function onHit(h: HitEvent) {
  const a = h.attacker as Racer, v = h.victim as Racer;
  sfx(["punchhea", "clubimpa", "chainimp", "kick_mw4"][h.type], v);
  if (a === player) rival = v;
  else if (v === player) rival = a;
  if (v.ai && a === player) v.ai.grudge++; // FUN_00408d50(víctima, atacante, 2)
  if (h.knockedOut) startCrash(v);
}

/** Un tick de un corredor: caída, o IA/teclado + física + animación de conducción. */
function tickRacer(r: Racer) {
  if (r.crash) crashTick(r);
  else {
    if (r.ai) aiTick(r);
    else playerTick(r);
    // FUN_00438c70: el jugador con el giro a tope y sin agarre más de 0x19 ticks se cae (FUN_00403d60, modo 6:
    // piloto −0x600, moto +0x400).
    if (r.bike.step(roadAt(stepOf(r.bike.pos), r.branch, r.bike.pos), r === player)) {
      startCrash(r, 33);
      r.crash!.v = Math.max(0, r.crash!.v - 0x600);
      r.bike.v += 0x400;
    }
    // FUN_00407f30: animación de conducción según la velocidad, solo si no hay otra en curso.
    if (RIDING.has(r.anim.anim)) r.anim.set(rideAnim(r.bike.v, r.bike.force));
    if (r === player && r.finished && placeOf[0] < 4) {
      if (r.anim.anim === Anim.Victory) r.anim.queue(Anim.Victory);
      else r.anim.set(Anim.Victory);
    }
    if (r.ai && r.anim.anim === Anim.Taunt && r.anim.loops > 2) r.anim.set(Anim.Ride);
  }
  r.anim.tick();
  r.foot.tick();
  if (!r.crash || r.crash.phase !== "fly") r.fight.recover();
  followBranch(r);
}

function simulate() {
  if (phase !== "racing") {
    for (const r of racers) r.anim.tick();
    return;
  }
  tick++;
  for (const r of everyone()) { r.prevPos = r.bike.pos; r.prevLat = r.bike.lat; }
  racers.forEach((r, i) => {
    tickRacer(r);
    // FUN_00437800: orden de llegada.
    if (!r.finished && r.bike.pos >= finishPos) { r.finished = true; finishedOrder.push(i); }
    if (r.bike.pos >= totalLength()) r.bike.pos -= totalLength();
  });
  if (cop) tickRacer(cop);
  copTick();
  // FUN_004368f0: choques entre motos y contra los objetos del borde.
  // FUN_0044dd90 / FUN_0044e710: tráfico (con el avance del jugador en este tick).
  const adv = Math.max(0, player!.bike.pos - player!.prevPos);
  traffic.spawnTick(adv, player!.bike.pos, (i) => carLanes(i, 0));
  signals.tick(player!.bike.pos, tick, traffic, (i) => track!.offset[Math.max(0, Math.min(track!.offset.length - 1, i))], traffic.rand);
  traffic.tick(player!.bike.pos, carLanes, (c) => c.branch === 0 || !!route!.regionAt(Math.floor(c.pos / 256)), (c) => (c.branch === 0 ? signals.stopFor(c) : null));
  const contacts: Contact[] = [];
  const riding = onRoad();
  for (const r of riding)
    for (const car of traffic.cars) {
      const c = collideCar(r, carBody(car));
      if (!c) continue;
      // FUN_0044efa0: el que cruza se para 60 ticks; los demás se llevan el impulso.
      if (car.crossing) car.hitTimer = 60;
      else car.v = Math.max(0, (car.vel + c.carDv) * car.dir);
      contacts.push(c);
    }
  for (let a = 0; a < riding.length; a++) {
    for (let k = a + 1; k < riding.length; k++) {
      const c = collideBikes(riding[a], riding[k]);
      if (c) contacts.push(c);
    }
    const r = riding[a], i = stepOf(r.bike.pos);
    const c = collideObjects(r, i, obstaclesFor(r, i));
    if (c) contacts.push(c);
  }
  for (const c of contacts) {
    // [I] Sonido según la fuerza (la cola de FUN_00436830 elige entre los efectos de choque).
    const who = c.bodies[0] as Racer;
    if (c.strength > 0x800) sfx(c.strength > 0x2000 ? "crashmed" : "crashlit", who);
    for (const k of c.crashes) if (!(k.body as Racer).down) startCrash(k.body as Racer, k.anim);
  }
  placeOf = places(racers.map((r) => r.bike.pos), finishedOrder);
  for (const r of riding) {
    const h = resolveAttack(r, riding, tick, level, physics!);
    if (h) onHit(h);
  }
  if (outcome && --outcomeTimer <= 0 && phase === "racing") showResult();
}

// --- Las dos carreteras de una zona doble ----------------------------------------
const roadView: ViewSlice[] = []; // cortes con el desplazamiento del centro (+0xCC) ya sumado
const altView: ViewSlice[] = []; // la otra carretera de la zona doble visible (índices de la ruta alternativa)
let shownRegion: Region | null = null;

/** FUN_00443d70: la segunda carretera = x + separación y su propia pendiente, en los cortes de la zona doble. */
function splitView() {
  const m = route!.main, a = route!.alt;
  roadView.length = altView.length = 0;
  shownRegion = null;
  for (const s of view) {
    roadView.push({ x: s.x + m.offset[s.index], y: s.y, z: s.z, index: s.index });
    const reg = route!.regionAt(s.index);
    if (!reg || (shownRegion && reg !== shownRegion)) continue;
    shownRegion = reg;
    const k = s.index - reg.from;
    altView.push({ x: s.x + reg.shift[k] + a.offset[reg.alt + k], y: s.y + reg.rise[k] - riseBase(reg), z: s.z, index: reg.alt + k });
  }
}

/** Hueco entre las dos carreteras (de arcén a arcén) y el lado de la principal que da a la otra. */
function innerGap(reg: Region, k: number): { side: 0 | 1; half: number } {
  const m = route!.main, a = route!.alt, i = reg.from + k, j = reg.alt + k;
  const mc = m.offset[i], ac = reg.shift[k] + a.offset[j];
  if (ac >= mc) {
    const gap = ac - a.laneL[j] * LANE - a.shoulderL[j] - (mc + m.laneR[i] * LANE + m.shoulderR[i]);
    return { side: 1, half: Math.max(0, gap / 2) };
  }
  const gap = mc - m.laneL[i] * LANE - m.shoulderL[i] - (ac + a.laneR[j] * LANE + a.shoulderR[j]);
  return { side: 0, half: Math.max(0, gap / 2) };
}

/** Región y paso relativo de un índice de la principal o (alt) de la alternativa. */
function regionOf(index: number, alt: boolean): [Region, number] | null {
  if (!alt) {
    const reg = route!.regionAt(index);
    return reg ? [reg, index - reg.from] : null;
  }
  const reg = shownRegion;
  if (!reg || index < reg.alt || index >= reg.alt + reg.shift.length) return null;
  return [reg, index - reg.alt];
}

/** Alcance del terreno del lado que da a la otra carretera: hasta la mitad del hueco. */
function clipInner(index: number, side: 0 | 1, alt: boolean) {
  const r = regionOf(index, alt);
  if (!r) return Infinity;
  const g = innerGap(r[0], r[1]);
  return side === (alt ? 1 - g.side : g.side) ? g.half : Infinity;
}

/** Objetos del lado que da a la otra carretera más allá de la mitad del hueco (caerían sobre ella). */
function hideInner(index: number, x: number, alt: boolean) {
  const r = regionOf(index, alt);
  if (!r) return false;
  const g = innerGap(r[0], r[1]);
  const side = x < 0 ? 0 : 1;
  if (side !== (alt ? 1 - g.side : g.side)) return false;
  const t = alt ? route!.alt : route!.main;
  const edge = side ? t.laneR[index] * LANE + t.shoulderR[index] : t.laneL[index] * LANE + t.shoulderL[index];
  return Math.abs(x) > edge + g.half;
}

/** Carriles y centro de la carretera para el tráfico (en la otra rama, la de la zona doble). */
function carLanes(i: number, branch: number, pos = i * 256 + 128): LaneInfo | null {
  if (!track || i < 0 || i >= track.steps.length) return null;
  if (branch === 1 && !route!.regionAt(i)) return null;
  const { t, idx, center } = laneOf(i, branch, pos);
  return { center, left: t.laneL[idx], right: t.laneR[idx] };
}

/** Un coche como cuerpo de choque (plantilla 0x475698); la posición y el lateral se escriben de vuelta. */
function carBody(car: Car) {
  return {
    get pos() { return car.pos; }, set pos(v: number) { car.pos = v; },
    get lat() { return car.lat; }, set lat(v: number) { car.lat = v; },
    vel: car.vel, prevPos: car.prevPos, prevLat: car.prevLat, ...CAR, halfW: car.halfW,
  };
}

/** Posición en la vista de un punto a `pos` pasos, interpolando entre cortes. */
function viewPoint(pos: number): (ViewSlice & { dx: number }) | null {
  const j = pos - Math.floor(travel);
  const a = Math.floor(j);
  const f = j - a;
  const s0 = view[1 + a], s1 = view[2 + a];
  if (a < 0 || !s0 || !s1) return null;
  return { x: s0.x + (s1.x - s0.x) * f, y: s0.y + (s1.y - s0.y) * f, z: s0.z + (s1.z - s0.z) * f, index: s0.index, dx: s1.x - s0.x };
}

/**
 * Altura de referencia de la otra carretera: FUN_00443d70 arranca las dos desde el corte de la cámara;
 * en la zona de la unión se mantiene la de la unión para que las dos lleguen juntas.
 */
function riseBase(reg: Region) {
  if (reg.kind === "merge") return 0;
  return reg.rise[Math.max(0, Math.min(reg.rise.length - 1, Math.floor(travel) - reg.from))];
}

/** Desplazamiento (altura, dx) de la otra carretera de una zona doble en `pos`, respecto a la principal. */
function altOffset(reg: Region, pos: number): [number, number] {
  const n = reg.rise.length;
  const k = Math.max(0, Math.min(n - 1, Math.floor(pos / 256) - reg.from));
  const k1 = Math.min(n - 1, k + 1);
  return [reg.rise[k] - riseBase(reg), reg.shift[k1] - reg.shift[k]];
}

/**
 * Dibuja un sprite de piloto/moto con su sombra (FUN_00446250) en `pos` (unidades) y `lat` (1/256).
 * `branch` 1: sobre la otra carretera de la zona doble (su altura y su rumbo); 2: no se dibuja.
 */
interface Look { base: number; upp: number; hot: number; flip: boolean }
const RIDER_LOOK: Look = { base: 0, upp: 1 / U, hot: 1, flip: false };
// LOCOP es de baja resolución: 2 unidades por píxel (escala 0x200) y anclajes de 'ANIM' 2 sin doblar.
const COP_LOOK: Look = { base: 0, upp: 2 / U, hot: 0.5, flip: false };

function drawPose(sprite: PoseSprite, shadow: PoseSprite | null, anim: RiderAnimator, pos: number, lat: number, own: number, roll: number, camX: number, branch = 0, look0: Look = RIDER_LOOK) {
  let rel = pos / 256 - travel;
  if (rel < -2) rel += totalLength() / 256;
  const p = viewPoint(travel + rel);
  const visible = !!p && rel > 0.4 && rel < draw - 1 && branch !== 2;
  sprite.mesh.visible = visible;
  if (shadow) shadow.mesh.visible = visible;
  if (!p || !visible) return;
  const reg = branch === 1 ? route!.regionAt(Math.floor(pos / 256)) : null;
  if (reg) {
    const [dy, ddx] = altOffset(reg, pos);
    p.y += dy;
    p.dx += ddx;
  }
  const xw = p.x + lat / 256;
  // FUN_00413ae0: ángulo de vista = rumbo de la carretera − dirección desde la cámara + rumbo propio.
  const road = atan2_8(256, Math.round(p.dx)) << 16;
  const look = atan2_8(Math.max(1, Math.round(p.z)), Math.round(xw - camX)) << 16;
  const view = road - look + own;
  const pose = anim.pose(look0.flip ? -view : view, roll);
  if (!pose) { sprite.mesh.visible = false; if (shadow) shadow.mesh.visible = false; return; }
  const z = -p.z / U;
  shadow?.place(pose.frame, pose.sx, pose.sy, pose.mirror, xw / U, p.y / U, z - 0.02, 1 / U);
  // FUN_0043af60 + FUN_004463e0: el piloto (no la sombra) se dibuja girado alrededor del anclaje por la
  // inclinación que falta respecto a la de su fila; con el rumbo propio por encima de 0xE0000, como mucho
  // ±0x50000. [I] El original resta la inclinación de la fila limitada a ±7 (en unidades de 24 bits, es decir,
  // casi nada) y giraría el sprite la inclinación entera encima de la de la fila; el port resta la de la fila.
  let tilt = pose.lean === null ? roll : roll - pose.lean;
  if (Math.abs(own) > 0xe0000) tilt = Math.max(-0x50000, Math.min(0x50000, tilt));
  sprite.place(look0.base + pose.frame, pose.hx * look0.hot, pose.hy * look0.hot, pose.mirror, xw / U, p.y / U, z, look0.upp, (-tilt / 0x1000000) * 2 * Math.PI);
  if (!aerial) sprite.liftAbove(camera.position, p.y / U);
}

/**
 * Coches (FUN_00446830): sprites de baja resolución a escala 0x500; anclajes del RRAN sin doblar. Los que
 * vienen de frente tienen las vistas de delante, con el ángulo al revés [I].
 */
function drawCars(camX: number) {
  for (const c of traffic.cars) {
    const look: Look = { base: c.model.base, upp: CAR_UNITS_PER_PIXEL / U, hot: 0.5, flip: c.type === ONCOMING };
    // [I] Los que cruzan van de lado: rumbo propio ±90°.
    const own = c.crossing ? (c.type === CROSS_LEFT ? -0x400000 : 0x400000) : 0;
    drawPose(c.sprite, null, c.anim, c.pos, c.lat, own, 0, camX, c.branch, look);
  }
}

/** FUN_0041f220: postes de los semáforos visibles con la luz del semáforo 0 de su cruce. */
function drawSignals() {
  signalSprites.begin();
  const t = track!;
  for (const j of signals.junctions) {
    if (!j.c.lights) continue;
    for (const l of j.lights) {
      if (!l) continue;
      const pos = l.step * 256 + l.fwd;
      const rel = pos / 256 - travel;
      if (rel < 0.4 || rel > draw - 1) continue;
      const p = viewPoint(travel + rel);
      if (!p) continue;
      // Mitad entre el borde del asfalto y el del arcén de su lado, interpolada dentro del paso.
      const mid = (i: number) => {
        const k = Math.min(t.steps.length - 1, i);
        return t.offset[k] + (l.side ? t.laneR[k] * LANE + t.shoulderR[k] / 2 : -t.laneL[k] * LANE - t.shoulderL[k] / 2);
      };
      const x = mid(l.step) + ((mid(l.step + 1) - mid(l.step)) * l.fwd) / 256;
      signalSprites.place((p.x + x) / U, p.y / U, -p.z / U, 2 / U, (l.type & 2) === 0, j.shown);
    }
  }
  signalSprites.end();
}

function drawRacers(camX: number) {
  for (const r of everyone()) {
    const b = r.bike;
    const own = r.crash ? 0 : b.heading; // FUN_004395e0 (+0x5C)
    drawPose(r.sprite, r.shadow, r.anim, b.pos, b.lat, own, r.crash ? 0 : b.roll, camX, r.branch, r.look);
    const onFoot = !!r.crash && r.crash.phase !== "mount";
    if (onFoot) drawPose(r.footSprite, r.footShadow, r.foot, r.crash!.pos, r.crash!.lat, 0, 0, camX, r.branch, r.look);
    else r.footSprite.mesh.visible = r.footShadow.mesh.visible = false;
  }
}

/** Efecto con volumen y panorámica según la distancia al jugador (FUN_00434db0). */
function sfx(name: string, r: Racer) {
  if (!audioStarted || !player) return;
  const vol = r === player ? 0.9 : Math.min(0.9, engineVolume(r.bike.pos - player.bike.pos) * 2);
  const pan = Math.max(-1, Math.min(1, (r.bike.latUnits - player.bike.latUnits) / 1500));
  if (vol > 0.02) audio.play(name, vol, pan);
}

function soundTick() {
  if (!audioStarted || !player) return;
  // Sirena (FUN_00407bd0 → FUN_00436830(0x13, posición, velocidad) mientras va montado; FUN_00403d60 la corta
  // al caer). [I] SIREN en bucle con el volumen y el doppler de un motor; SIRENFST no se usa.
  if (siren && physics) {
    const rate = physics.engines.SIREN * 2;
    if (!cop || cop.crash || cop.branch === 2) siren.update(rate, 0);
    else {
      const doppler = Math.trunc(0x13b0000 / (0x13b00 - (cop.bike.v - player.bike.v)));
      const pan = Math.max(-1, Math.min(1, (cop.bike.latUnits - player.bike.latUnits) / 1500));
      siren.update(rate, Math.min(0.8, engineVolume(cop.bike.pos - player.bike.pos) * 0.8), pan, doppler);
    }
  }
  for (const r of everyone()) {
    if (!r.engine) continue;
    // [I] Sin piloto encima el motor se apaga: se oye bajar de vueltas y se silencia hasta volver a montar
    // (el original lo deja al ralentí).
    const off = r.branch === 2 ? 0 : r.crash && r.crash.phase !== "mount" ? Math.min(1, (r.bike.rpm - 0x2000) / 0x3000) : 1;
    if (off === 0) { r.engine.update(r.bike.rpm, 0); continue; }
    if (r === player) {
      // Parado 60 %; baja de forma lineal hasta 22 % a partir de 40 mph.
      const k = Math.min(1, r.bike.mph / 40);
      r.engine.update(r.bike.rpm, (0.6 + (0.22 - 0.6) * k) * off);
    }
    else {
      const d = r.bike.pos - player.bike.pos;
      const doppler = Math.trunc(0x13b0000 / (0x13b00 - (r.bike.v - player.bike.v)));
      const pan = Math.max(-1, Math.min(1, (r.bike.latUnits - player.bike.latUnits) / 1500));
      r.engine.update(r.bike.rpm, engineVolume(d) * 0.15 * off, pan, doppler);
    }
  }
  // FUN_00435090: el coche más cercano suena con ENGCAR11 a 0x3B·doppler Hz y volumen cercanía·0x4FFF/0x6400
  // (1,22 veces el de una moto a la misma distancia).
  if (carEngine) {
    let near: Car | null = null;
    for (const c of traffic.cars) if (!near || Math.abs(c.pos - player.bike.pos) < Math.abs(near.pos - player.bike.pos)) near = c;
    if (!near) carEngine.update(0x3b << 9, 0);
    else {
      const doppler = Math.trunc(0x13b0000 / (0x13b00 - (near.vel - player.bike.v)));
      const pan = Math.max(-1, Math.min(1, (near.lat - player.bike.lat) / 256 / 1500));
      carEngine.update(0x3b << 9, engineVolume(near.pos - player.bike.pos) * 0.15 * 1.22, pan, doppler);
    }
  }
}

const EFFECTS = ["punchhea", "kick_mw4", "clubimpa", "chainimp", "swishgen", "swishcha", "crashhar", "crashmed", "crashlit", "m_yeah"];
let playerEngine = "";
function attachEngines() {
  for (const r of everyone()) r.engine = audio.engine(r === player ? playerEngine : "ENGOTHER");
  carEngine ??= audio.engine("ENGCAR11");
  if (cop) siren ??= audio.engine("SIREN");
}

async function startAudio(manifest: { audio: string[] }) {
  if (audioStarted || !physics) return;
  audioStarted = true;
  await audio.resume();
  const cls = PLAYER_BIKE < 5 ? "ENGRAT" : PLAYER_BIKE < 10 ? "ENGSPORT" : "ENGSUPER";
  playerEngine = cls;
  await audio.loadEngine(cls, `/audio/effects/${cls.toLowerCase()}.wav`, physics.engines[cls]);
  await audio.loadEngine("ENGOTHER", "/audio/effects/engother.wav", physics.engines.ENGOTHER);
  if (physics.engines.ENGCAR11) await audio.loadEngine("ENGCAR11", "/audio/effects/engcar11.wav", physics.engines.ENGCAR11);
  if (physics.engines.SIREN) await audio.loadEngine("SIREN", "/audio/effects/siren.wav", physics.engines.SIREN);
  await Promise.all(EFFECTS.map((e) => audio.loadEffect(e, `/audio/effects/${e}.wav`)));
  attachEngines();
  audio.setTracks(manifest.audio.filter((u) => u.includes("/audio/music/")));
}

/** Música de los menús: las canciones de la máquina de discos (FUN_00403040). */
function menuMusic() {
  if (!audioStarted) return;
  const name = audio.menuMusic();
  if (name) $("music").textContent = name;
}

let raceSong = 0; // circuito 0-4 (0x467aa0) → SbkGrng1-5 con Grunge1-5.SBK
/** FUN_00435da0 → FUN_00433bb0: MIDI del circuito con RRDRUMS.SBK (banco 1) y Grunge%d.SBK (banco 2). */
function raceMusic(k = raceSong) {
  if (!audioStarted) return;
  raceSong = k;
  const n = k + 1;
  void audio.raceMusic(`/audio/music/sbkgrng${n}.mid`, [[1, "/audio/music/rrdrums.sf2"], [2, `/audio/music/grunge${n}.sf2`]])
    .then((name) => { if (name) $("music").textContent = name; });
}
const courseSong = () => Math.max(0, THRASH_COURSES.findIndex((c) => c.name === currentEntry?.name));

/** Silencia motores y sirena (al volver al menú el bucle de la carrera deja de actualizarlos). */
function muteAll() {
  for (const r of everyone()) r.engine?.update(r.bike.rpm, 0);
  carEngine?.update(0x3b << 9, 0);
  siren?.update(0x1000, 0);
}

// --- Pantallas de la carrera ----------------------------------------------------
let bannerTimer = 0;
function banner(text: string, seconds = 0) {
  const el = $("banner");
  el.textContent = text;
  el.style.display = text ? "block" : "none";
  bannerTimer = seconds ? performance.now() + seconds * 1000 : 0;
}

/** FUN_00416120 → FUN_00449150: vídeo (o imagen) de victoria, derrota o moto destrozada. */
function showResult() {
  phase = "over";
  const place = placeOf[0];
  const { video, image } = resultMedia(outcome!, mediaRef.videos, mediaRef.images);
  const box = $("result");
  box.querySelectorAll("video, img").forEach((e) => e.remove());
  const caption = box.querySelector(".caption")!;
  // Títulos de las pantallas 0x1C-0x1F (cadenas 0xB0-0xB3) y su texto (0xC0 destrozado, 0xC3 detenido).
  const s = (id: number) => strings[id] ?? "";
  caption.textContent =
    outcome === "wreck" ? `${s(0xb0)} ${s(0xc0)}`
    : outcome === "busted" ? `${s(0xb1)} ${s(0xc3)}`
    : `${outcome === "win" ? s(0xb2) : s(0xb3)} · ${place}º de ${racers.length}`;
  const hint = " · Enter: menú · R: repetir";
  if (video) {
    const v = document.createElement("video");
    v.src = video;
    v.autoplay = true;
    // Al acabar, o al saltarlo (clic o cualquier otra tecla), queda la imagen del resultado (pantallas 0x1C-0x1F).
    const end = () => {
      if (!v.isConnected) return;
      v.pause();
      v.remove();
      skipResult = null;
      if (image) { const img = document.createElement("img"); img.src = image; box.prepend(img); }
      caption.textContent += hint;
    };
    skipResult = end;
    v.addEventListener("ended", end);
    v.addEventListener("pointerdown", end);
    box.prepend(v);
    audio.stopMusic();
  } else if (image) {
    const img = document.createElement("img");
    img.src = image;
    box.prepend(img);
    caption.textContent += hint;
  }
  box.style.display = "grid";
  banner("");
}
let skipResult: (() => void) | null = null; // salta el vídeo del resultado
function hideResult() {
  skipResult = null;
  const box = $("result");
  box.querySelectorAll("video").forEach((v) => v.pause());
  box.style.display = "none";
}

// --- Estado ---------------------------------------------------------------------
let course: CourseJson | null = null;
let courseTitle = "";
const view: ViewSlice[] = [];
let travel = 0; // posición de la cámara, en pasos
let paused = false;
let aerial = false;
let draw = DRAW_ORIGINAL;
let accumulator = 0;
let manifestRef: { audio: string[] } = { audio: [] };
const mediaRef: { videos: string[]; images: string[] } = { videos: [], images: [] };

addEventListener("keydown", (e) => {
  if (menu?.key(e)) { e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (k === "enter" || k === " ") e.preventDefault();
  startAudio(manifestRef);
  if (phase === "over") {
    if (k === "r") { grid(); raceMusic(courseSong()); }
    else if (k === "enter" || k === "escape") backToMenu();
    else if (!e.repeat) skipResult?.();
    return;
  }
  if (paused && k === "q") { backToMenu(); return; }
  if (k === "h") { const h = $("hud"); h.style.display = h.style.display === "none" ? "" : "none"; }
  keys.add(k);
  if (!e.repeat) {
    // FUN_00434660: Enter = patada (tipo 3); Insert / 0 = arma; Espacio = arma, variante revés.
    if (k === "enter") attackQueue.push({ type: KICK, backhand: false });
    else if (k === "insert" || (k === "0" && e.location === 3)) attackQueue.push({ type: player?.fight.weapon ?? 0, backhand: false });
    else if (k === " ") attackQueue.push({ type: player?.fight.weapon ?? 0, backhand: true });
  }
  if (phase === "grid" && (k === "w" || k === "arrowup")) { phase = "racing"; banner(""); }
  if (k === "p" || k === "escape") { paused = !paused; banner(paused ? "Pausa · Q: menú" : ""); }
  if (k === "m") aerial = !aerial;
  if (k === "r") grid();
  if (k === "v") draw = draw === DRAW_ORIGINAL ? DRAW_EXTENDED : DRAW_ORIGINAL;
  if (k === "c") showDash = !showDash;
  if (k === "n" && audioStarted) raceMusic((raceSong + 1) % 5); // [I] en carrera, N pasa al MIDI de otro circuito
  if (k === "b" && audioStarted) audio.toggleMusic();
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

interface CourseEntry { name: string; title: string; horizon: string; file: string; segments: number; steps: number }
let sprites: SpriteManifest | null = null;
let currentEntry: CourseEntry | null = null;
let menu: Menu | null = null;
let strings: Record<string, string> = {}; // tabla de cadenas de la DLL de idioma (assets/data/strings.json)

/** Fin de la carrera (o salir desde la pausa): de vuelta a la pantalla de circuitos del Modo Caña. */
function backToMenu() {
  if (!menu) return;
  paused = false;
  phase = "over";
  removeCop();
  hideResult();
  banner("");
  muteAll();
  audio.stopMusic();
  menu.thrash(menu.lastCourse);
}

async function loadCourse(entry: CourseEntry) {
  currentEntry = entry;
  courseTitle = entry.title;
  course = (await (await fetch(entry.file)).json()) as CourseJson;
  route = new Route(course);
  track = route.main;
  finishPos = finishStep(course, track, level) * 256;
  grid();
  if (!sprites) return;
  asphalt?.setCourse(track);
  altAsphalt?.setCourse(route.alt);
  // Circuito nuevo: fuera las texturas y familias del anterior (se conservan solo al cambiar de rama).
  for (const r of [roadside, altRoadside, terrain, altTerrain, buildings, altBuildings]) r.reset();
  await Promise.all([
    roadside.setCourse(buildObjects(course, track), sprites.families),
    altRoadside.setCourse(buildObjects(course, route.alt), sprites.families),
    terrain.setCourse(track, familySlots(course, track), sprites.families),
    altTerrain.setCourse(route.alt, familySlots(course, route.alt), sprites.families),
    buildings.setCourse(track, familySlots(course, track), sprites.families, sprites.roof),
    altBuildings.setCourse(route.alt, familySlots(course, route.alt), sprites.families, sprites.roof),
  ]);
  await loadCars(entry.name);
  const tex = await pixelTexture(sprites.horizons[entry.horizon]);
  tex.wrapS = THREE.RepeatWrapping;
  const old = (horizon.material as THREE.MeshBasicMaterial).map;
  (horizon.material as THREE.MeshBasicMaterial).map = tex;
  (horizon.material as THREE.MeshBasicMaterial).needsUpdate = true;
  old?.dispose();
  horizon.visible = true;
  const img = tex.image as HTMLImageElement | ImageBitmap;
  const c = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
  c.drawImage(img, 0, 0);
  const top = c.getImageData(0, 0, 1, 1).data, bottom = c.getImageData(0, img.height - 1, 1, 1).data;
  sky.setRGB(top[0] / 255, top[1] / 255, top[2] / 255, THREE.SRGBColorSpace);
  fog.color.setRGB(bottom[0] / 255, bottom[1] / 255, bottom[2] / 255, THREE.SRGBColorSpace);
  (horizonFill.material as THREE.MeshBasicMaterial).color.copy(fog.color);
  renderer.setClearColor(sky);
  layoutOverlays();
  sea.visible = entry.horizon === "PCH";
  if (sea.visible && !(sea.material as THREE.MeshBasicMaterial).map && sprites.global.SEA128) {
    const water = await pixelTexture(sprites.global.SEA128);
    water.wrapS = water.wrapT = THREE.RepeatWrapping;
    water.repeat.set(4000 / 16, 1500 / 4);
    (sea.material as THREE.MeshBasicMaterial).map = water;
    (sea.material as THREE.MeshBasicMaterial).needsUpdate = true;
  }
}

/** Coches del circuito (DATA/CARS/<circuito>.CAR, importer/cars.ts). */
async function loadCars(name: string) {
  const base = sprites?.cars[name];
  traffic.clear();
  if (!base) return;
  try {
    const [tex, atlas, models] = await Promise.all([
      pixelTexture(`${base}.png`),
      loadAtlas(`${base}.json`),
      fetch(`${base}_models.json`).then((r) => r.json() as Promise<CarModel[]>),
    ]);
    traffic.setModels(models, tex, atlas);
  } catch {
    console.warn("Faltan los coches: vuelve a ejecutar npm run import");
  }
}

let last = performance.now();
/** Tiempos del último fotograma (ms) para depurar el rendimiento (`rr.stats`). */
const stats = { sim: 0, scene: 0, render: 0, frame: 0, meshes: 0, calls: 0 };

function frame(now: number) {
  const t0 = performance.now();
  stats.frame = now - last;
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (menu?.visible) return; // en los menús no corre la carrera
  if (!course || !track || track.steps.length < 2 || !player) return;
  const steps = track.steps;
  if (bannerTimer && now > bannerTimer) banner("");

  if (!paused) {
    accumulator += dt;
    while (accumulator >= TICK) { simulate(); accumulator -= TICK; }
  }
  soundTick();
  const t1 = performance.now();
  stats.sim = t1 - t0;

  // Cámara un corte detrás del jugador (FUN_00437c30).
  const prevTravel = travel;
  travel = Math.max(0, player.bike.pos / 256 - 1);
  const dSteps = travel >= prevTravel ? travel - prevTravel : 0;
  const L = player.bike.latUnits;
  let camX = L * 0.75;
  if (L - camX > 200) camX = L - 200;
  if (camX - L > 200) camX = L + 200;
  // Antes de dibujar los pilotos: liftAbove los acerca a esta cámara.
  camera.position.set(camX / U, CAM_HEIGHT / U, -256 / U);

  buildView(steps, travel, draw, view);
  splitView();
  for (const r of ribbons) r.update(roadView);
  for (const r of altRibbons) r.update(altView);
  asphalt?.update(roadView);
  altAsphalt?.update(altView);
  // La calle que cruza corta el terreno y los edificios (FUN_0043bef0 la dibuja en vez de la acera).
  terrain.update(roadView, (i, side) => (track!.cross[i] & 0x20 ? 0 : clipInner(i, side, false)));
  if (crossStreets) crossStreets.update(roadView, track!);
  // [I] En una zona doble, sin edificios en el lado que da a la otra carretera mientras están cerca.
  buildings.update(roadView, (i, side) => clipInner(i, side, false) < 4000);
  altBuildings.update(altView, (a, side) => clipInner(a, side, true) < 4000);
  altTerrain.update(altView, (a, side) => clipInner(a, side, true));
  roadside.update(roadView, (i, x) => (track!.cross[i] & 0x20 ? Math.abs(x) > (x < 0 ? track!.laneL[i] : track!.laneR[i]) * LANE : hideInner(i, x, false)));
  altRoadside.update(altView, (a, x) => hideInner(a, x, true));
  drawRacers(camX);
  drawCars(camX);
  drawSignals();
  fog.near = draw === DRAW_ORIGINAL ? 1e6 : (draw - 30) * 4;
  fog.far = draw === DRAW_ORIGINAL ? 2e6 : draw * 4;
  const i0 = Math.floor(travel);
  horizonScroll += steps[i0].curve * dSteps * (720 / (2 * Math.PI)) / 256;
  const hmap = (horizon.material as THREE.MeshBasicMaterial).map;
  if (hmap) hmap.offset.x = horizonScroll / 720;
  const far = view[view.length - 1];
  if (far && far.z > 300) {
    const yInternal = HORIZON_TOP + ((CAM_HEIGHT - far.y) * FOCAL) / (far.z - 256);
    horizon.position.y = innerHeight * (1 - Math.min(Math.max(yInternal, 40), 200) / SCREEN_H);
  }
  horizonFill.scale.set(innerWidth, Math.max(1, horizon.position.y), 1);
  dash.visible = showDash && !aerial;
  hud.visible = dash.visible;
  sea.scale.set(4000, 1, 1500);

  if (aerial) {
    aerialCam.position.set(camX / U, 60, 40);
    aerialCam.lookAt(camX / U, 0, -120);
  }

  const s = steps[i0];
  const b = player.bike;
  const place = placeOf[0] ?? 1;
  hud.draw({
    place,
    v: b.v,
    rpm: b.rpm,
    odometer: b.pos,
    rider: player.fight.healthBar,
    bike: player.fight.bikeBar,
    rival: rival ? { name: rival.name, bar: rival.fight.healthBar } : null,
  });
  $("seg").textContent = `${s.segment}`;
  $("step").textContent = `${s.step} / ${course.segments[s.segment].length}`;
  $("curve").textContent = `marcha ${b.gear + 1} · ${Math.round(b.rpm / 655.35)} % rpm · ${["asfalto", "acera", "tierra", "fuera"][b.surface]}`;
  $("speed").textContent = `${b.mph} mph · ${Math.round(b.mph * 1.609)} km/h${paused ? " (pausa)" : ""}`;
  $("place").textContent = `${place}º de ${racers.length}`;
  $("finish").textContent = player.finished ? "cruzada" : `${Math.max(0, Math.round((finishPos - b.pos) / 256))} pasos`;
  $("draw").textContent = draw === DRAW_ORIGINAL ? "33 cortes (original)" : `${draw} cortes (ampliada)`;
  renderer.clear();
  if (!aerial) {
    renderer.render(bgScene, hudCam);
    renderer.clearDepth();
  }
  const t2 = performance.now();
  stats.scene = t2 - t1;
  renderer.render(scene, aerial ? aerialCam : camera);
  stats.calls = renderer.info.render.drawCalls;
  renderer.clearDepth();
  renderer.render(hudScene, hudCam);
  stats.render = performance.now() - t2;
}

async function start() {
  await renderer.init();
  const backend = (renderer as unknown as { backend: { isWebGPUBackend?: boolean } }).backend;
  $("backend").textContent = backend.isWebGPUBackend ? "WebGPU" : "WebGL2 (respaldo)";

  let manifest: { courses: CourseEntry[]; sprites?: SpriteManifest; physics?: string; audio: string[]; images: string[]; videos: string[]; font?: string; menuFonts?: Record<string, string>; strings?: string };
  try {
    manifest = await (await fetch("/manifest.json")).json();
  } catch {
    $("error").style.display = "grid";
    return;
  }
  manifestRef = manifest;
  mediaRef.videos = manifest.videos ?? [];
  mediaRef.images = manifest.images ?? [];
  sprites = manifest.sprites ?? null;
  if (!sprites || !manifest.physics) { $("error").style.display = "grid"; return; }
  strings = manifest.strings ? await (await fetch(manifest.strings)).json() : {};
  // Presentación (SPLASH.RRI) mientras carga; luego Intro y la pantalla principal (src/menu.ts).
  menu = new Menu($("menu"), {
    strings,
    images: mediaRef.images,
    videos: mediaRef.videos,
    miles: [],
    fonts: { badloc: manifest.font, ...manifest.menuFonts },
  });
  menu.splash(strings[0xce] ?? "");
  physics = (await (await fetch(manifest.physics)).json()) as PhysicsData;
  if (!physics.grid) { $("error").style.display = "grid"; return; }
  menu.data.miles = physics.courseMiles ?? [];
  // FUN_00441940: PLAIN, WHITE y YELLOW = 'CEL ' 1, 2 y 3 de GLOBAL.RSC; START160, START162 y PLAIN (4-6)
  // para las intersecciones.
  const cels = [1, 2, 3, 4, 5, 6].map((id) => sprites!.global[`CEL ${id}`]);
  if (cels.every(Boolean)) { asphalt = new Asphalt(scene, U, cels); altAsphalt = new Asphalt(scene, U, cels); }
  else console.warn("Faltan las texturas del asfalto: vuelve a ejecutar npm run import");
  // Intersecciones: SIDCRSS0, SIDLANE0/1 (CEL 7-9) y semáforo STOP3E/G/Y/R (CEL 11-14).
  const cel = (id: number) => sprites!.global[`CEL ${id}`];
  if ([7, 8, 9, 11, 12, 13, 14].every((id) => cel(id))) {
    crossStreets = new CrossStreets(scene, U, { crosswalk: cel(7), lanes: [cel(8), cel(9)] });
    await signalSprites.load(cel(11), [cel(12), cel(13), cel(14)]);
  }
  riderAnims = (await (await fetch(sprites.riders.anims)).json()) as RiderAnims;
  riderAtlas = await loadAtlas(sprites.riders.frames);
  shadowAtlas = await loadAtlas(`${sprites.riders.shadow}.json`);
  shadowTexture = await pixelTexture(`${sprites.riders.shadow}.png`);
  for (const url of sprites.riders.textures) riderTextures.push(await pixelTexture(url));
  if (sprites.riders.copAnims) {
    copAnims = (await (await fetch(sprites.riders.copAnims)).json()) as RiderAnims;
    copAtlas = await loadAtlas(`${sprites.riders.cop}.json`);
    copTexture = await pixelTexture(`${sprites.riders.cop}.png`);
    copShadowAtlas = await loadAtlas(`${sprites.riders.copShadow}.json`);
    copShadowTexture = await pixelTexture(`${sprites.riders.copShadow}.png`);
  } else console.warn("Falta el policía: vuelve a ejecutar npm run import");
  const dashTex = await pixelTexture(sprites.dashboards.SPORT);
  (dash.material as THREE.MeshBasicMaterial).map = dashTex;
  (dash.material as THREE.MeshBasicMaterial).needsUpdate = true;
  dash.visible = true;
  await hud.load(sprites.meter, manifest.font);

  buildRacers();
  layoutOverlays();
  renderer.setAnimationLoop(frame);

  // Modo Caña: el nivel sale de Lavabos ("Nivel del Jugador"); el circuito, de la pantalla de circuitos.
  menu.level = level;
  menu.onLevel = (l) => { level = l; buildRacers(); };
  menu.onPick = async (k) => {
    const entry = manifest.courses.find((c) => c.name === THRASH_COURSES[k].name) ?? manifest.courses[0];
    await loadCourse(entry);
    menu!.hide();
    layoutOverlays();
    raceMusic(courseSong());
  };
  menu.onScreen = menuMusic;
  menu.onVideo = () => audio.stopMusic();
  // [I] El navegador no deja sonar nada sin una pulsación: se pide antes de la Intro.
  await menu.waitInput("Pulsa una tecla");
  await startAudio(manifest);
  await menu.playIntro();
  menu.main();
  menuMusic();
}

start().catch((e) => console.error("start", e));
// Depuración desde la consola del navegador.
(globalThis as unknown as { rr: unknown }).rr = {
  racers,
  view,
  camera,
  get travel() { return travel; },
  get race() { return { phase, tick, finishPos, finishedOrder, outcome, places: placeOf, level }; },
  start() { phase = "racing"; banner(""); },
  attack(type = KICK, backhand = false) { attackQueue.push({ type, backhand }); },
  obstacles: (step: number) => roadside.obstacles(step),
  get route() { return route; },
  stats,
  /** Ejecuta `n` fotogramas seguidos y devuelve la media de los tiempos (ms) de `stats`. */
  bench(n = 60) {
    const acc = { sim: 0, scene: 0, render: 0 };
    for (let k = 0; k < n; k++) {
      frame(performance.now());
      acc.sim += stats.sim; acc.scene += stats.scene; acc.render += stats.render;
    }
    return { sim: +(acc.sim / n).toFixed(2), scene: +(acc.scene / n).toFixed(2), render: +(acc.render / n).toFixed(2), calls: stats.calls };
  },
  /** Mallas visibles de la escena por tipo de material/geometría (para el rendimiento). */
  meshes() {
    let n = 0, visible = 0;
    scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) { n++; if (o.visible) visible++; } });
    return { n, visible };
  },
  traffic,
  signals,
  get menu() { return menu; },
  audio,
  get cop() { return cop; },
  /** Hace salir al policía a `d` unidades del jugador (por defecto, donde lo pone el original). */
  spawnCop(d = -0x2700) { spawnCop(Math.max(128, player!.bike.pos + d)); return cop; },
  /** Lleva al jugador al paso `step` con lateral `lat` (unidades), p. ej. antes de una bifurcación. */
  goto(step: number, lat = 0) {
    const b = player!.bike;
    b.pos = player!.prevPos = step * 256 + 128;
    b.lat = player!.prevLat = lat * 256;
  },
  /** Avanza `n` ticks de 60 Hz con las teclas indicadas (p. ej. rr.sim(300, "w")). */
  sim(n: number, held = "") {
    const saved = new Set(keys);
    keys.clear();
    for (const k of held) keys.add(k);
    for (let i = 0; i < n; i++) simulate();
    keys.clear();
    for (const k of saved) keys.add(k);
  },
};

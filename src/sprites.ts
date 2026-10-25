// Carga del arte original exportado por el importador (atlas PNG + JSON) para Three.js.
import * as THREE from "three/webgpu";

export interface AtlasFrame { name: string; x: number; y: number; w: number; h: number }
export interface Atlas { width: number; height: number; frames: AtlasFrame[] }

export interface SpriteManifest {
  riders: { frames: string; textures: string[]; shadow: string; cop: string; copShadow: string; anims: string; copAnims: string };
  families: Record<string, { atlas: string; objects: number; terrain: (string | null)[][]; heights?: number[]; sidewalk?: (string | null)[][] }>;
  roof?: string;
  global: Record<string, string>;
  cars: Record<string, string>;
  horizons: Record<string, string>;
  dashboards: Record<string, string>;
  meter: string;
  clouds: string[];
}

const loader = new THREE.TextureLoader();

/** Textura de pixel art: sin filtrado ni mipmaps, en sRGB. */
export async function pixelTexture(url: string): Promise<THREE.Texture> {
  const t = await loader.loadAsync(url);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const loadAtlas = async (url: string) => (await (await fetch(url)).json()) as Atlas;

/**
 * Sprite con anclaje: el píxel (hx, hy) del fotograma se apoya en la posición de la malla (FUN_0044ba40);
 * en espejo se invierte alrededor del anclaje.
 */
export class PoseSprite {
  readonly mesh: THREE.Mesh;
  private texture: THREE.Texture;
  private atlas: Atlas;
  constructor(texture: THREE.Texture, atlas: Atlas) {
    this.atlas = atlas;
    this.texture = texture.clone();
    this.texture.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, alphaTest: 0.5, depthWrite: true });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, -0.5, 0), mat); // origen arriba-izquierda
    this.mesh.frustumCulled = false;
  }
  setTexture(texture: THREE.Texture) {
    const t = texture.clone();
    t.needsUpdate = true;
    t.repeat.copy(this.texture.repeat);
    t.offset.copy(this.texture.offset);
    (this.mesh.material as THREE.MeshBasicMaterial).map = t;
    this.texture = t;
  }
  /**
   * Coloca el fotograma con su anclaje en (x, y, z); `upp` = unidades de escena por píxel; `rot` = giro en
   * radianes alrededor del anclaje (positivo, antihorario), como el dibujo rotado de FUN_00450ad0.
   */
  place(frame: number, hx: number, hy: number, mirror: boolean, x: number, y: number, z: number, upp: number, rot = 0) {
    const f = this.atlas.frames[frame];
    if (!f || !f.w) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const W = this.atlas.width, H = this.atlas.height;
    this.texture.repeat.set((mirror ? -f.w : f.w) / W, f.h / H);
    this.texture.offset.set((mirror ? f.x + f.w : f.x) / W, 1 - (f.y + f.h) / H);
    const left = mirror ? x - (f.w - hx) * upp : x - hx * upp;
    const dx = left - x, dy = hy * upp, c = Math.cos(rot), s = Math.sin(rot);
    this.mesh.position.set(x + dx * c - dy * s, y + dx * s + dy * c, z);
    this.mesh.rotation.z = rot;
    this.mesh.scale.set(f.w * upp, f.h * upp, 1);
  }

  /**
   * El original pinta sin profundidad y el dibujo cuelga por debajo del punto de apoyo (la rueda llega unos
   * 20 píxeles más abajo): con prueba de profundidad, la carretera de delante tapaba esa parte. Acerca el plano a
   * la cámara y lo escala en proporción (en pantalla queda igual) hasta que su borde inferior quede sobre el suelo
   * `groundY` (unidades de escena).
   */
  liftAbove(cam: THREE.Vector3, groundY: number) {
    const m = this.mesh;
    if (!m.visible) return;
    const c = Math.cos(m.rotation.z), s = Math.sin(m.rotation.z);
    // Esquinas inferiores (el origen de la malla es la esquina superior izquierda).
    const w = m.scale.x, h = m.scale.y;
    const bottom = Math.min(m.position.y - h * c, m.position.y + w * s - h * c);
    if (bottom >= groundY || cam.y <= groundY) return;
    const k = ((cam.y - groundY) / (cam.y - bottom)) * 0.995;
    m.position.sub(cam).multiplyScalar(k).add(cam);
    m.scale.multiplyScalar(k);
  }
}

/** Sprite plano (mira a +z; la cámara del motor no rota) con un fotograma de un atlas. */
export class AtlasSprite {
  readonly mesh: THREE.Mesh;
  private texture: THREE.Texture;
  private atlas: Atlas;
  constructor(texture: THREE.Texture, atlas: Atlas) {
    this.atlas = atlas;
    this.texture = texture.clone(); // comparte la imagen; offset/repeat propios
    this.texture.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, alphaTest: 0.5, depthWrite: true });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), mat);
    this.mesh.frustumCulled = false;
  }
  /** Muestra el fotograma `index` con `unitsPerPixel` (unidades de mundo por píxel del sprite). */
  setFrame(index: number, unitsPerPixel: number) {
    const f = this.atlas.frames[index];
    this.texture.repeat.set(f.w / this.atlas.width, f.h / this.atlas.height);
    this.texture.offset.set(f.x / this.atlas.width, 1 - (f.y + f.h) / this.atlas.height);
    this.mesh.scale.set(f.w * unitsPerPixel, f.h * unitsPerPixel, 1);
  }
}

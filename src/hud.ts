// HUD del tablero, como FUN_00446c30 (alta resolución, tablero completo: bloque 0x475108 de la tabla
// 0x474f50), en 640×480 escalado igual que el tablero.
//
//   Orden del original: primero las barras (FUN_0044ca50), luego el tablero con color clave encima
//   (FUN_0044c9c0), así que las barras solo se ven por sus huecos; después agujas y textos (GDI).
//   Por eso hay dos capas: `under` (detrás del tablero) y `over` (delante).
//
//   Texto: fuente "Badloc" (TEXT/BADLOC.DLL) de 32 px; primero en negro desplazado 2 px y luego en color
//   (FUN_00447b20).
//   Puesto (FUN_00446a80): centrado en (16, 399)–(640, 480).
//   Cuentakilómetros (FUN_00446a40): "%02d.%d" alineado a la derecha en x = 345, y = 452;
//     millas·10 = (avance/256 − 50)/33.
//   Agujas (FUN_004468e0, FUN_004468a0): velocímetro en (250, 449) de 44×28,
//     cuentarrevoluciones en (388, 441) de 28×20; ángulo en 0x1000 por vuelta (0 = arriba);
//     pluma de 3 px en 0x081172 (BGR).
//   Barras (FUN_0044ca50, hoja BIGMETER.BOB): piloto en (134, 424) y rival en (456, 424) en vertical,
//     moto en (292, 380) en horizontal; valor 0-31 (FUN_00446b00 / FUN_00446b40 / FUN_00446b80).
//     La del rival se dibuja siempre en el tablero completo (vacía si no hay rival), con su nombre en
//     (472, 446).

import * as THREE from "three/webgpu";

const W = 640, H = 480;
const SS = 2; // supermuestreo del lienzo: agujas y texto más limpios al escalar

export interface HudState {
  place: number;
  v: number; // velocidad (+0xEC)
  rpm: number; // +0x2DC
  odometer: number; // avance desde la salida, en unidades
  rider: number; // 0-31
  bike: number; // 0-31
  rival: { name: string; bar: number } | null;
}

class Layer {
  readonly mesh: THREE.Mesh;
  readonly ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  constructor(order: number) {
    const canvas = document.createElement("canvas");
    canvas.width = W * SS;
    canvas.height = H * SS;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.scale(SS, SS);
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = order;
  }
  clear() { this.ctx.clearRect(0, 0, W, H); }
  commit() { this.texture.needsUpdate = true; }
}

export class Hud {
  /** Detrás del tablero (barras) y delante (agujas y textos). */
  readonly under = new Layer(-1);
  readonly over = new Layer(10);
  private meter: HTMLImageElement | null = null;
  private last = "";

  async load(meterUrl: string, fontUrl?: string) {
    if (fontUrl) {
      try {
        const face = new FontFace("Badloc", `url(${fontUrl})`);
        document.fonts.add(await face.load());
      } catch { /* sin la fuente se usa la del sistema */ }
    }
    const img = new Image();
    // `onload` y no `decode()`: decode puede quedarse sin resolver en pestañas en segundo plano.
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = meterUrl; });
    this.meter = img;
  }

  set visible(v: boolean) { this.under.mesh.visible = this.over.mesh.visible = v; }

  /** Coloca el lienzo de 640×480 escalado como el tablero (alto de pantalla = 480). */
  layout(viewW: number, viewH: number) {
    const s = viewH / H;
    for (const l of [this.under, this.over]) {
      l.mesh.position.set((viewW - W * s) / 2, 0, 0);
      l.mesh.scale.set(W * s, H * s, 1);
    }
  }

  draw(st: HudState) {
    const key = JSON.stringify(st);
    if (key === this.last) return;
    this.last = key;
    // Barras (por los huecos del tablero).
    const u = this.under.ctx;
    this.under.clear();
    if (this.meter) {
      vbar(u, this.meter, 134, 424, st.rider);
      hbar(u, this.meter, 292, 380, st.bike);
      vbar(u, this.meter, 456, 424, st.rival?.bar ?? 0);
    }
    this.under.commit();
    // Agujas y textos.
    const c = this.over.ctx;
    this.over.clear();
    const speedAngle = wrap(Math.trunc((((st.v & ~0x1ff) * 4) + ((st.v & ~0x7f) * 16) + ((st.v & 0xfffff001) >> 1)) / 200) - 0x400);
    const rpmAngle = wrap(Math.trunc(st.rpm / 0x2c) - 0x400);
    needle(c, 250, 449, 44, 28, speedAngle);
    needle(c, 388, 441, 28, 20, rpmAngle);
    c.font = "32px Badloc, Impact, sans-serif";
    c.textBaseline = "top";
    text(c, String(st.place), 328, 399, "center");
    const tenths = Math.max(0, Math.trunc((st.odometer / 256 - 50) / 33));
    text(c, `${String(Math.trunc(tenths / 10)).padStart(2, "0")}.${tenths % 10}`, 345, 452, "right");
    if (st.rival?.name) text(c, st.rival.name, 472, 446, "left");
    this.over.commit();
  }
}

const wrap = (a: number) => (a < 0 ? a + 0x1000 : a) & 0xfff;

function needle(c: CanvasRenderingContext2D, x: number, y: number, lx: number, ly: number, a: number) {
  const r = (a / 0x1000) * 2 * Math.PI; // FUN_0044f510: x = sen, y = cos
  c.strokeStyle = "#721108";
  c.lineWidth = 3;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x + Math.sin(r) * lx, y - Math.cos(r) * ly);
  c.stroke();
}

/** FUN_00447b20 */
function text(c: CanvasRenderingContext2D, s: string, x: number, y: number, align: CanvasTextAlign) {
  c.textAlign = align;
  c.fillStyle = "#000";
  c.fillText(s, x, y);
  c.fillStyle = "#fff";
  c.fillText(s, x - 2, y - 2);
}

/** Barra vertical: bloque (11,0)–(62,31) de BIGMETER tapado desde arriba por (11,32)–(62,63 − valor). */
function vbar(c: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, v: number) {
  c.drawImage(img, 11, 0, 51, 31, x, y, 51, 31);
  const cover = 31 - Math.max(0, Math.min(31, v));
  if (cover > 0) c.drawImage(img, 11, 32, 51, cover, x, y, 51, cover);
}

/** Barra horizontal: fondo (62,16)–(126,34) y 2·valor px de la franja (62,0)–(124,16). */
function hbar(c: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, v: number) {
  c.drawImage(img, 62, 16, 64, 18, x, y, 64, 18);
  const w = 2 * Math.max(0, Math.min(31, v));
  if (w > 0) c.drawImage(img, 62, 0, w, 16, x + 1, y + 1, w, 16);
}

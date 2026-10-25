// Menús del original: pantalla principal, Modo Caña (elegir circuito), Lavabos y la de carga, con las imágenes,
// los textos (DLL de idioma) y las fuentes de la instalación. Port de ROADRASH.EXE:
//
//   0x46a390 + pantalla·0x14: [nº de botones, botones, título (id de cadena), estilo del título]. Botón de 0x38 B
//                 (FUN_00421df0 los coloca con MoveWindow): +4 pantalla destino, +8 texto, +0xC/+0x10/+0x14/+0x18
//                 x, y, ancho y alto en 640×480, +0x1C vecinos (izquierda, derecha, arriba, abajo), +0x24 estilo,
//                 +0x28 activo, +0x2C función al pulsarlo, +0x30 descripción, +0x34 estilo de la descripción.
//                 Pantalla 9 (principal): título "Modo de Juego"; Modo Caña → 10, Modo Tope → 14, Mano-À-Mano → 11
//                 y Lavabos → 16, de 160×60 en la franja de abajo (y = 0x1A4). Pantalla 10 (Modo Caña): los cinco
//                 circuitos (cadenas 0x10-0x14, ids 1-5) en dos filas de 213×30.
//   FUN_0041d970  fondo de cada pantalla: 9 Main, 10/12/27 Postcard, 16 Restroom/Rest%d (FUN_0041d7d0, 1-6),
//                 8 Chars/%s-F (en Modo Caña "Thrash", que no existe: [I] se deja el fondo anterior).
//   FUN_0041dbc0  al enfocar un circuito (WM_SETFOCUS): Postcard/City, Sierra, Penin, Napa o PCH; FUN_0041e240
//                 la pinta sobre la tira Postcard (243 px a la izquierda; la postal ocupa los 397 de la derecha).
//   FUN_0041f770  título: Badloc 72 (fuente 0x49600c) en (0, 0, ancho + 0x31, alto + 0x2A), centrado abajo, con
//                 sombra negra a 2 px y color 0x3264FF (#FF6432); con el estilo & 1, centrado a ¾ de la altura.
//   FUN_0041fc90 / FUN_0041ff80  botón: Futura Condensed Bold 24 (0x49601c) en (x + 0x19, y + 2) con sombra a
//                 2 px; #DEFFF0, enfocado #E1E180 con una flecha amarilla (Wingdings 0xE8) 0x16 a la izquierda,
//                 inactivo #A0A0A0. Un botón de 640 de ancho usa Futura Condensed Regular 32 centrada.
//                 Estilo & 1: el título pasa a ser el texto del botón; & 4: muestra su descripción.
//   FUN_00420470  descripción: Futura Condensed Regular 32 (0x496018) hasta 300 px de ancho, en (8, 0x7A),
//                 centrada, con sombra a 2 px, #DEFFF0. FUN_00420810 añade la distancia de cada circuito
//                 (0x468f58[circuito·5 + nivel], décimas de milla, "%d.%d").
//   FUN_004213c0  al elegir circuito: vídeo Start1-6 al azar (FUN_004023e0) y pantalla 8: "CARGANDO JUEGO"
//                 (estilo 0x4851) y "¡Prepárate para la carrera!" en (0, 0x19A, 640, 0x46).
// [I] Modo Tope y Mano-À-Mano se ven inactivos (el port no los tiene). Lavabos solo deja elegir el nivel
//     ("Nivel del Jugador") y volver ("Ya está"); el original es un diálogo con más opciones.

export interface MenuData {
  strings: Record<string, string>;
  images: string[];
  videos: string[];
  /** Décimas de milla de cada circuito (1-5: ciudad, sierra, península, Napa, PCH) por nivel (0x468f58). */
  miles: number[][];
  fonts: { badloc?: string; regular?: string; bold?: string; demi?: string };
}

interface Item {
  label: number | (() => string);
  x: number; y: number; w: number; h: number;
  /** Vecinos (índices): izquierda, derecha, arriba, abajo (+0x1C). */
  nav: [number, number, number, number];
  desc?: () => string;
  enabled?: boolean;
  /** Postal del fondo al enfocarlo (FUN_0041dbc0). */
  card?: string;
  /** Título = texto del botón (estilo & 1). */
  titled?: boolean;
  press?: () => void;
  side?: (d: number) => void; // izquierda/derecha cambian el valor (Lavabos)
}

interface Screen { bg: string; title?: number; items: Item[]; back?: () => void }

/** Circuitos del Modo Caña, por id (1-5) → nombre del .CRS y postal (FUN_0041dbc0). */
export const THRASH_COURSES = [
  { id: 1, name: "CITY", card: "city" },
  { id: 2, name: "HIWAY", card: "sierra" },
  { id: 3, name: "MEDLY", card: "penin" },
  { id: 4, name: "NAPA", card: "napa" },
  { id: 5, name: "CANYN", card: "pch" },
];

const PALE = "#deffF0", FOCUS = "#e1e180", OFF = "#a0a0a0", TITLE = "#ff6432";

export class Menu {
  readonly root: HTMLElement;
  private stage: HTMLElement;
  data: MenuData;
  private screen: Screen | null = null;
  private focus = 0;
  private bg: HTMLElement;
  private card: HTMLImageElement;
  private layer: HTMLElement;
  private busy = false; // vídeo o carga en curso
  private skip: (() => void) | null = null;
  level = 0;
  lastCourse = 0;
  /** Al elegir circuito (índice de THRASH_COURSES), tras el vídeo de salida y con la pantalla de carga puesta. */
  onPick: ((course: number) => Promise<void>) | null = null;
  onLevel: ((level: number) => void) | null = null;
  /** Al abrir una pantalla (suena la música de los menús) y al empezar un vídeo (se para). */
  onScreen: (() => void) | null = null;
  onVideo: (() => void) | null = null;

  constructor(root: HTMLElement, data: MenuData) {
    this.root = root;
    this.data = data;
    this.stage = document.createElement("div");
    this.stage.className = "stage";
    this.bg = document.createElement("div");
    this.bg.className = "bg";
    this.card = document.createElement("img");
    this.card.className = "card";
    this.layer = document.createElement("div");
    this.stage.append(this.bg, this.card, this.layer);
    root.append(this.stage);
    this.layout();
    addEventListener("resize", () => this.layout());
    this.loadFonts();
  }

  get visible() { return this.root.style.display !== "none"; }

  private loadFonts() {
    const f = this.data.fonts;
    const add = (family: string, url?: string) => {
      if (!url) return;
      const face = new FontFace(family, `url(${url})`);
      face.load().then((ff) => document.fonts.add(ff)).catch(() => {});
    };
    add("RR Badloc", f.badloc);
    add("RR Futura", f.regular);
    add("RR Futura Bold", f.bold);
    add("RR Futura Demi", f.demi);
  }

  private layout() {
    const s = Math.min(innerWidth / 640, innerHeight / 480);
    this.stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }

  private str(id: number) { return (this.data.strings[id] ?? "").replace(/\r/g, ""); }
  private img(path: string) { return this.data.images.find((u) => u.toLowerCase() === path.toLowerCase()) ?? path; }

  show() { this.root.style.display = "block"; }
  hide() { this.root.style.display = "none"; this.layer.textContent = ""; this.screen = null; }

  /** Imagen de presentación (SPLASH.RRI) con un texto abajo, mientras carga. */
  splash(text: string) {
    this.show();
    this.screen = null;
    this.setBg(this.img("/images/splash.jpg"));
    this.card.style.display = "none";
    this.layer.textContent = "";
    this.layer.append(this.line(text, 410, 70));
  }

  /** Espera una tecla o un clic (el navegador no deja sonar nada sin ello). */
  waitInput(text: string) {
    this.splash(text);
    return new Promise<void>((done) => {
      const go = (e: Event) => {
        e.preventDefault();
        removeEventListener("keydown", go, true);
        removeEventListener("pointerdown", go, true);
        done();
      };
      addEventListener("keydown", go, true);
      addEventListener("pointerdown", go, true);
    });
  }

  /** Vídeo a pantalla completa en el escenario; una tecla o un clic lo saltan. */
  playVideo(url: string | undefined) {
    if (!url) return Promise.resolve();
    this.onVideo?.();
    return new Promise<void>((done) => {
      const v = document.createElement("video");
      v.className = "video";
      v.src = url;
      v.autoplay = true;
      this.stage.append(v);
      const end = () => {
        if (!v.isConnected) return;
        v.pause();
        v.remove();
        this.skip = null;
        done();
      };
      this.skip = end;
      v.addEventListener("ended", end);
      v.addEventListener("error", end);
      v.addEventListener("pointerdown", (e) => { e.preventDefault(); end(); });
      v.play().catch(end);
    });
  }

  private video(name: string) { return this.data.videos.find((u) => u.endsWith(`/video/${name}.webm`)); }

  playIntro() { return this.playVideo(this.video("intro")); }

  // --- Pantallas ------------------------------------------------------------------
  main() {
    const enabled = [true, false, false, true];
    const at = (k: number, label: number, desc: number, press?: () => void): Item => ({
      label, x: k * 160, y: 0x1a4, w: 160, h: 60, nav: [(k + 3) % 4, (k + 1) % 4, k, k],
      desc: () => this.str(desc), enabled: enabled[k], press,
    });
    this.open({
      bg: this.img("/images/main.jpg"),
      title: 0x46,
      items: [
        at(0, 2, 3, () => this.thrash()),
        at(1, 4, 5),
        at(2, 0xd, 0xe),
        at(3, 6, 7, () => this.restroom()),
      ],
    }, 0);
  }

  /** Pantalla 10 (Modo Caña): FUN_00420810 con la distancia del nivel. */
  thrash(focus = this.lastCourse) {
    const pos = [[0, 0x1a4, 213], [0, 0x1c2, 213], [213, 0x1a4, 213], [213, 0x1c2, 213], [426, 0x1a4, 214]];
    // Vecinos de la tabla (+0x1C); el 5 es el botón vacío: ahí no se mueve.
    const nav: [number, number, number, number][] = [[4, 2, 1, 1], [5, 3, 0, 0], [0, 4, 3, 3], [1, 5, 2, 2], [2, 0, 5, 5]];
    const items = THRASH_COURSES.map((c, k): Item => ({
      label: 0x10 + k, x: pos[k][0], y: pos[k][1], w: pos[k][2], h: 30, nav: nav[k], titled: true,
      card: this.img(`/images/postcard/${c.card}.jpg`),
      desc: () => {
        const d = this.data.miles[k]?.[this.level] ?? 0;
        return this.str(0x15 + k).replace("%s", `${Math.trunc(d / 10)}.${d % 10}`).replace("%s", this.str(0x1b));
      },
      press: () => this.pick(k),
    }));
    this.open({ bg: this.img("/images/postcard.jpg"), items, back: () => this.main() }, focus);
  }

  /** [I] Lavabos (pantalla 16, un diálogo en el original): nivel del jugador y "Ya está". */
  restroom() {
    const k = 1 + Math.floor(Math.random() * 6);
    const setLevel = (d: number) => {
      this.level = (this.level + d + 5) % 5;
      this.onLevel?.(this.level);
      this.render();
    };
    this.open({
      bg: this.img(`/images/restroom/rest${k}.jpg`),
      title: 6,
      items: [
        { label: () => `${this.str(0x4a)}: ${this.str(0x5b + this.level)}`, x: 0, y: 0x1a4, w: 320, h: 60, nav: [1, 1, 0, 0], desc: () => this.str(0x4b), press: () => setLevel(1), side: setLevel },
        { label: 0x56, x: 320, y: 0x1a4, w: 320, h: 60, nav: [0, 0, 1, 1], desc: () => this.str(0x57), press: () => this.main() },
      ],
      back: () => this.main(),
    }, 0);
  }

  private async pick(k: number) {
    if (this.busy) return;
    this.busy = true;
    this.lastCourse = k;
    try {
      await this.playVideo(this.video(`start${1 + Math.floor(Math.random() * 6)}`));
      this.loading();
      await this.onPick?.(k);
    } finally {
      this.busy = false;
    }
  }

  /** Pantalla 8: "CARGANDO JUEGO" centrado a ¾ y "¡Prepárate para la carrera!" abajo; el fondo se queda. */
  private loading() {
    this.screen = null;
    this.layer.textContent = "";
    const t = this.text(this.str(0xce), "title");
    t.style.left = "0";
    t.style.width = "640px";
    t.style.textAlign = "center";
    t.style.top = `${((480 - 88) * 3) / 4 - 2}px`;
    this.layer.append(t, this.line(this.str(0xcf), 0x19a, 0x46));
  }

  private open(s: Screen, focus: number) {
    this.show();
    this.screen = s;
    this.focus = s.items[focus]?.enabled === false ? s.items.findIndex((i) => i.enabled !== false) : focus;
    this.setBg(s.bg);
    this.render();
    this.onScreen?.();
  }

  private setBg(url: string) {
    this.bg.style.backgroundImage = `url("${url}")`;
  }

  private text(s: string, kind: "title" | "desc" | "button" | "wide") {
    const el = document.createElement("div");
    el.className = `t ${kind}`;
    el.textContent = s;
    return el;
  }

  /** Texto de una ventana de 640 de ancho (Futura Condensed Regular 32, centrado). */
  private line(s: string, y: number, h: number) {
    const el = this.text(s, "wide");
    el.style.top = `${y}px`;
    el.style.height = `${h}px`;
    return el;
  }

  private render() {
    const s = this.screen;
    if (!s) return;
    this.layer.textContent = "";
    const cur = s.items[this.focus];
    // Postal del circuito enfocado sobre la tira Postcard (FUN_0041dbc0 → FUN_0041e240).
    if (cur?.card) { this.card.src = cur.card; this.card.style.display = "block"; }
    else this.card.style.display = "none";
    const titleText = cur?.titled ? this.label(cur) : s.title !== undefined ? this.str(s.title) : "";
    if (titleText) this.layer.append(this.text(titleText, "title"));
    if (cur?.desc) this.layer.append(this.text(cur.desc(), "desc"));
    s.items.forEach((it, k) => {
      const b = document.createElement("div");
      b.className = "button";
      Object.assign(b.style, { left: `${it.x}px`, top: `${it.y}px`, width: `${it.w}px`, height: `${it.h}px` });
      const on = it.enabled !== false, focused = k === this.focus;
      const t = this.text(this.label(it), "button");
      t.style.color = !on ? OFF : focused ? FOCUS : PALE;
      b.append(t);
      if (focused && on) {
        const arrow = this.text("➔", "button");
        arrow.classList.add("arrow");
        b.append(arrow);
      }
      if (on) {
        b.addEventListener("pointerenter", () => { if (this.focus !== k && !this.busy) { this.focus = k; this.render(); } });
        b.addEventListener("click", () => { if (!this.busy) it.press?.(); });
      }
      this.layer.append(b);
    });
  }

  private label(it: Item) { return typeof it.label === "number" ? this.str(it.label) : it.label(); }

  /** Teclado: flechas por los vecinos de la tabla, Enter pulsa, Escape vuelve. Devuelve si la ha usado. */
  key(e: KeyboardEvent): boolean {
    if (!this.visible) return false;
    if (this.skip) { if (!e.repeat) this.skip(); return true; }
    const s = this.screen;
    if (!s || this.busy) return true;
    const k = e.key;
    const dir = { ArrowLeft: 0, ArrowRight: 1, ArrowUp: 2, ArrowDown: 3 }[k];
    const cur = s.items[this.focus];
    if (dir !== undefined) {
      if (cur?.side && dir < 2) { cur.side(dir ? 1 : -1); return true; }
      // Sigue el vecino; salta los inactivos y el botón vacío (fuera de la lista).
      let next = this.focus;
      for (let n = 0; n < s.items.length; n++) {
        const to = s.items[next]?.nav[dir];
        if (to === undefined || to >= s.items.length || to === next) break;
        next = to;
        if (s.items[next].enabled !== false) break;
      }
      if (s.items[next] && s.items[next].enabled !== false && next !== this.focus) { this.focus = next; this.render(); }
      return true;
    }
    if (k === "Enter" || k === " ") { if (cur?.enabled !== false) cur?.press?.(); return true; }
    if (k === "Escape") { s.back?.(); return true; }
    return true;
  }
}

// Sonido: música (pistas .RRA de AUDIO/MUSIC, WAV) y motor con el tono del original.
//
//   FUN_00435e60  carga AUDIO/EFFECTS: motor del jugador según la moto (Rat 0-4, Sport 5-9, Super 10-14),
//                 EngOther para los rivales.
//   FUN_00434ce0  motor del jugador: frecuencia = doppler(0x100) · RPM >> 9 Hz, volumen 0x9FFE·cerca/61200.
//   FUN_00434db0  volumen por distancia (< 0x1E00 en la ruta): ((0x1E00 − d)·8 >> 8)² >> 8; doppler
//                 0x13B0000/(0x13B00 − Δv); panorámica = ángulo · 0x62.
//   FUN_004141c0  DirectSound: SetFrequency(Hz, 100..100000), SetVolume((vol·10000 >> 14) − 10000 cB).
//   FUN_00403040  hilo de música de los menús: la canción de la máquina de discos (DAT_00475374) de la lista
//                 HB_Trip, HB_Pass, MM_Dino, P_Pansy, P_Jessie, P_Bridge, SG_Rusty, SG_Outsh, SG_Kicks, SG_Super,
//                 SD_Train, SD_Duel, T_Teeth, T_Auto (.RRA = WAV). En carrera suena el MIDI del circuito
//                 (FUN_00435da0, src/music.ts). [I] El port encadena las canciones empezando por una al azar.

import { MidiPlayer, parseMids, parseSoundFont1 } from "./music.ts";

export class GameAudio {
  readonly ctx = new AudioContext();
  private master = this.ctx.createGain();
  private musicGain = this.ctx.createGain();
  private music: HTMLAudioElement | null = null;
  private tracks: string[] = [];
  private trackIndex = 0;
  private engines = new Map<string, { buffer: AudioBuffer; rate: number }>();
  constructor() {
    this.master.connect(this.ctx.destination);
    this.musicGain.gain.value = 0.95;
    this.musicGain.connect(this.master);
  }

  async loadEngine(name: string, url: string, rate: number) {
    const data = await (await fetch(url)).arrayBuffer();
    this.engines.set(name, { buffer: await this.ctx.decodeAudioData(data), rate });
  }

  /** Bucle de motor; `update(rpm, volumen 0..1, pan −1..1)` cambia su tono como SetFrequency. */
  engine(name: string) {
    const e = this.engines.get(name);
    if (!e) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = e.buffer;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    const pan = this.ctx.createStereoPanner();
    src.connect(gain).connect(pan).connect(this.master);
    src.start();
    const t = this.ctx.currentTime;
    return {
      update: (rpm: number, volume: number, panning = 0, doppler = 0x100) => {
        const hz = Math.max(100, Math.min(100000, (doppler * rpm) >> 9));
        src.playbackRate.setTargetAtTime(hz / e.rate, this.ctx.currentTime, 0.02);
        gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.03);
        pan.pan.setTargetAtTime(panning, this.ctx.currentTime, 0.05);
      },
      stop: () => { src.stop(Math.max(t, this.ctx.currentTime)); gain.disconnect(); },
    };
  }

  private midi: MidiPlayer | null = null;
  private files = new Map<string, Promise<ArrayBuffer>>();
  private banks = new Map<string, ReturnType<typeof parseSoundFont1>>();
  private race: { seq: string; banks: [number, string][] } | null = null;
  private mode: "menu" | "race" = "menu";
  private load(url: string) {
    let p = this.files.get(url);
    if (!p) { p = fetch(url).then((r) => r.arrayBuffer()); this.files.set(url, p); }
    return p;
  }

  /** Música de carrera: secuencia MIDS con sus bancos ([banco MIDI, url del .SBK]). */
  async raceMusic(seq: string, banks: [number, string][]) {
    this.mode = "race";
    this.race = { seq, banks };
    this.music?.pause();
    this.midi ??= new MidiPlayer(this.ctx, this.musicGain);
    try {
      for (const [n, url] of banks) {
        let b = this.banks.get(url);
        if (!b) { b = parseSoundFont1(this.ctx, await this.load(url)); this.banks.set(url, b); }
        this.midi.setBank(n, b);
      }
      const song = parseMids(await this.load(seq));
      if (this.mode === "race" && this.race?.seq === seq) this.midi.play(song);
    } catch (e) { console.warn("música de carrera", e); }
    return seq.split("/").pop();
  }

  /** Música de los menús: las canciones de la máquina de discos. */
  menuMusic() {
    if (this.mode === "menu" && this.music && !this.music.paused) return;
    this.mode = "menu";
    this.midi?.stop();
    return this.resumeMusic();
  }

  setTracks(urls: string[]) {
    this.tracks = urls;
    this.trackIndex = Math.floor(Math.random() * Math.max(1, urls.length));
  }

  /** Siguiente canción (o la primera); vuelve a empezar al acabar. */
  nextTrack() {
    if (!this.tracks.length) return;
    this.music?.pause();
    const url = this.tracks[this.trackIndex++ % this.tracks.length];
    const el = new Audio(url);
    el.addEventListener("ended", () => { if (this.mode === "menu") this.nextTrack(); });
    this.ctx.createMediaElementSource(el).connect(this.musicGain);
    el.play().catch(() => {});
    this.music = el;
    return url.split("/").pop();
  }

  private effects = new Map<string, AudioBuffer>();
  /** Efecto de AUDIO/EFFECTS (lista de FUN_00435e60), p. ej. "punchhea". */
  async loadEffect(name: string, url: string) {
    try { this.effects.set(name, await this.ctx.decodeAudioData(await (await fetch(url)).arrayBuffer())); } catch { /* sin efecto */ }
  }
  play(name: string, volume = 1, panning = 0) {
    const b = this.effects.get(name);
    if (!b) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = panning;
    src.connect(gain).connect(pan).connect(this.master);
    src.start();
  }

  stopMusic() { this.music?.pause(); this.midi?.stop(); }
  /** Sigue la canción parada o empieza la siguiente. */
  resumeMusic() {
    if (!this.music) return this.nextTrack();
    if (this.music.paused) this.music.play().catch(() => {});
    return this.music.src.split("/").pop();
  }

  toggleMusic() {
    if (this.mode === "race") {
      if (this.midi?.playing) this.midi.stop();
      else if (this.race) void this.raceMusic(this.race.seq, this.race.banks);
      return;
    }
    if (!this.music) return this.nextTrack();
    if (this.music.paused) this.music.play().catch(() => {});
    else this.music.pause();
  }

  resume() { return this.ctx.resume(); }
}

/** Volumen del motor de un rival según su distancia en la ruta (FUN_00434db0), 0..1. */
export function engineVolume(distance: number): number {
  const d = Math.abs(distance);
  if (d >= 0x1e00) return 0;
  const k = ((0x1e00 - d) * 8) >> 8;
  const near = (k * k) >> 8; // 0..225
  return Math.min(1, ((0x9ffe * near) / 0xef10 / 150));
}

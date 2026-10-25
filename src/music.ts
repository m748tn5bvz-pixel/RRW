// Música de carrera: secuencias MIDS (AUDIO/MUSIC/SbkGrng%d.MID) tocadas con los bancos SoundFont 1.0 del AWE32
// (RRDRUMS.SBK y Grunge%d.SBK), port de ROADRASH.EXE:
//
//   FUN_00435da0  al empezar la carrera, FUN_00433bb0(circuito): con la AWE32, FUN_00434500 carga RRDRUMS.SBK en el
//                 banco 1 y Grunge%d.SBK (0x46d938[circuito]) en el 2, y toca SbkGrng%d.MID (0x46d920); si no,
//                 Grunge%d.MID (0x46d908) por el MIDI de Windows (midiOutSetVolume). Circuito 0-4 = City, Sierra,
//                 Penin, Napa, PCH (0x467aa0); con el nombre "krusty", el 5: Klown.
//   Formatos:     .MID = RIFF 'MIDS' (midiStreamOut): fmt [división, búfer, banderas] y data [nº de bloques, y por
//                 bloque inicio, bytes y eventos de 12 B: delta, id de flujo, evento (byte alto 0 mensaje corto,
//                 1 tempo)]. .SBK = RIFF 'sfbk' SoundFont 1.0: como SF2 pero con 'snam' (nombres) y cabeceras de
//                 muestra de 16 B [inicio, fin, inicio y fin del bucle]; el tono original va en el generador 55
//                 (centésimas de semitono) y la nota raíz forzada en el 58.
// [I] Sin la ROM GM de la AWE32: los canales que piden el banco 0 (p. ej. el órgano del canal 6) no suenan.
// [I] Envolventes, filtros y LFO de los bancos no se reproducen: ataque inmediato y caída corta al soltar.

interface Zone {
  keyLo: number; keyHi: number; velLo: number; velHi: number;
  buffer: AudioBuffer; loop: boolean; loopStart: number; loopEnd: number;
  root: number; tune: number; // centésimas
  gain: number; pan: number;
}

const RATE = 44100; // EMU8000

function chunks(v: DataView, start: number, end: number, out: Record<string, [number, number]> = {}) {
  for (let o = start; o + 8 <= end; ) {
    const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    const size = v.getUint32(o + 4, true);
    if (id === "LIST") chunks(v, o + 12, o + 8 + size, out);
    else out[id] = [o + 8, size];
    o += 8 + size + (size & 1);
  }
  return out;
}

/** Presets de un banco SoundFont 1.0, por programa (el banco MIDI lo decide quien lo carga, como AWEMAN32). */
export function parseSoundFont1(ctx: BaseAudioContext, data: ArrayBuffer): Map<number, Zone[]> {
  const v = new DataView(data);
  const c = chunks(v, 12, data.byteLength);
  const list = (id: string, size: number) => {
    const [o, n] = c[id];
    return Array.from({ length: Math.floor(n / size) }, (_, k) => o + k * size);
  };
  const gens = (id: string) => list(id, 4).map((o) => [v.getUint16(o, true), v.getInt16(o + 2, true)] as const);
  const pgen = gens("pgen"), igen = gens("igen");
  const pbag = list("pbag", 4).map((o) => v.getUint16(o, true));
  const ibag = list("ibag", 4).map((o) => v.getUint16(o, true));
  const inst = list("inst", 22).map((o) => v.getUint16(o + 20, true));
  const shdr = list("shdr", 16).map((o) => [0, 4, 8, 12].map((k) => v.getUint32(o + k, true)));
  const [smplOff] = c.smpl;
  const buffers = new Map<number, AudioBuffer>();
  const sample = (id: number, s0: number, s1: number) => {
    const key = id * 1e9 + s0 * 1e4 + s1;
    let b = buffers.get(key);
    if (!b) {
      const n = Math.max(1, s1 - s0);
      b = ctx.createBuffer(1, n, RATE);
      const ch = b.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = v.getInt16(smplOff + (s0 + i) * 2, true) / 32768;
      buffers.set(key, b);
    }
    return b;
  };
  const zonesOf = (bag: number[], g: (readonly [number, number])[], from: number, to: number) => {
    const out: Map<number, number>[] = [];
    for (let z = from; z < to; z++) {
      const m = new Map<number, number>();
      for (let k = bag[z]; k < bag[z + 1]; k++) m.set(g[k][0], g[k][1]);
      out.push(m);
    }
    return out;
  };
  const range = (m: Map<number, number>, id: number) => {
    const r = m.get(id);
    return r === undefined ? [0, 127] : [r & 0xff, (r >> 8) & 0xff];
  };
  const presets = new Map<number, Zone[]>();
  const phdr = list("phdr", 38);
  for (let p = 0; p + 1 < phdr.length; p++) {
    const prog = v.getUint16(phdr[p] + 20, true);
    const out: Zone[] = [];
    for (const pz of zonesOf(pbag, pgen, v.getUint16(phdr[p] + 24, true), v.getUint16(phdr[p + 1] + 24, true))) {
      const i = pz.get(41);
      if (i === undefined || i + 1 >= inst.length) continue;
      const [pk0, pk1] = range(pz, 43);
      let global: Map<number, number> | null = null;
      for (const iz of zonesOf(ibag, igen, inst[i], inst[i + 1])) {
        if (!iz.has(53)) { global = iz; continue; }
        const m = new Map([...(global ?? []), ...iz]);
        const [s0, s1, l0, l1] = shdr[m.get(53)!] ?? [0, 0, 0, 0];
        const start = s0 + (m.get(0) ?? 0) + (m.get(4) ?? 0) * 32768;
        const end = s1 + (m.get(1) ?? 0) + (m.get(12) ?? 0) * 32768;
        const ls = l0 + (m.get(2) ?? 0) + (m.get(45) ?? 0) * 32768 - start;
        const le = l1 + (m.get(3) ?? 0) + (m.get(50) ?? 0) * 32768 - start;
        const [k0, k1] = range(m, 43), [v0, v1] = range(m, 44);
        const pitch = m.get(55) ?? 6000;
        out.push({
          keyLo: Math.max(k0, pk0), keyHi: Math.min(k1, pk1), velLo: v0, velHi: v1,
          buffer: sample(m.get(53)!, start, end),
          loop: ((m.get(54) ?? 0) & 1) === 1 && le > ls,
          loopStart: ls / RATE, loopEnd: le / RATE,
          root: m.get(58) ?? Math.floor(pitch / 100),
          tune: (m.get(51) ?? 0) * 100 + (m.get(52) ?? 0) - (pitch % 100),
          gain: Math.pow(10, -(m.get(48) ?? 0) / 200), // centibelios
          pan: Math.max(-1, Math.min(1, (m.get(17) ?? 0) / 500)),
        });
      }
    }
    presets.set(prog, out);
  }
  return presets;
}

interface MidiEvent { tick: number; tempo?: number; msg?: [number, number, number] }

/** Eventos de una secuencia MIDS (RIFF 'MIDS'). */
export function parseMids(data: ArrayBuffer): { division: number; events: MidiEvent[] } {
  const v = new DataView(data);
  const c = chunks(v, 12, data.byteLength);
  const [fo] = c["fmt "], [d] = c.data;
  const division = v.getUint32(fo, true), noStreamId = (v.getUint32(fo + 8, true) & 1) !== 0;
  const events: MidiEvent[] = [];
  let o = d + 4, tick = 0;
  for (let b = v.getUint32(d, true); b > 0; b--) {
    const len = v.getUint32(o + 4, true);
    let p = o + 8;
    const end = p + len;
    while (p < end) {
      tick += v.getUint32(p, true);
      const e = v.getUint32(p + (noStreamId ? 4 : 8), true);
      p += noStreamId ? 8 : 12;
      if (e & 0x80000000) { p += ((e & 0xffffff) + 3) & ~3; continue; } // evento largo (sysex)
      const type = (e >>> 24) & 0x7f;
      if (type === 1) events.push({ tick, tempo: e & 0xffffff });
      else if (type === 0) events.push({ tick, msg: [e & 0xff, (e >> 8) & 0xff, (e >> 16) & 0xff] });
    }
    o = end;
  }
  return { division, events };
}

interface Voice { src: AudioBufferSourceNode; gain: GainNode; note: number; zone: Zone; drum: boolean }

/** Secuenciador: banco 1 = batería (RRDRUMS), banco 2 = instrumentos del circuito (Grunge%d). */
export class MidiPlayer {
  private ctx: AudioContext;
  private out: GainNode;
  private banks = new Map<number, Map<number, Zone[]>>();
  private song: { division: number; events: MidiEvent[] } | null = null;
  private timer = 0;
  private index = 0;
  private t0 = 0; // tiempo de audio del tick de referencia
  private tick0 = 0;
  private tempo = 500000;
  private ch = Array.from({ length: 16 }, () => ({ bank: 0, prog: 0, vol: 100 / 127, expr: 1, pan: 0, bend: 0, voices: [] as Voice[] }));
  playing = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1.6;
    this.out.connect(destination);
  }

  setBank(bank: number, presets: Map<number, Zone[]>) { this.banks.set(bank, presets); }

  play(song: { division: number; events: MidiEvent[] }) {
    this.stop();
    this.song = song;
    this.playing = true;
    this.restart();
    this.timer = window.setInterval(() => this.pump(), 50);
  }

  private restart() {
    this.index = 0;
    this.tick0 = 0;
    this.tempo = 500000;
    this.t0 = this.ctx.currentTime + 0.1;
    for (const c of this.ch) Object.assign(c, { bank: 0, prog: 0, vol: 100 / 127, expr: 1, pan: 0, bend: 0 });
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    for (const c of this.ch) { for (const v of c.voices) this.release(v, this.ctx.currentTime); c.voices = []; }
  }

  private time(tick: number) {
    return this.t0 + ((tick - this.tick0) * this.tempo) / 1e6 / this.song!.division;
  }

  /** Programa los eventos de los próximos 300 ms; al acabar, vuelve a empezar. */
  private pump() {
    const s = this.song;
    if (!s || !this.playing) return;
    const horizon = this.ctx.currentTime + 0.3;
    while (true) {
      if (this.index >= s.events.length) {
        const end = this.time(s.events[s.events.length - 1]?.tick ?? 0);
        if (end > horizon) return;
        this.restart();
        this.t0 = Math.max(end, this.ctx.currentTime) + 0.05;
      }
      const e = s.events[this.index];
      const t = this.time(e.tick);
      if (t > horizon) return;
      this.index++;
      if (e.tempo) { this.t0 = t; this.tick0 = e.tick; this.tempo = e.tempo; }
      else if (e.msg) this.message(e.msg, Math.max(t, this.ctx.currentTime));
    }
  }

  private message([st, d1, d2]: [number, number, number], t: number) {
    const c = this.ch[st & 15], type = st & 0xf0;
    if (type === 0x90 && d2 > 0) this.noteOn(st & 15, d1, d2, t);
    else if (type === 0x80 || type === 0x90) {
      for (const v of c.voices) if (v.note === d1 && !v.drum) this.release(v, t);
      c.voices = c.voices.filter((v) => v.note !== d1 || v.drum);
    } else if (type === 0xb0) {
      if (d1 === 0) c.bank = d2;
      else if (d1 === 7) c.vol = d2 / 127;
      else if (d1 === 11) c.expr = d2 / 127;
      else if (d1 === 10) c.pan = (d2 - 64) / 64;
      else if (d1 === 120 || d1 === 123) { for (const v of c.voices) this.release(v, t); c.voices = []; }
    } else if (type === 0xc0) c.prog = d1;
    else if (type === 0xe0) {
      c.bend = ((d2 << 7 | d1) - 8192) / 8192 * 200; // ±2 semitonos
      for (const v of c.voices) v.src.playbackRate.setValueAtTime(this.rate(v.zone, v.note, c.bend), t);
    }
  }

  private rate(z: Zone, note: number, bend: number) {
    return Math.pow(2, ((note - z.root) * 100 + z.tune + bend) / 1200);
  }

  private noteOn(chn: number, note: number, vel: number, t: number) {
    const c = this.ch[chn];
    const presets = this.banks.get(c.bank);
    const zones = presets?.get(c.prog) ?? (c.bank === 1 ? presets?.values().next().value : undefined);
    if (!zones) return; // banco 0: la ROM GM de la AWE32, que no viene en la instalación
    for (const z of zones) {
      if (note < z.keyLo || note > z.keyHi || vel < z.velLo || vel > z.velHi) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = z.buffer;
      src.loop = z.loop;
      if (z.loop) { src.loopStart = z.loopStart; src.loopEnd = z.loopEnd; }
      src.playbackRate.value = this.rate(z, note, c.bend);
      const gain = this.ctx.createGain();
      const level = z.gain * (vel / 127) ** 2 * c.vol * c.expr;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(level, t + 0.003);
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, z.pan + c.pan));
      src.connect(gain).connect(pan).connect(this.out);
      src.start(t);
      const v: Voice = { src, gain, note, zone: z, drum: c.bank === 1 };
      src.onended = () => { c.voices = c.voices.filter((x) => x !== v); };
      c.voices.push(v);
    }
  }

  private release(v: Voice, t: number) {
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, t, 0.06);
    try { v.src.stop(t + 0.4); } catch { /* ya parada */ }
  }
}

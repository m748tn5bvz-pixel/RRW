// Gráficos de Road Rash (Windows): cels heredados de la 3DO con píxeles convertidos por el port.
//
// Evidencia en ROADRASH.EXE:
//   FUN_0040b800  recorre chunks 3DO 'CCB ' / 'PLUT' / 'PDAT' (+ 'RPDT'/'RRPD' propios) y enlaza punteros.
//   FUN_0040b7b0  PDAT del port: marca 0x00BC614E; corrige los punteros de cada nivel (base +0x1C).
//   FUN_0040fe50  caja de recorte: int16 x1,y1,x2,y2 en PDAT+4.
//   FUN_004180b0  rasterizador de cuadriláteros: elige nivel de mipmap; textura de nivel L en
//                 *(PDAT+0x38+12·L); ancho PDAT+0x20 (potencia de 2), alto PDAT+0x24; 1 byte por texel
//                 (índice de paleta); PDAT+0x0C bit 2 → rutinas con transparencia.
//   FUN_004436a0  pilotos (Data/Bikers/{Hi,Lo}*.DAT): fotogramas [ancho u8][alto u8][píxeles].
//   FUN_0044c440 / FUN_0044c5f0  imágenes .BOB crudas de 8 bits (horizonte 720 de ancho, tablero 640…).
// Paleta: DATA/PALETTE.RAW, 256 × (R, G, B, 0).

import { readFourCC } from "./rsrc.ts";

export interface IndexedImage {
  name: string;
  width: number;
  height: number;
  pixels: Uint8Array; // índices de paleta
  transparent: boolean; // índice 0 transparente
}

export const PDAT_MAGIC = 0x00bc614e;

/** Decodifica el nivel 0 de un PDAT del port (payload = datos del chunk sin cabecera de 8 bytes). */
export function decodePdat(p: Uint8Array): IndexedImage | null {
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  if (p.length < 0x40 || v.getUint32(0, true) !== PDAT_MAGIC) return null;
  const x1 = v.getInt16(4, true), y1 = v.getInt16(6, true), x2 = v.getInt16(8, true), y2 = v.getInt16(10, true);
  const flags = v.getUint32(0x0c, true);
  let name = "";
  for (let i = 0x10; i < 0x20 && p[i]; i++) name += String.fromCharCode(p[i]);
  const W = v.getUint32(0x20, true), H = v.getUint32(0x24, true);
  const start = 0x1c + v.getUint32(0x38, true);
  if (!W || !H || start + W * H > p.length) return null;
  const w = Math.min(W, x2 - x1 + 1), h = Math.min(H, y2 - y1 + 1);
  if (w <= 0 || h <= 0) return null;
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) pixels.set(p.subarray(start + (y1 + y) * W + x1, start + (y1 + y) * W + x1 + w), y * w);
  return { name, width: w, height: h, pixels, transparent: (flags & 2) !== 0 };
}

/** Recorre una secuencia de chunks 3DO y devuelve las imágenes de cada PDAT del port. */
export function decodeCelChunks(data: Uint8Array): IndexedImage[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: IndexedImage[] = [];
  let o = 0;
  while (o + 8 <= data.length) {
    const id = readFourCC(v, o);
    const size = v.getUint32(o + 4, true);
    if (size < 8 || o + size > data.length) break;
    if (id === "PDAT" || id === "RPDT" || id === "RRPD") {
      const img = decodePdat(data.subarray(o + 8, o + size));
      if (img) out.push(img);
    }
    o += size;
  }
  return out;
}

/** Busca todos los PDAT del port dentro de un bloque arbitrario (p. ej. una familia descomprimida). */
export function scanPdats(data: Uint8Array): IndexedImage[] {
  const out: IndexedImage[] = [];
  for (let o = 0; o + 0x40 <= data.length; o += 4) {
    if (data[o] === 0x4e && data[o + 1] === 0x61 && data[o + 2] === 0xbc && data[o + 3] === 0x00) {
      const img = decodePdat(data.subarray(o));
      if (img) out.push(img);
    }
  }
  return out;
}

/** Fotogramas de un .DAT de pilotos: [ancho u8][alto u8][ancho·alto bytes]… (FUN_004436a0). */
export function decodeBikerFrames(data: Uint8Array, name: string): IndexedImage[] {
  const out: IndexedImage[] = [];
  let o = 0;
  while (o + 2 <= data.length) {
    const w = data[o], h = data[o + 1];
    o += 2;
    if (w * h === 0) {
      out.push({ name: `${name}_${out.length}`, width: 0, height: 0, pixels: new Uint8Array(0), transparent: true });
      continue;
    }
    if (o + w * h > data.length) break;
    out.push({ name: `${name}_${out.length}`, width: w, height: h, pixels: data.slice(o, o + w * h), transparent: true });
    o += w * h;
  }
  return out;
}

/** Paleta RGBA a partir de PALETTE.RAW (256 × R, G, B, 0). */
export function readPalette(raw: Uint8Array): Uint8Array {
  const pal = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) pal.set([raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2], 255], i * 4);
  return pal;
}

export function toRgba(img: IndexedImage, palette: Uint8Array): Uint8Array {
  const out = new Uint8Array(img.width * img.height * 4);
  for (let i = 0; i < img.pixels.length; i++) {
    const c = img.pixels[i];
    if (img.transparent && c === 0) continue;
    out.set(palette.subarray(c * 4, c * 4 + 4), i * 4);
  }
  return out;
}

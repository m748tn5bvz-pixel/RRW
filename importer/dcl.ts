// Descompresor PKWARE Data Compression Library ("implode"/"explode").
// Port a TypeScript de blast.c (Mark Adler, dominio público/zlib). ROADRASH.EXE incluye la
// biblioteca original (cadenas "Copyright 1989-1995 PKWARE Inc." en el ejecutable) y la usa
// para los recursos FAM de FAMILIES.RSC.

const MAXBITS = 13;

interface Huffman {
  count: Int16Array;
  symbol: Int16Array;
}

function construct(rep: number[], symbols: number): Huffman {
  const length: number[] = [];
  for (const r of rep) {
    let left = (r >> 4) + 1;
    const len = r & 15;
    while (left--) length.push(len);
  }
  const n = length.length;
  const h: Huffman = { count: new Int16Array(MAXBITS + 1), symbol: new Int16Array(symbols) };
  for (let s = 0; s < n; s++) h.count[length[s]]++;
  const offs = new Int16Array(MAXBITS + 1);
  for (let len = 1; len < MAXBITS; len++) offs[len + 1] = offs[len] + h.count[len];
  for (let s = 0; s < n; s++) if (length[s] !== 0) h.symbol[offs[length[s]]++] = s;
  return h;
}

// Tablas fijas del formato (blast.c).
const LITLEN = [
  11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8, 9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
  7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12, 8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
  44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45, 44, 173,
];
const LENLEN = [2, 35, 36, 53, 38, 23];
const DISTLEN = [2, 20, 53, 230, 247, 151, 248];
const BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

let tables: { lit: Huffman; len: Huffman; dist: Huffman } | null = null;

export function explode(input: Uint8Array, expectedSize?: number): Uint8Array {
  tables ??= { lit: construct(LITLEN, 256), len: construct(LENLEN, 16), dist: construct(DISTLEN, 64) };
  let pos = 0;
  let bitbuf = 0;
  let bitcnt = 0;
  const out: number[] = [];

  const bits = (need: number) => {
    let val = bitbuf;
    while (bitcnt < need) {
      if (pos >= input.length) throw new Error("DCL: fin de datos inesperado");
      val |= input[pos++] << bitcnt;
      bitcnt += 8;
    }
    bitbuf = val >>> need;
    bitcnt -= need;
    return val & ((1 << need) - 1);
  };

  const decode = (h: Huffman) => {
    let code = 0, first = 0, index = 0, len = 1, next = 1;
    let buf = bitbuf;
    let left = bitcnt;
    for (;;) {
      while (left--) {
        code |= (buf & 1) ^ 1; // los códigos van invertidos
        buf >>>= 1;
        const count = h.count[next++];
        if (code < first + count) {
          bitbuf = buf;
          bitcnt = (bitcnt - len) & 7;
          return h.symbol[index + (code - first)];
        }
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
        len++;
      }
      left = MAXBITS + 1 - len;
      if (left === 0) throw new Error("DCL: código inválido");
      if (pos >= input.length) throw new Error("DCL: fin de datos inesperado");
      buf = input[pos++];
      if (left > 8) left = 8;
    }
  };

  const lit = bits(8);
  if (lit > 1) throw new Error(`DCL: tipo de literal inválido ${lit}`);
  const dict = bits(8);
  if (dict < 4 || dict > 6) throw new Error(`DCL: diccionario inválido ${dict}`);

  for (;;) {
    if (bits(1)) {
      const sym = decode(tables.len);
      const len = BASE[sym] + bits(EXTRA[sym]);
      if (len === 519) break; // código de fin
      const shift = len === 2 ? 2 : dict;
      let dist = (decode(tables.dist) << shift) + bits(shift) + 1;
      if (dist > out.length) throw new Error("DCL: distancia fuera de rango");
      for (let i = 0; i < len; i++) out.push(out[out.length - dist]);
    } else {
      out.push(lit ? decode(tables.lit) : bits(8));
    }
  }
  if (expectedSize !== undefined && out.length !== expectedSize)
    throw new Error(`DCL: tamaño ${out.length}, se esperaba ${expectedSize}`);
  return Uint8Array.from(out);
}

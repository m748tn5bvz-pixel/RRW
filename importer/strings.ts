// Cadenas de la DLL de idioma (TEXT/ENU.DLL, ESP.DLL…): recursos RT_STRING de Windows.
// El juego las carga en una tabla indexada por id (FUN_0042f5d0 → DAT_00475378) y, por ejemplo,
// toma el nombre de cada corredor con el id de 0x464188[corredor] (FUN_00446bf0).

/** Devuelve id → texto de todas las tablas de cadenas (primer idioma de cada bloque). */
export function readStringTable(dll: Uint8Array): Map<number, string> {
  const v = new DataView(dll.buffer, dll.byteOffset, dll.byteLength);
  const pe = v.getUint32(0x3c, true);
  const nSections = v.getUint16(pe + 6, true);
  const optSize = v.getUint16(pe + 20, true);
  const opt = pe + 24;
  const dirs = opt + (v.getUint16(opt, true) === 0x20b ? 112 : 96);
  const rsrcRva = v.getUint32(dirs + 2 * 8, true);
  const sections = Array.from({ length: nSections }, (_, i) => {
    const s = opt + optSize + i * 40;
    return { va: v.getUint32(s + 12, true), size: Math.max(v.getUint32(s + 8, true), v.getUint32(s + 16, true)), raw: v.getUint32(s + 20, true) };
  });
  const off = (rva: number) => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + x.size);
    if (!s) throw new Error(`RVA 0x${rva.toString(16)} fuera de las secciones`);
    return rva - s.va + s.raw;
  };
  const root = off(rsrcRva);
  // Directorio de recursos: [16 B cabecera][entradas de 8 B: id, offset (bit 31 = subdirectorio)].
  const entries = (dir: number) => {
    const n = v.getUint16(dir + 12, true) + v.getUint16(dir + 14, true);
    return Array.from({ length: n }, (_, i) => ({ id: v.getUint32(dir + 16 + i * 8, true), to: v.getUint32(dir + 20 + i * 8, true) }));
  };
  const out = new Map<number, string>();
  const strings = entries(root).find((e) => e.id === 6);
  if (!strings) return out;
  for (const block of entries(root + (strings.to & 0x7fffffff))) {
    const lang = entries(root + (block.to & 0x7fffffff))[0];
    if (!lang) continue;
    const data = root + (lang.to & 0x7fffffff);
    let p = off(v.getUint32(data, true));
    for (let k = 0; k < 16; k++) {
      const len = v.getUint16(p, true);
      p += 2;
      if (len) out.set((block.id - 1) * 16 + k, new TextDecoder("utf-16le").decode(dll.subarray(p, p + len * 2)));
      p += len * 2;
    }
  }
  return out;
}

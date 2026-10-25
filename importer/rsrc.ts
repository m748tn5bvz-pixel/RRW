// Contenedor de recursos de Road Rash (1996, Windows).
//
// Observado en los archivos .RSC/.CRS/.CAR y en el cargador de ROADRASH.EXE
// (FUN_00441940 abre el archivo y pide recursos por tipo + id).
//
// Cabecera (0x30 bytes):
//   +0x00 'RSRC'  (bytes "CRSR": constante multi-caracter de MSVC, little-endian)
//   +0x04 u32     tamaño de cabecera (0x30)
//   +0x08 u32     versión (1 o 2)
//   +0x0C 'RTBL'
//   +0x10 u32     offset de la tabla de recursos
//   +0x14 u32     longitud de la tabla
//   +0x18 u32     0xFFFFFFFF
//   +0x1C u32     id/sello (repetido en +0x20)
// Tabla en `tableOffset`:
//   'RTBL', u32 tamaño, u32 número de entradas, u32 0
//   entradas de 32 bytes: tipo (fourcc), u32 id, u32 offset, u32 tamaño, 16 bytes a cero

export interface ResourceEntry {
  type: string; // fourcc legible, p. ej. "SGS ", "CEL "
  id: number;
  offset: number;
  size: number;
}

export interface ResourceFile {
  version: number;
  stamp: number;
  entries: ResourceEntry[];
  data: Uint8Array;
}

/** Lee un fourcc guardado como constante multi-caracter de MSVC (bytes invertidos). */
export function readFourCC(view: DataView, offset: number): string {
  let s = "";
  for (let i = 3; i >= 0; i--) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

export function parseResourceFile(data: Uint8Array): ResourceFile {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = readFourCC(view, 0);
  if (magic !== "RSRC") throw new Error(`no es un archivo RSRC (magic=${magic})`);
  const version = view.getUint32(0x08, true);
  const tableOffset = view.getUint32(0x10, true);
  const stamp = view.getUint32(0x1c, true);

  const tableTag = readFourCC(view, tableOffset);
  if (tableTag !== "RTBL") throw new Error(`tabla inesperada: ${tableTag}`);
  const count = view.getUint32(tableOffset + 8, true);

  const entries: ResourceEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = tableOffset + 16 + 32 * i;
    entries.push({
      type: readFourCC(view, e),
      id: view.getUint32(e + 4, true),
      offset: view.getUint32(e + 8, true),
      size: view.getUint32(e + 12, true),
    });
  }
  return { version, stamp, entries, data };
}

export function getResource(file: ResourceFile, type: string, id: number): Uint8Array {
  const entry = file.entries.find((e) => e.type === type && e.id === id);
  if (!entry) throw new Error(`recurso ${type}#${id} no encontrado`);
  return file.data.subarray(entry.offset, entry.offset + entry.size);
}

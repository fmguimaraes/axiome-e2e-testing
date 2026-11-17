/**
 * AXI-2601 (epic AXI-2598 — FR5, FR24, FR25, AC12) — "a non-empty file of the declared type".
 * PURE byte checks, unit-tested in `harness-unit/AXI-2601`. Nothing here trusts the
 * Content-Type header alone: the magic bytes / text shape must agree with the kind asked for.
 */
export type FileKind = 'csv' | 'svg' | 'png' | 'zip' | 'md' | 'pdf';

export interface FileVerdict {
  valid: boolean;
  note: string;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The PNG `pHYs` density in dots per inch (x axis), or null when the chunk is absent. */
export function pngDpi(bytes: Buffer): number | null {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'pHYs' && length >= 9) {
      const pxPerUnitX = bytes.readUInt32BE(offset + 8);
      const unit = bytes.readUInt8(offset + 16);
      return unit === 1 ? Math.round(pxPerUnitX * 0.0254) : null;
    }
    if (type === 'IDAT' || type === 'IEND') return null;
    offset += 12 + length;
  }
  return null;
}

export function checkFile(kind: FileKind, bytes: Buffer): FileVerdict {
  if (bytes.length === 0) return { valid: false, note: 'empty body' };
  const head = bytes.subarray(0, 512).toString('utf8');
  switch (kind) {
    case 'png': {
      if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) return { valid: false, note: 'not a PNG (magic bytes)' };
      const dpi = pngDpi(bytes);
      return dpi === 300 ? { valid: true, note: 'PNG, 300 dpi' } : { valid: false, note: `PNG but ${dpi === null ? 'no pHYs density' : `${dpi} dpi`} (FR25 wants 300 dpi)` };
    }
    case 'pdf':
      return bytes.subarray(0, 5).toString('latin1') === '%PDF-' ? { valid: true, note: 'PDF' } : { valid: false, note: 'not a PDF (%PDF- header)' };
    case 'zip':
      return bytes.readUInt32LE(0) === 0x04034b50 ? { valid: true, note: 'ZIP' } : { valid: false, note: 'not a ZIP (PK header)' };
    case 'svg':
      return /<svg[\s>]/i.test(bytes.toString('utf8')) ? { valid: true, note: 'SVG' } : { valid: false, note: 'no <svg> element' };
    case 'csv': {
      const lines = bytes.toString('utf8').split(/\r?\n/).filter((l) => l.length > 0);
      return lines.length >= 2 && lines[0].includes(',') ? { valid: true, note: `CSV, ${lines.length - 1} data line(s)` } : { valid: false, note: 'not a CSV with a header and a row' };
    }
    case 'md':
      return /\S/.test(head) && !head.trimStart().startsWith('{') ? { valid: true, note: 'Markdown text' } : { valid: false, note: 'not Markdown text' };
  }
}

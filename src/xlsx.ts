// ملف إكسل (xlsx) دون مكتبة: أوراق بخلايا نصية أو رقمية، من اليمين لليسار، بصف عنوان مثبّت.
// الملف حزمة ZIP دون ضغط (store) فيها ملفات XML. أول من استعمله تقرير إقرار الدين (ackreport.ts، 14/11/2026).

export type Cell = string | number | null | undefined | { v: number; f: 'money' | 'pct' } | { v: string; bold: true };

export interface SheetSpec {
  name: string;              // اسم الورقة، 31 حرفاً على الأكثر
  widths: number[];          // عرض كل عمود بعدد الأحرف
  rows: Cell[][];
  header: number;            // رقم صف العناوين (من 1)، يُثبَّت وتُضاف عليه التصفية
  bold?: number[];           // صفوف بخط عريض (المجموع مثلاً)
}

// الأنماط: 0 عادي، 1 عريض، 2 مبلغ، 3 نسبة، 4 مبلغ عريض، 5 نسبة عريضة، 6 عنوان العمود (عريض بخلفية رمادية)
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6E6E6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="9" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const esc = (s: string) => s
  // محارف التحكم غير مقبولة في XML
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function col(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function cellXml(c: Cell, ref: string, bold: boolean, head: boolean): string {
  if (c === null || c === undefined || c === '') return '';
  if (typeof c === 'number') return Number.isFinite(c) ? `<c r="${ref}"${bold ? ' s="1"' : ''}><v>${c}</v></c>` : '';
  if (typeof c === 'object' && 'f' in c) {
    if (!Number.isFinite(c.v)) return '';
    const s = c.f === 'money' ? (bold ? 4 : 2) : (bold ? 5 : 3);
    return `<c r="${ref}" s="${s}"><v>${c.v}</v></c>`;
  }
  const text = typeof c === 'object' ? c.v : c;
  const s = head ? 6 : bold || typeof c === 'object' ? 1 : 0;
  return `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function sheetXml(sh: SheetSpec): string {
  const last = Math.max(1, ...sh.rows.map((r) => r.length));
  const rows = sh.rows.map((r, i) => {
    const n = i + 1;
    const bold = !!sh.bold?.includes(n);
    return `<row r="${n}">${r.map((c, j) => cellXml(c, col(j) + n, bold, n === sh.header)).join('')}</row>`;
  }).join('');
  const top = col(0) + (sh.header + 1);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="${sh.header}" topLeftCell="${top}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="${top}" sqref="${top}"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows}</sheetData>
${sh.rows.length > sh.header ? `<autoFilter ref="A${sh.header}:${col(last - 1)}${sh.rows.length}"/>` : ''}
</worksheet>`;
}

export function buildXlsx(sheets: SheetSpec[]): Uint8Array {
  const names = sheets.map((s) => esc(s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)));
  const files: [string, string][] = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
${sheets.some((s) => s.rows.length > s.header) ? `<definedNames>${sheets.map((s, i) => s.rows.length > s.header
    ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${names[i]}'!$A$${s.header}:$${col(Math.max(1, ...s.rows.map((r) => r.length)) - 1)}$${s.rows.length}</definedName>` : '').join('')}</definedNames>` : ''}
</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zipStore(files.map(([n, t]) => [n, new TextEncoder().encode(t)]));
}

// ——— حزمة ZIP دون ضغط ———

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files: [string, Uint8Array][]): Uint8Array {
  const enc = new TextEncoder();
  // تاريخ ثابت في الحزمة (1/1/2026): لا يهم إكسل
  const time = 0, date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nb = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nb.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nb.length, true); lv.setUint16(28, 0, true);
    local.set(nb, 30);
    const cen = new Uint8Array(46 + nb.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nb.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nb, 46);
    parts.push(local, data);
    central.push(cen);
    offset += local.length + data.length;
  }
  const cenSize = central.reduce((t, c) => t + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((t, p) => t + p.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

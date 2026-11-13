/**
 * A small PDF writer for invoices and statements (same as backend-django/common/pdf.py): A4 pages,
 * Helvetica text (regular and bold), lines, right-aligned figures. The built-in fonts cover
 * Latin text only, so amounts are written "Rs. 1,234.00".
 */
const WIDTH = 595;
const HEIGHT = 842;
const widths = new Map([
  ...[..." ,.:;'|!il"].map((c) => [c, 278]),
  ...[..."()-/[]f t"].map((c) => [c, 333]),
  ...[..."mwMW"].map((c) => [c, 833]),
  ...[..."ABCDEGHKNOQRSUVXY&"].map((c) => [c, 700]),
]);

export const textWidth = (text, size, bold = false) =>
  ([...text].reduce((n, c) => n + (widths.get(c) ?? 556), 0) * size) / 1000 * (bold ? 1.05 : 1);

const escape = (text) =>
  String(text)
    .replace(/₹/g, "Rs.")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/[\\()]/g, (c) => `\\${c}`);

export class Pdf {
  constructor() {
    this.pages = [[]];
  }
  get ops() {
    return this.pages.at(-1);
  }
  newPage() {
    this.pages.push([]);
  }
  /** `y` counts from the top of the page; with `right`, `x` is where the text ends. */
  text(x, y, text, { size = 10, bold = false, right = false } = {}) {
    const s = String(text);
    const left = right ? x - textWidth(s, size, bold) : x;
    this.ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${left.toFixed(1)} ${(HEIGHT - y).toFixed(1)} Td (${escape(s)}) Tj ET`);
  }
  line(x1, y, x2, { width = 0.6, grey = 0.75 } = {}) {
    const yy = (HEIGHT - y).toFixed(1);
    this.ops.push(`${grey} G ${width} w ${x1.toFixed(1)} ${yy} m ${x2.toFixed(1)} ${yy} l S 0 G`);
  }
  render() {
    const objects = [];
    const add = (body) => objects.push(body);
    const catalog = add("");
    const pagesId = add("");
    const font = (name) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`);
    const f1 = font("Helvetica");
    const f2 = font("Helvetica-Bold");
    const kids = this.pages.map((ops) => {
      const stream = ops.join("\n");
      const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
      return add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] ` +
          `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`,
      );
    });
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    let out = "%PDF-1.4\n";
    const offsets = objects.map((body, i) => {
      const offset = Buffer.byteLength(out, "latin1");
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
      return offset;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}

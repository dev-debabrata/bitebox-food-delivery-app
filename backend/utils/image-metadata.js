/**
 * Strips private metadata from uploaded images before they are stored (same as
 * backend-django/apps/uploads/metadata.py).
 *
 * Phone photos carry EXIF data: GPS position, device, time. Review photos are public, so that data
 * must not leave with them. The file is walked block by block (no image library): JPEG keeps its
 * image data, JFIF, ICC colour profile and Adobe segments, and a minimal EXIF block with only the
 * Orientation (so portrait photos still display upright); PNG drops eXIf and text chunks; WebP
 * drops EXIF and XMP chunks. A file that does not parse as a well-formed image throws.
 */
const ORIENTATION_TAG = 0x0112;
// APP1 (EXIF, XMP), APP3–APP13 (IPTC and vendor data), APP15 and comments are dropped.
const JPEG_DROP = new Set([0xe1, 0xfe, 0xef, ...Array.from({ length: 11 }, (_, i) => 0xe3 + i)]);
const PNG_DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);
const WEBP_DROP = new Set(["EXIF", "XMP "]);

export function stripMetadata(data, kind) {
  if (kind === "jpg") return jpeg(data);
  if (kind === "png") return png(data);
  if (kind === "webp") return webp(data);
  throw new Error(`unknown image type ${kind}`);
}

function jpeg(data) {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error("not a JPEG");
  const parts = [data.subarray(0, 2)];
  let i = 2;
  let orientation = null;
  while (i < data.length) {
    if (data[i] !== 0xff) throw new Error("bad JPEG marker");
    while (i < data.length && data[i] === 0xff) i++; // fill bytes
    if (i >= data.length) break;
    const marker = data[i++];
    if (marker === 0xd9) break; // end of image before any image data
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (i + 2 > data.length) throw new Error("truncated JPEG");
    const length = data.readUInt16BE(i);
    if (length < 2 || i + length > data.length) throw new Error("bad JPEG segment length");
    if (marker === 0xda) {
      // Start of scan: the compressed image data runs to the end.
      if (orientation && orientation !== 1) {
        const app0 = parts[1]?.[1] === 0xe0 ? 2 : 1; // EXIF goes after JFIF, which comes first
        parts.splice(app0, 0, exifWithOrientation(orientation));
      }
      parts.push(Buffer.from([0xff, 0xda]), data.subarray(i));
      return Buffer.concat(parts);
    }
    if (marker === 0xe1 && orientation === null) orientation = readOrientation(data.subarray(i + 2, i + length));
    if (!JPEG_DROP.has(marker)) parts.push(Buffer.concat([Buffer.from([0xff, marker]), data.subarray(i, i + length)]));
    i += length;
  }
  throw new Error("JPEG without image data");
}

/** The EXIF Orientation (1-8) from an APP1 payload, if it is EXIF and has one. */
function readOrientation(app1) {
  if (app1.toString("latin1", 0, 6) !== "Exif\0\0") return null;
  const tiff = app1.subarray(6);
  const order = tiff.toString("latin1", 0, 2);
  if ((order !== "II" && order !== "MM") || tiff.length < 8) return null;
  const le = order === "II";
  const u16 = (at) => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at) => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let n = 0; n < count; n++) {
    const at = ifd + 2 + 12 * n;
    if (at + 12 > tiff.length) return null;
    if (u16(at) === ORIENTATION_TAG && u16(at + 2) === 3) {
      const value = u16(at + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** An APP1 segment whose EXIF holds only the Orientation tag (big-endian TIFF). */
function exifWithOrientation(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(0x2a, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(ORIENTATION_TAG, 10);
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18); // value, padded; then next IFD = 0
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function png(data) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!data.subarray(0, 8).equals(signature)) throw new Error("not a PNG");
  const parts = [signature];
  let i = 8;
  while (i + 12 <= data.length) {
    const length = data.readUInt32BE(i);
    const kind = data.toString("latin1", i + 4, i + 8);
    const end = i + 12 + length;
    if (end > data.length) throw new Error("truncated PNG chunk");
    if (!PNG_DROP.has(kind)) parts.push(data.subarray(i, end));
    i = end;
    if (kind === "IEND") return Buffer.concat(parts);
  }
  throw new Error("PNG without IEND");
}

function webp(data) {
  if (data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "WEBP")
    throw new Error("not a WebP");
  const size = data.readUInt32LE(4);
  if (size < 4 || size + 8 > data.length) throw new Error("truncated WebP");
  const end = 8 + size;
  const parts = [];
  let i = 12;
  while (i + 8 <= end) {
    const kind = data.toString("latin1", i, i + 4);
    const length = data.readUInt32LE(i + 4);
    const stop = i + 8 + length + (length & 1); // chunks are padded to an even size
    if (stop > end) throw new Error("truncated WebP chunk");
    const chunk = Buffer.from(data.subarray(i, stop));
    if (kind === "VP8X" && length >= 1) chunk[8] &= ~0x0c & 0xff; // no EXIF or XMP any more
    if (!WEBP_DROP.has(kind)) parts.push(chunk);
    i = stop;
  }
  if (!parts.length) throw new Error("WebP without image data");
  const body = Buffer.concat(parts);
  const head = Buffer.from("RIFF\0\0\0\0WEBP", "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

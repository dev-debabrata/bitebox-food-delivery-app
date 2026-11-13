"""
Strips private metadata from uploaded images before they are stored (Node: utils/image-metadata.js).

Phone photos carry EXIF data: GPS position, device, time. Review photos are public, so that data
must not leave with them. The file is walked block by block (no image library): JPEG keeps its
image data, JFIF, ICC colour profile and Adobe segments, and a minimal EXIF block with only the
Orientation (so portrait photos still display upright); PNG drops eXIf and text chunks; WebP drops
EXIF and XMP chunks. A file that does not parse as a well-formed image is rejected (ValueError).
"""

import struct

ORIENTATION_TAG = 0x0112
# JPEG markers to keep before the image data: APP0 (JFIF), APP2 (ICC profile), APP14 (Adobe colour)
# and the table/frame segments. APP1 (EXIF, XMP), APP13 (IPTC), other APPn and comments are dropped.
_JPEG_DROP = {0xE1, 0xFE, *range(0xE3, 0xEE), 0xEF}
_PNG_DROP = {b"eXIf", b"tEXt", b"iTXt", b"zTXt", b"tIME"}
_WEBP_DROP = {b"EXIF", b"XMP "}


def strip_metadata(data: bytes, kind: str) -> bytes:
    if kind == "jpg":
        return _jpeg(data)
    if kind == "png":
        return _png(data)
    if kind == "webp":
        return _webp(data)
    raise ValueError(f"unknown image type {kind}")


# --- JPEG -----------------------------------------------------------------------------------------


def _jpeg(data: bytes) -> bytes:
    if data[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")
    out, i, orientation = bytearray(b"\xff\xd8"), 2, None
    while i < len(data):
        if data[i] != 0xFF:
            raise ValueError("bad JPEG marker")
        while i < len(data) and data[i] == 0xFF:  # fill bytes
            i += 1
        if i >= len(data):
            break
        marker = data[i]
        i += 1
        if marker == 0xD9:  # end of image before any image data
            break
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:  # markers without a length
            out += bytes((0xFF, marker))
            continue
        if i + 2 > len(data):
            raise ValueError("truncated JPEG")
        length = int.from_bytes(data[i : i + 2], "big")
        if length < 2 or i + length > len(data):
            raise ValueError("bad JPEG segment length")
        if marker == 0xDA:  # start of scan: the compressed image data runs to the end
            if orientation and orientation != 1:
                at = 4 + int.from_bytes(out[4:6], "big") if out[2:4] == b"\xff\xe0" else 2
                out[at:at] = _exif_with_orientation(orientation)  # after JFIF, which comes first
            return bytes(out + b"\xff\xda" + data[i:])
        if marker == 0xE1 and orientation is None:
            orientation = _orientation(data[i + 2 : i + length])
        if marker not in _JPEG_DROP:
            out += bytes((0xFF, marker)) + data[i : i + length]
        i += length
    raise ValueError("JPEG without image data")


def _orientation(app1: bytes) -> int | None:
    """The EXIF Orientation (1-8) from an APP1 payload, if it is EXIF and has one."""
    if app1[:6] != b"Exif\x00\x00":
        return None
    tiff = app1[6:]
    order = {b"II": "<", b"MM": ">"}.get(tiff[:2])
    if order is None or len(tiff) < 8:
        return None
    (ifd,) = struct.unpack(order + "I", tiff[4:8])
    if ifd + 2 > len(tiff):
        return None
    (count,) = struct.unpack(order + "H", tiff[ifd : ifd + 2])
    for n in range(count):
        entry = tiff[ifd + 2 + 12 * n : ifd + 14 + 12 * n]
        if len(entry) < 12:
            return None
        tag, kind, _, value = struct.unpack(order + "HHIH", entry[:10])
        if tag == ORIENTATION_TAG and kind == 3:
            return value if 1 <= value <= 8 else None
    return None


def _exif_with_orientation(orientation: int) -> bytes:
    """An APP1 segment whose EXIF holds only the Orientation tag (big-endian TIFF)."""
    tiff = b"MM\x00\x2a" + struct.pack(">I", 8)
    tiff += struct.pack(">H", 1) + struct.pack(">HHIHH", ORIENTATION_TAG, 3, 1, orientation, 0)
    tiff += struct.pack(">I", 0)  # no next IFD
    payload = b"Exif\x00\x00" + tiff
    return b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload


# --- PNG ------------------------------------------------------------------------------------------


def _png(data: bytes) -> bytes:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    out, i = bytearray(data[:8]), 8
    while i + 12 <= len(data):
        length = int.from_bytes(data[i : i + 4], "big")
        kind = data[i + 4 : i + 8]
        end = i + 12 + length
        if end > len(data):
            raise ValueError("truncated PNG chunk")
        if kind not in _PNG_DROP:
            out += data[i:end]
        i = end
        if kind == b"IEND":
            return bytes(out)
    raise ValueError("PNG without IEND")


# --- WebP -----------------------------------------------------------------------------------------

_VP8X_EXIF, _VP8X_XMP = 0x08, 0x04


def _webp(data: bytes) -> bytes:
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("not a WebP")
    size = int.from_bytes(data[4:8], "little")
    if size + 8 > len(data) or size < 4:
        raise ValueError("truncated WebP")
    body, i, end = bytearray(), 12, 8 + size
    while i + 8 <= end:
        kind = data[i : i + 4]
        length = int.from_bytes(data[i + 4 : i + 8], "little")
        stop = i + 8 + length + (length & 1)  # chunks are padded to an even size
        if stop > end:
            raise ValueError("truncated WebP chunk")
        chunk = bytearray(data[i:stop])
        if kind == b"VP8X" and length >= 1:
            chunk[8] &= ~(_VP8X_EXIF | _VP8X_XMP) & 0xFF  # no metadata any more
        if kind not in _WEBP_DROP:
            body += chunk
        i = stop
    if not body:
        raise ValueError("WebP without image data")
    return b"RIFF" + (len(body) + 4).to_bytes(4, "little") + b"WEBP" + bytes(body)

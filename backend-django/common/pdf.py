"""
A small PDF writer for invoices and statements: A4 pages, Helvetica text (regular and bold),
lines, right-aligned figures. No dependency, no fonts to ship. The built-in fonts cover Latin
text only, so amounts are written "Rs. 1,234.00" (₹ is not in the standard font set).
"""

from typing import Any

WIDTH, HEIGHT = 595, 842  # A4 in points
# Helvetica advance widths (per 1000) for the characters invoices use; others ≈ 556.
_NARROW = {**dict.fromkeys(" ,.:;'|!il", 278), **dict.fromkeys("()-/[]f t", 333)}
_WIDE = {**dict.fromkeys("mwMW", 833), **dict.fromkeys("ABCDEGHKNOQRSUVXY&", 700)}


def text_width(text: str, size: float, bold: bool = False) -> float:
    units = sum(_NARROW.get(c, _WIDE.get(c, 556)) for c in text)
    return units * size / 1000 * (1.05 if bold else 1)


def _escape(text: str) -> str:
    safe = text.replace("₹", "Rs.").encode("cp1252", "replace").decode("cp1252")
    return safe.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


class Pdf:
    def __init__(self) -> None:
        self.pages: list[list[str]] = [[]]

    @property
    def ops(self) -> list[str]:
        return self.pages[-1]

    def new_page(self) -> None:
        self.pages.append([])

    def text(
        self,
        x: float,
        y: float,
        text: Any,
        size: float = 10,
        bold: bool = False,
        right: bool = False,
    ) -> None:
        """`y` counts from the top of the page. `right`: `x` is where the text ends."""
        s = str(text)
        if right:
            x -= text_width(s, size, bold)
        font = "F2" if bold else "F1"
        self.ops.append(f"BT /{font} {size} Tf {x:.1f} {HEIGHT - y:.1f} Td ({_escape(s)}) Tj ET")

    def line(self, x1: float, y: float, x2: float, width: float = 0.6, grey: float = 0.75) -> None:
        self.ops.append(
            f"{grey} G {width} w {x1:.1f} {HEIGHT - y:.1f} m {x2:.1f} {HEIGHT - y:.1f} l S 0 G"
        )

    def render(self) -> bytes:
        objects: list[bytes] = []

        def add(body: bytes) -> int:
            objects.append(body)
            return len(objects)

        catalog = add(b"")  # filled in below
        pages_id = add(b"")
        fonts = [
            add(
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            ),
            add(
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold "
                b"/Encoding /WinAnsiEncoding >>"
            ),
        ]
        kids = []
        for ops in self.pages:
            stream = "\n".join(ops).encode("cp1252", "replace")
            content = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
            kids.append(
                add(
                    (
                        f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {WIDTH} {HEIGHT}] "
                        f"/Resources << /Font << /F1 {fonts[0]} 0 R /F2 {fonts[1]} 0 R >> >> "
                        f"/Contents {content} 0 R >>"
                    ).encode()
                )
            )
        objects[catalog - 1] = f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode()
        objects[pages_id - 1] = (
            f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>"
        ).encode()

        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for number, body in enumerate(objects, start=1):
            offsets.append(len(out))
            out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
        xref = len(out)
        out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
        out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
        trailer = f"<< /Size {len(objects) + 1} /Root {catalog} 0 R >>"
        out += f"trailer\n{trailer}\nstartxref\n{xref}\n%%EOF\n".encode()
        return bytes(out)

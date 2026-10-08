"""Render the Rushcast app icons (PWA, Apple touch, badge, Open Graph card) with Pillow."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent.parent / "site" / "assets" / "icons"
A, B = (79, 140, 255), (34, 211, 238)
SS = 4  # supersampling factor


def gradient(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            f = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(A[i] + (B[i] - A[i]) * f) for i in range(3))
    return img


def wave(draw: ImageDraw.ImageDraw, s: float, ox: float, oy: float, color, width: float) -> None:
    """The logo stroke: a crowd curve rising, dipping, and easing off."""
    pts = []
    for i in range(101):
        t = i / 100
        x = 8 + 18 * t
        y = 21.5 - 10.2 * (3 * t * (1 - t) ** 2 * 1.0 + 3 * t * t * (1 - t) * 0.55 + t ** 3 * 0.75)
        y += 2.2 * (t ** 3)  # gentle tail
        pts.append((ox + x * s, oy + y * s))
    draw.line(pts, fill=color, width=round(width), joint="curve")
    r = 2.1 * s
    draw.ellipse([pts[0][0] - r, pts[0][1] - r, pts[0][0] + r, pts[0][1] + r], fill=color)
    draw.ellipse([pts[-1][0] - width / 2, pts[-1][1] - width / 2, pts[-1][0] + width / 2, pts[-1][1] + width / 2], fill=color)


def app_icon(size: int, maskable: bool = False, rounded: bool = True) -> Image.Image:
    big = size * SS
    bg = gradient(big)
    mask = Image.new("L", (big, big), 0)
    md = ImageDraw.Draw(mask)
    if rounded and not maskable:
        md.rounded_rectangle([0, 0, big - 1, big - 1], radius=round(big * 0.28), fill=255)
    else:
        md.rectangle([0, 0, big, big], fill=255)
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    img.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(img)
    inner = 0.62 if maskable else 0.8
    s = big * inner / 32
    off = (big - 32 * s) / 2
    wave(d, s, off, off, (255, 255, 255, 255), 2.6 * s)
    return img.resize((size, size), Image.LANCZOS)


def badge(size: int = 96) -> Image.Image:
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = big / 32
    wave(d, s, 0, 0, (255, 255, 255, 255), 3 * s)
    return img.resize((size, size), Image.LANCZOS)


def og_card() -> Image.Image:
    w, h = 1200, 630
    img = Image.new("RGB", (w, h), (7, 11, 20))
    glow = Image.new("RGB", (w, h), (7, 11, 20))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-200, -300, 700, 500], fill=(47, 107, 255))
    gd.ellipse([700, 250, 1500, 950], fill=(17, 181, 214))
    gd.ellipse([400, 100, 1000, 700], fill=(124, 92, 255))
    glow = glow.filter(ImageFilter.GaussianBlur(160))
    img = Image.blend(img, glow, 0.45)
    icon = app_icon(168)
    img.paste(icon, (90, 90), icon)
    d = ImageDraw.Draw(img)

    def font(size, bold=True):
        for name in (["segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"] if bold else ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"]):
            try:
                return ImageFont.truetype(name, size)
            except OSError:
                continue
        return ImageFont.load_default()

    d.text((90, 300), "Know the rush", font=font(84), fill=(238, 242, 248))
    d.text((90, 395), "before you walk.", font=font(84), fill=(120, 190, 255))
    d.text((90, 520), "Rushcast · Live campus crowd forecasts · Team Error404 · Ick-a-thon 2026", font=font(30, False), fill=(169, 180, 198))
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    app_icon(192).save(OUT / "icon-192.png")
    app_icon(512).save(OUT / "icon-512.png")
    app_icon(512, maskable=True).save(OUT / "maskable-512.png")
    app_icon(180, rounded=False).convert("RGB").save(OUT / "apple-touch-icon.png")
    badge().save(OUT / "badge-96.png")
    og_card().save(OUT / "og.png", optimize=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()

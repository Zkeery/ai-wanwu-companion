"""Create an explicitly hand-drawn offline fixture, never edit a user's photo."""
import argparse
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]


def build(output: Path):
    output.mkdir(parents=True, exist_ok=True)
    w = 320
    background = Image.new("RGB", (w, w))
    brush = ImageDraw.Draw(background)
    for y in range(w):
        brush.line((0, y, w, y), fill=(34 + y // 18, 45 + y // 15, 67 + y // 12))
    brush.ellipse((74, 265, 263, 286), fill=(28, 35, 49))
    frames = []
    for n in range(12):
        angle = n / 12 * math.tau
        frame = Image.new("RGBA", (w * 3, w * 3))
        d = ImageDraw.Draw(frame)
        dx, dy = int(5 * math.sin(angle)), int(3 * math.cos(angle))
        def box(coords):
            return tuple(int((v + (dx if i % 2 == 0 else dy)) * 3) for i, v in enumerate(coords))
        # Limbs have independent poses; the background is never in these frames.
        for sign in (-1, 1):
            x = 158 + sign * 55
            hand_y = 185 + sign * 22 * math.sin(angle)
            d.line(box((x, 176, x + sign * 27, hand_y)), fill="#d8e6e4", width=20)
            d.ellipse(box((x + sign * 27 - 8, hand_y - 8, x + sign * 27 + 8, hand_y + 8)), fill="#e7f1e9")
            foot_y = 267 - max(0, sign * 9 * math.sin(angle))
            d.line(box((158 + sign * 31, 234, 158 + sign * 35, foot_y)), fill="#cfddd9", width=22)
            d.ellipse(box((158 + sign * 35 - 16, foot_y - 6, 158 + sign * 35 + 16, foot_y + 8)), fill="#e7f1e9")
        d.ellipse(box((73, 117, 125, 192)), outline="#cfddd9", width=18)
        d.rounded_rectangle(box((106, 105, 228, 244)), radius=70, fill="#e5efe6", outline="#bed5cf", width=5)
        d.ellipse(box((106, 92, 228, 126)), fill="#f6f6df", outline="#bed5cf", width=5)
        d.ellipse(box((116, 102, 218, 119)), fill="#99724c")
        for x in (140, 192):
            d.ellipse(box((x - 10, 151, x + 10, 169)), fill="#fff9e0")
            d.ellipse(box((x - 5, 155, x + 5, 167)), fill="#714528")
            d.line(box((x - 11, 147, x + 10, 146)), fill="#574737", width=7)
        d.arc(box((143, 172, 194, 202)), 15, 155, fill="#715047", width=6)
        frames.append(frame.resize((w, w), Image.Resampling.LANCZOS))
    sheet = Image.new("RGBA", (w * len(frames), w))
    for i, frame in enumerate(frames):
        sheet.paste(frame, (i * w, 0))
    background.save(output / "background.png")
    sheet.save(output / "sprite.png")
    static = background.convert("RGBA")
    static.alpha_composite(frames[0])
    static.save(output / "static.png")
    digest = lambda file: hashlib.sha256((output / file).read_bytes()).hexdigest()
    manifest = {"version": "companion-motion-sprite-v1", "source_sha256": digest("static.png"),
                "frame_width": w, "frame_height": w, "frame_count": 12, "fps": 12,
                "sprite_file": "sprite.png", "background_file": "background.png",
                "sprite_sha256": digest("sprite.png"), "background_sha256": digest("background.png")}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("手绘动作示意已保存；模型调用0次")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    if args.write:
        build(ROOT / "frontend/public/motion-preview-assets")
    else:
        print("dry-run：仅--write制作手绘示意，不读取照片、Key或数据库")

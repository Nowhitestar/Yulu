"""Pack Yulu.icns and favicon.ico from the rasterized kit.

Usage: python3 -I pack_icons.py <kit_dir>
"""
import sys
from pathlib import Path

from PIL import Image

kit = Path(sys.argv[1])
iconset = kit / "app-icon/Yulu.iconset"


def rgba(path):
    return Image.open(path).convert("RGBA")


# The 16 and 32 px members are the simplified small-size drawings, not downscales.
base = rgba(iconset / "icon_512x512@2x.png")
extra = [rgba(iconset / name) for name in (
    "icon_16x16.png", "icon_16x16@2x.png", "icon_128x128.png", "icon_256x256.png", "icon_512x512.png")]
base.save(kit / "app-icon/Yulu.icns", format="ICNS", append_images=extra)

favicon = kit / "favicon"
rgba(favicon / "favicon-48.png").save(
    favicon / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)],
    append_images=[rgba(favicon / "favicon-16.png"), rgba(favicon / "favicon-32.png")])
print("Yulu.icns and favicon.ico written")

"""Prepare private demo assets: normalize orientation and discard metadata."""
import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageOps

parser = argparse.ArgumentParser()
parser.add_argument("--dasha", type=Path, required=True)
parser.add_argument("--ilya", type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[3]
destination = repo / ".gearbox/settings-community-demo/private-assets/portraits"
destination.mkdir(parents=True, exist_ok=True)
manifest = {"version": 1, "portraits": {}}
for lab, source in (("dasha", args.dasha), ("ilya", args.ilya)):
    with Image.open(source) as original:
        photo = ImageOps.exif_transpose(original).convert("RGB")
        target = destination / f"{lab}.webp"
        # Lossless encoding preserves the normalized pixels. No source metadata
        # or original path is carried into the image or its public manifest.
        photo.save(target, "WEBP", lossless=True, exif=b"", icc_profile=b"", xmp=b"")
    with Image.open(target) as check:
        if check.getexif() or any(check.info.get(key) for key in ("exif", "icc_profile", "xmp")):
            raise RuntimeError(f"Metadata remained in {lab}'s prepared portrait")
        manifest["portraits"][lab] = {
            "file": target.name,
            "width": check.width,
            "height": check.height,
            "metadataRemoved": True,
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        }
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print("Prepared two private portraits; orientation normalized and all EXIF/GPS metadata removed.")

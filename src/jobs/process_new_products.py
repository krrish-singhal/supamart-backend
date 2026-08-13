import os
import re
import json
import sys
from PIL import Image, ImageFilter
from rembg import remove, new_session

SRC_DIR = "/media/krrish/Linux Partition/SupaMart/customer/assets/New_Products"
MAPPING_FILE = "/media/krrish/Linux Partition/SupaMart/backend/src/jobs/data/newProductsImageMapping.json"
CUSTOMER_DST = "/media/krrish/Linux Partition/SupaMart/customer/assets/Cleaned_Products"
ADMIN_DST = "/media/krrish/Linux Partition/SupaMart/admin-portal/public/product-images"

TARGET = 1080
PAD_FRAC = 0.08

SESSION = new_session("u2net")


def sanitize(name):
    # Same convention already used across both apps' bundled product images: "&" and "+"
    # get spelled out (Vite's static file serving 500s on those characters in a path),
    # parentheses are dropped, whitespace collapsed. Filenames differ from the Firestore
    # product name key for exactly these cases. "/" additionally needs handling here (the
    # 196-item catalog has several slash-containing names, e.g. "Santoor Soap
    # (White/Set)") — a literal "/" would otherwise be read as a path separator.
    s = name.replace('&', ' and ').replace('+', ' Plus ').replace('/', ' ')
    s = re.sub(r'[()]', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def has_real_transparency(im):
    # An image "already has its background removed" only if some pixels are actually
    # transparent (alpha < 255) somewhere other than a fully-opaque rectangle — a plain
    # opaque photo converted to RGBA still reports an alpha channel, but every pixel is
    # 255. Re-running rembg on a photo that's already been cut out risks eating into the
    # product itself (rembg re-segments from scratch, it doesn't know the existing edge
    # is intentional) — see the user's explicit instruction not to do that.
    if im.mode != 'RGBA':
        return False
    alpha = im.split()[-1]
    extrema = alpha.getextrema()
    return extrema[0] < 250  # some meaningfully non-opaque pixels exist


def clean_and_style(src_path, out_path):
    im = Image.open(src_path).convert("RGBA")
    already_cut_out = has_real_transparency(im)
    if not already_cut_out:
        im = remove(im, session=SESSION)

    alpha = im.split()[-1]
    bbox = alpha.getbbox()
    if bbox:
        im = im.crop(bbox)
    w, h = im.size
    side = max(w, h)
    pad = max(2, int(side * PAD_FRAC))
    canvas_side = side + 2 * pad
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    canvas.paste(im, ((canvas_side - w) // 2, (canvas_side - h) // 2), im)
    big = canvas.resize((TARGET, TARGET), Image.LANCZOS)
    smoothed = big.filter(ImageFilter.GaussianBlur(radius=0.5))
    sharpened = smoothed.filter(ImageFilter.UnsharpMask(radius=2.2, percent=150, threshold=2))
    sharpened.save(out_path, optimize=True)
    return already_cut_out


def main():
    with open(MAPPING_FILE, encoding="utf-8") as f:
        mapping = json.load(f)

    os.makedirs(CUSTOMER_DST, exist_ok=True)
    os.makedirs(ADMIN_DST, exist_ok=True)

    ok, errs = [], []
    for src_name, product_name in mapping.items():
        src_path = os.path.join(SRC_DIR, src_name)
        filename = sanitize(product_name) + ".png"
        customer_out = os.path.join(CUSTOMER_DST, filename)
        admin_out = os.path.join(ADMIN_DST, filename)
        try:
            already_cut_out = clean_and_style(src_path, customer_out)
            # Same processed bytes for both apps -- copy rather than reprocess.
            import shutil
            shutil.copyfile(customer_out, admin_out)
            ok.append((product_name, filename, already_cut_out))
            print(f"OK  {'[had-alpha]' if already_cut_out else '[bg-removed]':12s} {product_name} -> {filename}")
        except Exception as e:
            errs.append((product_name, str(e)))
            print(f"ERR {product_name}: {e}", file=sys.stderr)

    print(f"\n{len(ok)} processed, {len(errs)} errors")
    if errs:
        for name, e in errs:
            print("  FAILED:", name, "-", e)


if __name__ == "__main__":
    main()

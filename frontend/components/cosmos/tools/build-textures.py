"""Builds the landing textures from the NASA SVS downloads (see public/cosmos/README.md)."""
import sys, os
import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None
S = sys.argv[1]           # scratch dir with dl/
OUT = sys.argv[2]         # frontend/public/cosmos
dl = os.path.join(S, 'dl')

def save(im, name, q=84):
    p = os.path.join(OUT, name)
    im.save(p, 'JPEG', quality=q, optimize=True, progressive=True)
    print(name, im.size, os.path.getsize(p))

# 1. Day: Blue Marble Next Generation, no clouds (SVS 3615), 2048x1024 as published.
day = Image.open(os.path.join(dl, 'earth_noClouds.0330.jpg')).convert('RGB')
save(day, 'earth-day.jpg', 86)

# 2. Clouds: SVS 3615 publishes the same Earth with and without clouds; the cloud
#    layer is their difference (white over the cloud-free map), as a greyscale alpha.
cl = np.asarray(Image.open(os.path.join(dl, 'flat_earth03.jpg')).convert('RGB'), dtype=np.float32) / 255
nc = np.asarray(day, dtype=np.float32) / 255
# alpha such that cl = nc*(1-a) + 1*a  ->  a = (cl-nc)/(1-nc), averaged over channels
a = (cl - nc) / np.maximum(1 - nc, 0.04)
a = np.clip(a.mean(axis=2), 0, 1)
a = np.clip((a - 0.30) / 0.55, 0, 1) ** 1.2
# the art-directed source has a soft haze band over the Southern Ocean; damp it
lat = np.linspace(90, -90, a.shape[0])[:, None]
# and the source only carries clouds between ~55S and ~56N: fade towards those edges
t = np.clip((56 - np.abs(lat)) / 12, 0, 1)
a *= t * t * (3 - 2 * t)
save(Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6)), 'earth-clouds.jpg', 80)

# 3. Night: Earth at Night 2012 (Suomi NPP VIIRS), 5760x2880 -> 2048x1024.
night = Image.open(os.path.join(dl, 'earthatnight2012.png')).convert('RGB').resize((2048, 1024), Image.LANCZOS)
save(night, 'earth-night.jpg', 86)

# 4. Moon: CGI Moon Kit LROC colour, 2048 -> 1024.
moon = Image.open(os.path.join(dl, 'lroc_color_2k.jpg')).convert('RGB').resize((1024, 512), Image.LANCZOS)
save(moon, 'moon.jpg', 84)

# 5. Milky Way: Deep Star Maps 2020 'milkyway' layer (linear HDR), asinh stretch.
raw = np.fromfile(os.path.join(S, 'mw.raw'), dtype=np.float32).reshape(3, 1024, 2048)  # gbrp planar
g, b, r = raw
rgb = np.stack([r, g, b], axis=-1)
rgb = np.nan_to_num(np.clip(rgb, 0, None))
lum = rgb.mean(axis=2)
print('mw lum percentiles', [float(np.percentile(lum, p)) for p in (1, 50, 90, 99, 99.9)])
ref = np.percentile(lum, 99.7)
x = rgb / ref
st = np.arcsinh(x * 6) / np.arcsinh(6)
st = np.clip(st, 0, 1) ** 1.1
save(Image.fromarray((st * 255).astype(np.uint8)), 'milkyway.jpg', 82)

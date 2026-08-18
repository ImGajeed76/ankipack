# Brand asset sources

The logo is an HTML wordmark screenshotted with headless Chrome, not a drawn
asset. "Anki" is DM Mono 500, "pack" is Nanum Pen Script, then the 📦 emoji.
Both fonts load from Google Fonts at render time, so rendering needs network.

`ankipack_logo.html` and `ankipack_logo_dark.html` are the originals. The
`banner-*` and `social-*` files are the same lockup at the sizes each output
needs, differing only in `font-size`.

| Source            | Window    | Output                    | Used for                   |
| ----------------- | --------- | ------------------------- | -------------------------- |
| `banner-light`    | 1200x320  | `../banner-light.png`     | README, light theme        |
| `banner-dark`     | 1200x320  | `../banner-dark.png`      | README, dark theme         |
| `social-light`    | 640x320   | `../social-light.png`     | GitHub social preview      |
| `social-dark`     | 640x320   | `../social-dark.png`      | GitHub social preview      |

Every output is rendered at `--force-device-scale-factor=2`, so a 1200x320
window gives a 2400x640 file and 640x320 gives the 1280x640 GitHub wants.

```bash
chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1200,320 \
  --virtual-time-budget=8000 \
  --screenshot=/abs/path/out.png "file:///abs/path/in.html"
```

Pass absolute paths. A relative `--screenshot` writes to the working directory,
not next to the source.

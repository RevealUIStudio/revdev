# Studio app icons

`icon-mark.svg` is the tiled Circuit-R (32px and up). `mark-untiled.svg`
is the flat mark for 16/24 so the Windows taskbar is not a smudge.
Both come from `@revealui/presentation` brand masters. Do not hand-draw
replacements.

```bash
cd apps/studio && node scripts/gen-icons.mjs
```

The generator builds the Windows ICO from square PNG payloads at 16, 24, 32,
64 and 256 pixels. The 256-pixel payload is resized explicitly; the ICO
builder rejects any directory/payload dimension mismatch before publishing
the ICO. The maintained generator tests also check every entry in the
checked-in artifact.

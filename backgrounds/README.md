# backgrounds/

Put **background / scene reference images** here. They work exactly like
`characters/`: a prompt automatically pulls in any background whose **name or
alias** appears in it, and that image is attached as a reference for the scene.

A background's match terms come from:
- its **filename** (without extension), e.g. `sunset.png` → `sunset`,
  `green-field.png` → `green field`;
- the filename with a **trailing number removed** (`sunset2.png` also matches
  "sunset");
- an optional **alias file** — a `.txt` with the same base name (`sunset.txt`)
  with comma- or newline-separated aliases. Edit it in the control panel
  (`open-ui.bat` → **Backgrounds** tab → the *aliases* box under each image).

Examples:
- `sunset.png` + `sunset.txt` = `orange, fire, ancient, ritual` → matches fiery /
  ancient scenes
- `underwater.png` + alias `ocean, sea, blue, deep` → matches underwater scenes
- `outdoor.png` + alias `nature, field, grass, sky` → matches outdoor scenes

Notes:
- Supported types: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`.
- **At most one** background is attached per prompt (the first match), so two
  backgrounds never conflict.
- When a prompt matches **no character and no background**, the base style image
  (`base_character/`) is attached instead.
- Add `{noref}` to a prompt to skip all references (characters, background, base).
- Turn the whole feature off with `"backgrounds": false` in `config.json`.

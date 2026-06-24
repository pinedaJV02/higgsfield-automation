# characters/

Put **character reference images** here. The system **automatically picks which
characters belong in each prompt**: a character is attached whenever its **name or
one of its aliases** appears in the prompt (as a whole word), so the character looks
consistent across frames.

A character's match terms come from:
- its **filename** (without extension), e.g. `dog.png` → `dog`, `rescue-dog.png` →
  `rescue dog`;
- the filename with a **trailing number removed**, so `Dog1.png` also matches "dog";
- an optional **alias file** — a `.txt` with the same base name (`Dog1.txt`)
  containing comma- or newline-separated aliases. This is the best way to control
  matching, and you can edit it right in the control panel (`open-ui.bat` →
  **Characters** tab → the *aliases* box under each image).

Examples:
- `dog.png`        → matches "dog" / "dogs"
- `Dog1.png` + `Dog1.txt` = `puppy, brown dog` → matches "dog", "puppy", "brown dog"
- `rescue-dog.png` → matches the phrase "rescue dog"

> Tip: very generic single words (`a`, `the`, `main`, `character`, …) are ignored so
> they don't match every prompt. A filename like `main_character.png` won't match on
> its own — give it an alias file listing the real terms (e.g. `dog, puppy`).

Notes:
- Supported types: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`.
- **Lock-first-generation:** the first time a character is generated, that output
  becomes the locked reference reused for every later prompt — so even characters
  with no file here stay consistent once they first appear.
- Add `{noref}` anywhere in a prompt to skip references for that one prompt.
- Turn the whole feature off with `"references": false` in `config.json`.

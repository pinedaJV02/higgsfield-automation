# Higgsfield Batch Generator

Give it a **list of prompts**, get back the **images** — generated on higgsfield.ai with
the **Unlimited** toggle ON (so no credits are spent) and saved to a folder.

It works by driving your **real Google Chrome** (attached over the DevTools protocol), which
sidesteps Google's "this browser may not be secure" login block.

---

## 1. First-time setup (per computer)
1. Install **Node.js** (LTS) — <https://nodejs.org>
2. Install **Google Chrome** (most PCs already have it)
3. Double-click **`setup.bat`** (runs `npm install`)

## 2. Add your prompts
Edit **`prompts.txt`** (or use the **Prompts** tab in the control panel below). You can paste a
**timestamped script as-is** — `[MM:SS]` markers split it into prompts and the timestamp names the
output file — or just write **one prompt per line**. Blank lines and `#` comments are ignored.

```
[00:00] a ballerina holding a sword
[00:03] john wick eating spaghetti
[00:07] a dog searching through a rubble building
```

## Control panel (easiest way — `open-ui.bat`)
Prefer clicking over editing files? Double-click **`open-ui.bat`**. It starts a small
local web app (at `http://127.0.0.1:5179`) and opens it in your browser, where you can:
- **Config** — edit every `config.json` setting with the right control (toggles, numbers,
  text) and **Save**.
- **Prompts** — paste/edit your prompt list; it shows the parsed prompt count.
- **Characters** — drag-and-drop reference images into `characters/` and delete them.
- **Base style** — set the always-on base style image and edit the instruction appended to
  every prompt.
- **Run** — click **Run batch** and watch the live console output; **Stop** to cancel.
- **Output** — browse the generated images with their dimensions (flags small/invalid ones).

The page runs **locally only** (bound to `127.0.0.1`) and just drives the same scripts as
the `.bat` files — all the credit/CAPTCHA protections still apply. Leave the
`open-ui.bat` window open while you use it; close it to stop the UI.

## 3. Run
Double-click **`run-batch.bat`** (or use the **Run** tab in the control panel above).

- A Chrome window opens. **On the first run, log in to Higgsfield** (use your Google account —
  this is real Chrome, so Google allows it). The login is saved in `chrome-profile/` and reused,
  so later runs are unattended.
- The tool first **switches to the configured model** (e.g. Seedream 4.5) and verifies the
  **Unlimited** toggle exists. If it can't (wrong model / no Unlimited toggle) it **aborts before
  generating anything**, so a misconfigured run never wastes time or credits.
- For each prompt the tool: confirms **Unlimited is ON** (unless you turned it off), attaches any
  matching **character references**, types the prompt, **waits for the references to finish uploading**,
  clicks **Generate**, waits for the image, and downloads it full-resolution into **`output/`**.
- Files are named after the prompt's **timestamp** (e.g. `00_13.png` for `[00:13]`). Prompts without
  a timestamp fall back to `NN_<prompt-slug>_<hhmmddMM>.png`.

When it finishes it: **rescans for any timed-out prompts** whose images finished late and downloads
them, then runs a **fulfillment check** that flags any prompt whose image is missing or invalid.

## Character references & consistency (`characters/`)
Drop reference images in **`characters/`** and the tool **automatically attaches the right ones to
each prompt**: a character is matched when its **name or an alias** appears in the prompt. Matching
uses the filename (`dog.png` → `dog`), the filename with a trailing number removed (`Dog1.png` also
matches "dog"), and an optional **alias file** — a same-named `.txt` (`Dog1.txt` = `dog, puppy, brown
dog`) you can edit right in the control panel (**Characters** tab → the *aliases* box under each
image). The **first generated image of a character is locked** and reused for every later prompt, so
characters stay consistent across frames — even ones with no starter file. Add `{noref}` to a prompt
to skip references for it, or set `"references": false` to disable the feature. See
`characters/README.md`.

## Base style image (`base_character/`)
Unlike per-character references (which are keyword-matched), the **base style image** in
**`base_character/`** is **always on** — it's attached as a reference to **every** prompt so all
images share one art style, and it acts as the template for any new character (reuse the base figure,
change only a minor feature or the outfit). An editable **instruction** expresses the same intent in
words and is appended to each prompt's text whenever the base image is attached. Manage both from the
control panel's **Base style** tab: the current image (uploading a new one **replaces** it) and the
instruction textarea (blank = built-in default, stored as `instruction.txt`). The base is never
locked and never keyword-matched. Add `{noref}` to a prompt to skip it (image and instruction) for
that prompt, or turn the whole feature off with `"useBaseImage": false`.

## Prompts (`prompts.txt`)
Paste a timestamped script directly — `[MM:SS]` (or `[HH:MM:SS]`) markers split it into prompts, and
each prompt can span multiple lines. Plain one-prompt-per-line files also still work. Lines starting
with `#` are comments.

## How it protects your credits
When `unlimited` is `true` (default), the tool **only clicks Generate after confirming the Unlimited
toggle is ON**; if it can't, it **skips that prompt** rather than spend a paid credit. Set
`unlimited` to `false` to deliberately spend credits — the tool then warns and generates without the
guard.

## Bot detection / CAPTCHAs
Higgsfield occasionally shows a "Verification Required" slider. The tool uses human-like pacing
(hover, pauses, realistic typing) to avoid triggering it, **but it cannot solve one**. If a
CAPTCHA appears, the batch **stops and reports** which prompts remain — solve the slider in the
Chrome window, then re-run to continue with the rest.

## Content moderation (NSFW) & `safety.txt`
If Higgsfield rejects a generation as NSFW / content-policy, the tool **detects the rejection
immediately** (instead of waiting out the full timeout) and **automatically retries that prompt once**
with a short **safety preamble** prepended. If the retry is still rejected, the prompt is reported as
`rejected (NSFW/moderation)` in the summary and the batch moves on. Edit the preamble in **`safety.txt`**
(blank/missing → a built-in default), e.g. *"Non-graphic educational doodle illustration. No gore,
blood, injury detail, nudity, or violence — symbolic hand-drawn stick-figure style only."*

## Settings (`config.json`)
| Field | Meaning | Default |
|-------|---------|---------|
| `model` | Model id (URL `?model=`) | `seedream_v4_5` |
| `modelLabel` | Exact picker text (auto-derived from `model` if empty) | `""` |
| `ratio` | Aspect ratio | `16:9` |
| `quality` | Quality label | `2K` |
| `unlimited` | `true` = credit-free (with guard); `false` = spend credits | `true` |
| `references` | Attach matching `characters/` images to prompts | `true` |
| `charactersDir` | Folder of character reference images | `./characters` |
| `useBaseImage` | Attach the base style image + instruction to every prompt | `true` |
| `baseCharacterDir` | Folder holding the base style image (`instruction.txt`) | `./base_character` |
| `outputDir` | Where images are saved | `./output` |
| `timeoutMs` | Max wait per image (ms) | `300000` |
| `stepDelayMs` | Base pause between prompts (ms) | `4000` |
| `chromePort` | Chrome remote-debugging port | `9222` |
| `chromePath` | Chrome exe (auto-detected if empty) | `""` |
| `uiPort` | Port for the `open-ui.bat` control panel | `5179` |

## How it works (for maintainers)
- `src/browser.js` — launches a **normal** Chrome with `--remote-debugging-port` and a
  dedicated `chrome-profile/`, then `chromium.connectOverCDP(...)`. Because Chrome is launched
  plainly (no automation switches), `navigator.webdriver` is `false` and Google accepts login.
- `src/higgsfield.js` — all selectors (`SEL`) + actions: `selectModel` / `verifyModelAndUnlimited`
  (switch to the configured model and confirm the Unlimited toggle exists), `ensureUnlimitedOn`
  (credit guard), `attachReferences` / `clearReferences` / `waitForUploadsComplete` (upload refs and
  wait for them to finish), `setPrompt` (Lexical editor), `generate`, `waitForResult`,
  `moderationPhrases` / `newModeration` (NSFW detection by baseline-diff), `downloadNewest`,
  `isCaptcha`. If the model picker text differs from what's auto-derived, set `modelLabel` in
  `config.json` (no code change) or repair `SEL.modelPicker` / `SEL.modelOption`.
- `src/index.js` — the batch loop: base + character reference attach with upload-wait, NSFW
  retry-with-safety, human pacing, stop-and-report on CAPTCHA, timeout rescan, and the fulfillment
  check.
- `src/config.js` / `src/download.js` — config + prompts/style/safety/characters/base loading, and
  saving downloads (`imageInfo` powers the fulfillment check and the UI gallery dims).
- `src/server.js` + `ui/index.html` — the zero-dependency `open-ui.bat` control panel
  (127.0.0.1 only): edit config/prompts/characters/base, run the batch with a live log, browse output.

> **Requires Chrome installed** on the machine. Windows-focused (paths/scripts).
> See [FUNCTIONALITY.md](FUNCTIONALITY.md) for the complete feature spec, and
> [AGENT_HANDOFF.md](AGENT_HANDOFF.md) for the full history, live-confirmed selectors, and gotchas.

# Functionality reference

A complete inventory of intended functionality, split between the **automation
engine** (the batch generator) and the **web UI control panel**. This is the
behavioral spec — for setup/usage see [README.md](README.md), for maintainer
selector notes see [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

---

## A. Higgsfield automation engine
`run-batch.bat` → [src/index.js](src/index.js), [src/higgsfield.js](src/higgsfield.js),
[src/browser.js](src/browser.js), [src/config.js](src/config.js),
[src/download.js](src/download.js)

### Browser & session management
- Launches **real Chrome** (not Playwright's automation Chromium) with a remote-debugging
  port and a **dedicated profile** (`chrome-profile/`), so Google sign-in is accepted.
- Attaches via Playwright over CDP; **reuses an already-running Chrome** on the port
  instead of launching a second instance.
- Leaves Chrome running after a batch (keeps the session warm); drops only the CDP connection.
- **First-run login flow**: waits up to 5 minutes for manual login, then auto-detects readiness.
- Detects a **stale Chrome holding the profile lock** and emits a clear error.
- Auto-dismisses the cookie banner.

### Inputs & configuration
- **`config.json`** fields: `model`, `modelLabel`, `ratio`, `quality`, `unlimited`,
  `references`, `charactersDir`, `useBaseImage`, `baseCharacterDir`, `outputDir`,
  `timeoutMs`, `stepDelayMs`, `chromePort`, `chromePath`, `uiPort` — with auto Chrome-path
  detection and auto-created folders.
- **`prompts.txt`**: auto-detects two formats — timestamped `[MM:SS]`/`[HH:MM:SS]` blocks
  (a prompt may span multiple lines) or plain one-per-line; `#` comment lines ignored; the
  timestamp becomes the output filename.
- **`style.txt`**: a suffix appended to every prompt.
- **`safety.txt`**: an editable preamble prepended **only on an NSFW retry** (built-in
  default if the file is blank/missing).

### Model selection & credit protection
- **Explicit, verified model switch** (`selectModel`) with defensive selector fallbacks and
  a `modelLabel` override for the exact picker text.
- **Fail-fast**: if the target model + Unlimited toggle can't be verified before the loop,
  the entire batch aborts with one clear message (nothing wasted).
- **Unlimited ON** → credit guard runs (`ensureUnlimitedOn`), re-verified before every
  Generate, never spends a credit; **OFF** → logs a clear "spending credits" warning.
- **Generate-button guard**: refuses to click if the matched target is actually the
  Unlimited toggle (which also reads "Unlimited").

### Character & base references
- **`characters/`**: each image is a character; its keyword is the filename
  (`Dog1.png` → `dog1`, `rescue-dog.png` → `rescue dog`).
- **Smart auto-matching** to a prompt: filename keyword, the keyword with a trailing number
  stripped (`Dog1` → also "dog"), editable `<name>.txt` alias terms, plural/singular
  tolerance, and a stopword filter so generic words don't over-match.
- **Base style image** (`base_character/`): attached to **every** prompt as a global style
  anchor, with an editable instruction (`instruction.txt`) appended to the prompt text.
- **`{noref}`** token disables references for a single prompt (and is stripped from the text).
- Attaches via the hidden file input (no OS dialog); **clears references between prompts**;
  de-dupes the reference list (base first, then matched characters).
- **Waits for uploads to fully complete** before generating (`waitForUploadsComplete`);
  warns and proceeds if completion can't be confirmed in the window.
- **Lock-first-generation**: the first generated image of a character is locked and reused
  as its reference in later prompts for visual consistency.

### Generation, detection & resilience
- Sets ratio/quality once per batch (no-op if already correct).
- Types the prompt into the Lexical editor with **human-like pacing** and a length-scaled
  typing timeout (long prompts don't spuriously time out).
- **Result detection** by the newest `hf_<timestamp>` in the feed (robust to the virtualized
  list with no stable DOM order).
- **CAPTCHA detection** → stops the batch and reports the remaining prompts to re-run.
- **NSFW / content-policy detection** via baseline-diff (only text that appears *after*
  Generate counts, so persistent UI labels never false-trip) with a persistence re-confirm
  → **auto-retries once** with the safety preamble; a second rejection is marked
  `rejected (NSFW/moderation)` and the batch continues.
- **Timeout handling** with an actionable message.

### Download & verification
- Downloads at **full resolution**: derives the native original asset from the image proxy
  URL, with ordered fallbacks (proxy hi-res PNG → hover download button → on-screen proxy
  src); logs which path was used and the saved pixel dimensions.
- Filenames from the prompt timestamp or `NN_<slug>_<stamp>`, **sanitized** for Windows and
  **uniquified** so nothing is overwritten.
- **Post-batch rescan** recovers timed-out prompts whose images finished after we gave up
  (matched by feed timestamp).
- **File-level fulfillment check**: every output must exist, be a readable image, be
  ≥1000px on the long side and ≥50KB — otherwise it's FLAGGED.
- Final **summary**: OK / failed per prompt, count saved, and remaining prompts if the batch
  stopped early.

### Pacing / anti-bot
- Human-like pauses, hovers, and realistic typing throughout to avoid triggering the
  bot-detection slider.

---

## B. Web UI control panel
`open-ui.bat` → [src/server.js](src/server.js) + [ui/index.html](ui/index.html)

### Server
- **Zero-dependency** Node `http` server, bound to **127.0.0.1 only** (local control surface);
  opens the browser to the UI on launch.
- **Path-guarded** file writes/deletes; uploads arrive as **base64 JSON** (no multipart
  parser); reuses the same `loadConfig`/`loadPrompts`/`loadCharacters` modules for read &
  validation; spawns `src/index.js` unchanged for runs.
- **One batch run at a time** — a second `/api/run` is refused while one is active.

### Tabs
1. **Config** — every `config.json` field rendered with the right control (toggle / number /
   text) from the defaults shape; **Save** (server-validated, pretty-printed to disk) +
   **Reload**; validation errors shown as a toast.
2. **Prompts** — a textarea bound to `prompts.txt` with a live **parsed-count** badge;
   Save + Reload.
3. **Characters** — drag-drop / file-picker upload, a thumbnail grid, per-image **delete**,
   and an inline **aliases editor** that writes each `<name>.txt` (blur/Enter to save).
4. **Base style** — current base-image **preview**, a **replace** upload (removes the old
   image first), an **instruction** editor with Save + Reset-to-default, and a pointer to
   the `useBaseImage` toggle on the Config tab.
5. **Run** — **Run batch** (spawns the batch), **Stop** (kills the whole process tree
   including spawned Chrome), a **live log** via Server-Sent Events (auto-scroll, stderr
   colored), Clear log, and a live/idle status dot.
6. **Output** — a gallery of `output/` images with dimensions + file size, a **red-border
   flag** on small/invalid images, and Refresh.

### API & static routes
- `GET/POST /api/config`, `/api/prompts`, `/api/characters` (+ `DELETE`, + `/description`),
  `/api/base` (+ `/image`, + `/instruction`), `/api/output`, `/api/run` (+ `/stop`,
  + `/stream` SSE).
- Static serving of `/characters/`, `/output/`, `/base/`, and `/ui/`.
- All existing **credit / CAPTCHA / Unlimited** protections apply, since the UI launches the
  batch exactly as `run-batch.bat` does.

---

## Known gaps / notes
- **`safety.txt` is file-edited only** — there's no UI editor for it yet (a natural follow-up
  would add it to the Base style tab).
- **Selector "repair points"** (model picker, reference-upload thumbnails, moderation
  phrasing, per-image download button) are defensive locators confirmed against the live UI
  and updated when Higgsfield changes — by design, not defects. They live in `SEL` /
  `MODERATION_RE` in [src/higgsfield.js](src/higgsfield.js).

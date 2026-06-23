# Higgsfield Automation — Agent Handoff Notes

_Last updated: 2026-06-23. Read this first if you are picking up this project._

## Goal
Unattended batch image generation on **higgsfield.ai** (account `pinedajv02@gmail.com`):
the user puts prompts in `prompts.txt` (or uses the web control panel), runs one command, and
gets the images in `output/`. Hard requirements: **Unlimited toggle ON so NO credits are spent**
(optional — can be turned off), and **no Google login block**.

> **For the full behavioral spec** of every feature (engine + UI), see
> [FUNCTIONALITY.md](FUNCTIONALITY.md). This file is the maintainer history + live-confirmed
> selectors + gotchas.

## ✅ Status (2026-06-23): RUN END-TO-END SUCCESSFULLY
Confirmed working via the **web UI**: a 3-prompt batch generated and downloaded **3/3 full-res
images** (`2560×1440`) into `output/` (`01_00.png`, `01_02.png`, `01_04.png`), with the model
switch, base-image + character-reference attach, upload-wait, prompt typing, Generate, result
detection, full-res download, and the fulfillment check all passing. The earlier "images not
downloading" symptom was a *downstream* effect of two bugs since fixed (see 2026-06-23 features):
the prompt-typing timeout and an NSFW false-positive — neither was a download bug.

## CURRENT APPROACH (active): Playwright batch attached to real Chrome via CDP
The Claude-in-Chrome extension and the earlier Playwright-launched-Chromium versions are both
**superseded**. The tool now:
1. Spawns a **normal** Chrome (`src/browser.js`): `chrome.exe --remote-debugging-port=9222
   --user-data-dir=<root>\chrome-profile ...` then `chromium.connectOverCDP(...)`.
   - Because Chrome is launched plainly (NOT via Playwright's automation launcher),
     `navigator.webdriver === false` and there's no automation banner → **Google accepts the
     login**. This is the fix for the login problem. First run: user logs in once in that
     window; the session persists in `chrome-profile/`.
2. Runs the batch (`src/index.js`): **switch to the configured model + verify (Unlimited toggle
   required only when `cfg.unlimited`)** → for each prompt → (credit guard if unlimited) → attach
   matching character references → type prompt → Generate → wait for a *stable* result by
   timestamp → download native full-res → save (named by the prompt's timestamp). After the loop:
   **rescan the feed for timed-out prompts** and download any that finished late, then a
   **file-level fulfillment check** flags missing/invalid images.

### Features added 2026-06-22 (character refs, unlimited switch, rescan, fulfillment)
- **Character references (`characters/` folder).** `loadCharacters()` maps each image filename to a
  keyword (`dog.png`→`dog`, `rescue-dog.png`→`rescue dog`). `matchCharacters()` (in index.js) does
  whole-word matching against the prompt; matched images are attached as references. `{noref}` in a
  prompt skips refs; `config.references=false` disables the feature.
- **Lock-first-generation.** index.js keeps a `locked` map; the first generated image for a
  character becomes its reference for later prompts (so characters stay consistent, even with no
  starter file).
- **Reference upload — CONFIRMED LIVE 2026-06-22.** The upload is a hidden `input[type="file"]`
  (sr-only, single-file, `accept` jpeg/png/webp). `attachReferences()` calls `setInputFiles` on the
  **last** input (each attach consumes one input and reveals a fresh empty one) and waits for the
  thumbnail to render. Thumbnails are `div.touch-none.relative`; `clearReferences()` clicks the
  remove button inside each until none remain. Selectors: `SEL.uploadInput`, `SEL.uploadButton`,
  `SEL.referenceThumb`, `SEL.referenceRemove`.
- **Unlimited switch.** `cfg.unlimited` is now honored: `true` keeps the credit guard + requires the
  toggle; `false` skips the guard and generates spending credits (with a warning).
- **Timeout rescan.** `hf.listResults()` returns all feed images `[{src,stamp}]`; after the loop,
  index.js matches each timed-out prompt to the first feed stamp newer than its pre-generate stamp
  and downloads it (`ok (recovered)`).
- **Fulfillment check.** `imageInfo()` (download.js) reads PNG/JPEG/WEBP dims+size; index.js flags
  any prompt with a missing/unreadable/too-small image.

### Features added 2026-06-23 (web UI, base style, smart matching, uploads, NSFW)
- **Web control panel (`open-ui.bat` → `src/server.js` + `ui/index.html`).** A zero-dependency
  Node `http` server (127.0.0.1 only) serving a single-page UI: edit `config.json` (typed
  controls), `prompts.txt`, character images + aliases, the base style image + instruction; launch
  the batch and watch the **live log over SSE**; Stop a run (kills the process tree); browse the
  `output/` gallery. Uploads are base64 JSON (no multipart lib). All file writes are path-guarded.
  **Confirmed working live 2026-06-23** (every tab + endpoint exercised).
- **Base style image (`base_character/`).** `loadBaseCharacter()` (config.js) returns the first
  image + an instruction (`instruction.txt` or `DEFAULT_BASE_INSTRUCTION`). index.js attaches it as
  a reference to **every** prompt (base first, then matched characters, de-duped) and appends the
  instruction to the prompt text. Always-on (not keyword-matched), never locked. Toggle:
  `useBaseImage`. Managed from the UI **Base style** tab.
- **Smarter character matching.** `loadCharacters()` now returns `{keyword,file,terms,description}`.
  `buildTerms()` adds: the keyword, the keyword with a trailing number stripped (`Dog1`→"dog"), and
  comma/newline aliases from a sibling `<base>.txt` (editable in the UI). `matchCharacters()` /
  `termInText()` (index.js) match any term as a whole word with plural/singular tolerance; a
  stopword set blocks generic words. **Confirmed live:** prompt "…dog…" matched `Dog1.png`.
- **Wait for reference uploads before generating.** `waitForUploadsComplete(expectedCount)`
  (higgsfield.js) polls until every thumbnail `<img>` is a fully-loaded remote `http(s)` URL (not
  `blob:`/`data:`) with no spinner, stable for 2 polls. Called after typing, before Generate.
  Per the user's choice it **warns and proceeds** if it can't confirm in 60s (doesn't block). This
  fixed "generation started before uploads finished." **Repair point:** the exact upload-done
  signal — confirm live and tighten if the UI changes.
- **NSFW / content-policy detection + retry.** `ModerationError`, `MODERATION_RE`, and the
  baseline-diff methods `moderationPhrases()` / `newModeration(baseline)` / `waitForModerationClear()`
  (higgsfield.js). `waitForResult()` throws `ModerationError` only on moderation text that is **new
  vs a baseline captured before Generate** (so persistent UI copy like an "NSFW" filter label never
  false-trips), re-confirmed after 0.8s. index.js retries the prompt **once** with an editable
  safety preamble (`safety.txt` / `loadSafety()` / `DEFAULT_SAFETY_PREAMBLE` in config.js) prepended;
  a second rejection → status `rejected (NSFW/moderation)` and the batch continues. **Repair point:**
  `MODERATION_RE` wording (the baseline-diff already prevents false positives; tune only if a real
  rejection is missed).
- **Prompt-typing timeout fix.** `setPrompt()` types at `delay:15`ms with a **length-scaled**
  Playwright timeout, so long prompts (scene + style + base instruction) no longer abort mid-type at
  the default 30s action timeout (which previously stopped the run before Generate).

### ⚠ Known repair point: model switching (fixed 2026-06-22, confirmed live 2026-06-23)
The `?model=` URL param does NOT reliably switch the active model, so the Unlimited toggle (only
present for Seedream 4.5) was missing and every prompt got skipped. `selectModel()` now opens the
model picker and clicks the option by its label; `verifyModelAndUnlimited()` aborts the whole run
if the model/Unlimited toggle can't be confirmed. The picker selectors (`SEL.modelPicker` /
`SEL.modelOption`) and the label (`MODEL_LABELS` / config `modelLabel`) were written defensively;
**confirmed live 2026-06-23** (log showed `model already "Seedream 4.5"`). If a future UI change
breaks the switch, fix those.

### Run it
- `setup.bat` (npm install; needs Node + Chrome installed).
- **Easiest: `open-ui.bat`** → control panel at `http://127.0.0.1:5179` (edit everything + Run).
- Or by hand: put prompts in `prompts.txt` (paste a `[MM:SS]` script as-is, or one per line;
  `#` comments ok); optionally drop character images in `characters/` and a base style image in
  `base_character/`; then `run-batch.bat` (or `npm run batch`). First run: log in when Chrome opens.
- Output: `output/<timestamp>.png` (e.g. `00_13.png`), or `NN_<slug>_<hhmmddMM>.png` for
  untimed prompts.

## Key files
- `src/browser.js` — `launchAndConnect(cfg)`: spawn Chrome (detached, survives node exit) +
  `connectOverCDP`. Polls `http://127.0.0.1:<port>/json/version`. If a debug Chrome is already
  up, it just attaches. Clear error if a stale Chrome holds the profile lock.
- `src/higgsfield.js` — page object. `SEL` holds all selectors (the repair point). Methods:
  `selectModel()` / `verifyModelAndUnlimited()`, `ensureUnlimitedOn()` (credit guard),
  `attachReferences()` / `clearReferences()` / `waitForUploadsComplete()`, `setPrompt()` (Lexical
  editor), `generate()`, `getFirstResult()` / `listResults()`, `waitForResult(prevSrc, {moderationBaseline})`,
  `moderationPhrases()` / `newModeration()` / `waitForModerationClear()`, `downloadNewest()`,
  `isCaptcha()`, `dismissCookies()`. `CaptchaError` + `ModerationError`. Human pacing via
  `_humanPause()` / `_click()`.
- `src/index.js` — batch loop + summary + fulfillment; base+character ref attach with upload-wait;
  NSFW retry-with-safety loop; stop-and-report on `CaptchaError`; timeout rescan/recovery.
- `src/config.js` — `loadConfig()` / `validateConfig()`, `loadPrompts()`, `loadStyle()`,
  `loadSafety()`, `loadCharacters()` (+`buildTerms`), `loadBaseCharacter()`; exports `DEFAULTS` +
  path constants for the server.
- `src/download.js` — `saveDownload()` / `downloadImage()` (fetch bytes via `page.request`);
  `sanitize()`, `uniquePath()`, `imageInfo()` (fulfillment + gallery dims).
- `src/server.js` + `ui/index.html` — the zero-dep web control panel (see 2026-06-23 features).

## Confirmed selectors / behaviour (learned live 2026-06-22)
- Prompt field: `#hf\:tour-image-prompt` — a Lexical `contenteditable` (NOT a textarea).
  Clear with Ctrl+A/Delete, then type.
- Unlimited toggle: a `[role="switch"]` button. Green + `aria-checked="true"` when ON. The
  Generate button reads **"Unlimited"** when ON, **"Generate ✨ 1"** (charges 1 credit) when OFF.
- ⚠️ A CAPTCHA or page reload **resets Unlimited to OFF** — always re-verify before Generate.
  `ensureUnlimitedOn()` is called both before typing and again right before generate.
- Generate = submit button.
- Result detection (re-confirmed live via CDP 2026-06-22, corrects an earlier mistake):
  **YOUR generations are in the feed `div#soul-feed-scroll`** (it contains only the logged-in
  user's images, newest first). ⚠️ The `<aside><figure><img>` cards are a DIFFERENT user's
  explore/inspiration sidebar — do NOT use them (an earlier version did and always timed out).
  - The feed is a **VIRTUALIZED list** (transform-positioned) so DOM order is meaningless.
    `getFirstResult()` instead picks the image whose URL has the **newest `hf_<YYYYMMDD_HHMMSS>`
    timestamp** (`stampOf()`). `SEL.resultFeed` = `['#soul-feed-scroll', 'main']`.
  - `waitForResult(prevSrc)` records the newest stamp before Generate, scrolls the feed to top
    each poll (`_scrollResultsTop()` — virtualized items leave the DOM), and returns the first
    result whose stamp is **later** than that. No blur/preview guard needed (the URL is the final
    asset). Logs the stamp as it changes; on timeout says to raise `timeoutMs` or fix
    `SEL.resultFeed`. Default `timeoutMs` is now **300000** (some generations exceed 3 min).
- Download = native full-res (confirmed live): the feed `<img>` is an `images.higgs.ai` proxy whose
  `url=` param points at a downscaled `*_min.webp` thumbnail. `originalFromProxy()` rewrites
  `hf_..._min.webp` → `hf_....png`, the **native original** (gave **2560×1440 PNG, 6.8 MB** for
  16:9 2K; adapts to other sizes). Fallbacks in `downloadNewest(outputDir, baseName, src)`:
  `proxyHighRes()` (proxy-regenerated PNG at `w=4096`, ~4096×2304 upscaled) → hover + per-card
  download button (`SEL.downloadButton`, unconfirmed) → the proxy src (lowest res). It takes the
  src `waitForResult` returned, so there's no hover/visibility race.
- Cookie banner: `#cookiescript_injected_wrapper` overlays and blocks clicks — `dismissCookies()`
  clicks accept or hides it.

## Anti-bot + credit safety
- Human pacing (`hover → wait ~0.7–1.8s → click`, typing delay 35ms) avoids the CAPTCHA most of
  the time; it CANNOT be eliminated. **Never auto-solve CAPTCHAs.** On detection the batch stops
  and reports remaining prompts (user choice).
- Credit guard: Generate only fires after Unlimited is confirmed ON; otherwise the prompt is
  skipped and noted.

## Status checklist
- ✅ Code complete, syntax-checked, and **run end-to-end successfully via the UI on 2026-06-23**
  (3/3 full-res images saved — see the Status banner at the top).
- ✅ Confirmed live: Google login persists in `chrome-profile/`; model switch to "Seedream 4.5";
  base + character references attach and upload before Generate; full-res `2560×1440` PNGs land in
  `output/`; fulfillment passes; UI tabs + endpoints all work.
- ⏳ Not yet exercised live (couldn't force without disrupting real data): the **NSFW
  retry-with-safety** path (benign test prompts didn't get rejected), **CAPTCHA stop**,
  **timeout rescan/recovery**, and the destructive UI actions (character delete, base-image
  replace, Stop a running batch) — their logic is in place and was unit/endpoint-checked.
- Remaining repair points if a future UI change breaks them: `SEL.downloadButton` (hover fallback,
  unconfirmed — the native-original path is what actually fires), the upload-readiness signal in
  `waitForUploadsComplete()`, and `MODERATION_RE` wording.

## Environment gotchas
- Project lives on local disk: **`C:\Users\pined\Workspace\Claude\higgsfield-automation`**.
- Node at `C:\Program Files\nodejs` may not be on the default PATH — scripts prepend it.
- `node_modules` / npm installs can FAIL on a Google Drive mount — keep the project on local disk.
- The batch reuses an already-running Chrome on `chromePort` (9222); if Chrome is open on the
  `chrome-profile/` dir but NOT on the debug port, close it first (browser.js explains this).

## Abandoned approaches (context)
1. Playwright launching bundled Chromium — Google blocked login.
2. Playwright launching real Chrome (`channel:'chrome'`, flags stripped) — login worked but
   user disliked the separate browser; result-capture unsolved.
3. Claude-in-Chrome extension — worked great (generated dragon, ballerina) but needs an agent
   driving it live; not unattended. Replaced by the CDP approach above.

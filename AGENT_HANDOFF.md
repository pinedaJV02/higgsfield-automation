# Higgsfield Automation — Agent Handoff Notes

_Last updated: 2026-06-22. Read this first if you are picking up this project._

## Goal
Unattended batch image generation on **higgsfield.ai** (account `pinedajv02@gmail.com`):
the user puts prompts in `prompts.txt`, runs one command, and gets the images in `output/`.
Hard requirements: **Unlimited toggle ON so NO credits are spent**, and **no Google login
block**.

## CURRENT APPROACH (active): Playwright batch attached to real Chrome via CDP
The Claude-in-Chrome extension and the earlier Playwright-launched-Chromium versions are both
**superseded**. The tool now:
1. Spawns a **normal** Chrome (`src/browser.js`): `chrome.exe --remote-debugging-port=9222
   --user-data-dir=<root>\chrome-profile ...` then `chromium.connectOverCDP(...)`.
   - Because Chrome is launched plainly (NOT via Playwright's automation launcher),
     `navigator.webdriver === false` and there's no automation banner → **Google accepts the
     login**. This is the fix for the login problem. First run: user logs in once in that
     window; the session persists in `chrome-profile/`.
2. Runs the batch (`src/index.js`): for each prompt → confirm Unlimited ON (credit guard) →
   type prompt → Generate → wait for result → download full-res → save.

### Run it
- `setup.bat` (npm install; needs Node + Chrome installed).
- Put prompts in `prompts.txt` (one per line; `#` comments ok).
- `run-batch.bat` (or `npm run batch`). First run: log in when Chrome opens.
- Output: `output/NN_<slug>_<hhmmddMM>.png`.

## Key files
- `src/browser.js` — `launchAndConnect(cfg)`: spawn Chrome (detached, survives node exit) +
  `connectOverCDP`. Polls `http://127.0.0.1:<port>/json/version`. If a debug Chrome is already
  up, it just attaches.
- `src/higgsfield.js` — page object. `SEL` holds all selectors (the repair point). Methods:
  `ensureUnlimitedOn()` (throws if can't confirm ON — credit guard), `setPrompt()` (Lexical
  editor), `generate()`, `getFirstResult()`, `waitForResult(prevSrc)`, `downloadNewest()`,
  `isCaptcha()`, `dismissCookies()`. Human pacing via `_humanPause()` / `_click()`.
- `src/index.js` — batch loop + summary; stop-and-report on `CaptchaError`.
- `src/config.js` — `loadConfig()` + `loadPrompts()` (reads `prompts.txt`).
- `src/download.js` — `saveDownload()` (from a Playwright download event) and `downloadImage()`
  (fetch bytes via `page.request`); `sanitize()`, `uniquePath()`.

## Confirmed selectors / behaviour (learned live 2026-06-22)
- Prompt field: `#hf\:tour-image-prompt` — a Lexical `contenteditable` (NOT a textarea).
  Clear with Ctrl+A/Delete, then type.
- Unlimited toggle: a `[role="switch"]` button. Green + `aria-checked="true"` when ON. The
  Generate button reads **"Unlimited"** when ON, **"Generate ✨ 1"** (charges 1 credit) when OFF.
- ⚠️ A CAPTCHA or page reload **resets Unlimited to OFF** — always re-verify before Generate.
  `ensureUnlimitedOn()` is called both before typing and again right before generate.
- Generate = submit button.
- Result: newest = **first large image** in the History grid (`getFirstResult()` returns the
  first loaded `<img>` with naturalWidth > 200). `waitForResult` polls until it differs from the
  pre-generate src.
- Download: hover the newest card → a download (↓) icon appears at the card's top-right (tooltip
  "Download"). Full-res is **2560×1440** for 16:9 2K. `downloadNewest()` clicks it capturing
  `page.waitForEvent('download')`; **fallback** = fetch the image src bytes (lower res).
  ⚠️ The exact download-button selector (`SEL.downloadButton`) was inferred from the hover icons
  and may need confirming on the first real run — it's hover-only so `find`/a11y may miss it.
- Cookie banner: `#cookiescript_injected_wrapper` overlays and blocks clicks — `dismissCookies()`
  clicks accept or hides it.

## Anti-bot + credit safety
- Human pacing (`hover → wait ~0.7–1.8s → click`, typing delay 35ms) avoids the CAPTCHA most of
  the time; it CANNOT be eliminated. **Never auto-solve CAPTCHAs.** On detection the batch stops
  and reports remaining prompts (user choice).
- Credit guard: Generate only fires after Unlimited is confirmed ON; otherwise the prompt is
  skipped and noted.

## Status
- ✅ Code complete and syntax-checked. Chrome auto-detected at
  `C:\Program Files\Google\Chrome\Application\chrome.exe`. `prompts.txt` seeded with 3 prompts.
- ⏳ **Not yet run end-to-end in this new form.** Next: run `run-batch.bat`, log in once, and
  confirm (a) Google login works, (b) Unlimited stays ON / no credit charged, (c) full-res files
  land in `output/`, (d) the download-button selector is correct (fix `SEL.downloadButton` if the
  fallback path triggers).
- Earlier trial (via the extension) saved `output\14192206.png` (dragon, 2560×1440).

## Environment gotchas
- Node at `C:\Program Files\nodejs` is NOT on the default PATH — scripts prepend it.
- `node_modules` / npm installs FAIL on the Google Drive mount (`G:\My Drive`); project lives on
  local disk `C:\Users\jvpin\Claude_Projects\`.
- Leftover dirs from older approaches: `profile/` (old Playwright persistent profile, unused).

## Abandoned approaches (context)
1. Playwright launching bundled Chromium — Google blocked login.
2. Playwright launching real Chrome (`channel:'chrome'`, flags stripped) — login worked but
   user disliked the separate browser; result-capture unsolved.
3. Claude-in-Chrome extension — worked great (generated dragon, ballerina) but needs an agent
   driving it live; not unattended. Replaced by the CDP approach above.

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
Edit **`prompts.txt`** — one prompt per line. Blank lines and lines starting with `#` are
ignored.

```
a ballerina holding a sword
john wick eating spaghetti
a dog searching through a rubble building
```

## 3. Run
Double-click **`run-batch.bat`**.

- A Chrome window opens. **On the first run, log in to Higgsfield** (use your Google account —
  this is real Chrome, so Google allows it). The login is saved in `chrome-profile/` and reused,
  so later runs are unattended.
- For each prompt the tool: confirms **Unlimited is ON**, types the prompt, clicks **Generate**,
  waits for the image, and downloads it full-resolution into **`output/`**.
- Files are named `NN_<prompt-slug>_<hhmmddMM>.png` (index, short prompt, hour-minute-day-month).

When it finishes it prints a summary of what was saved.

## How it protects your credits
The tool **only clicks Generate when it has confirmed the Unlimited toggle is ON**. If it can't
confirm Unlimited (e.g. the control moved), it **skips that prompt** rather than spend a paid
credit, and notes it in the summary.

## Bot detection / CAPTCHAs
Higgsfield occasionally shows a "Verification Required" slider. The tool uses human-like pacing
(hover, pauses, realistic typing) to avoid triggering it, **but it cannot solve one**. If a
CAPTCHA appears, the batch **stops and reports** which prompts remain — solve the slider in the
Chrome window, then re-run to continue with the rest.

## Settings (`config.json`)
| Field | Meaning | Default |
|-------|---------|---------|
| `model` | Model id (URL `?model=`) | `seedream_v4_5` |
| `ratio` | Aspect ratio | `16:9` |
| `quality` | Quality label | `2K` |
| `unlimited` | Must stay `true` (credit-free) | `true` |
| `outputDir` | Where images are saved | `./output` |
| `timeoutMs` | Max wait per image (ms) | `180000` |
| `stepDelayMs` | Base pause between prompts (ms) | `4000` |
| `chromePort` | Chrome remote-debugging port | `9222` |
| `chromePath` | Chrome exe (auto-detected if empty) | `""` |

## How it works (for maintainers)
- `src/browser.js` — launches a **normal** Chrome with `--remote-debugging-port` and a
  dedicated `chrome-profile/`, then `chromium.connectOverCDP(...)`. Because Chrome is launched
  plainly (no automation switches), `navigator.webdriver` is `false` and Google accepts login.
- `src/higgsfield.js` — all selectors (`SEL`) + actions: `ensureUnlimitedOn` (credit guard),
  `setPrompt` (Lexical editor), `generate`, `waitForResult`, `downloadNewest`, `isCaptcha`.
- `src/index.js` — the batch loop with human pacing and stop-and-report on CAPTCHA.
- `src/config.js` / `src/download.js` — config + prompts loading, and saving downloads.

> **Requires Chrome installed** on the machine. Windows-focused (paths/scripts).
> See `AGENT_HANDOFF.md` for the full history and gotchas.

'use strict';

const { saveDownload, downloadImage } = require('./download');

/**
 * Page object for higgsfield.ai image generation.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  SELECTORS — THIS IS THE REPAIR POINT                                      │
 * │  All locators live in SEL below. They were confirmed live on 2026-06-22.  │
 * │  If a step breaks, update the matching SEL entry — not the logic.          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const BASE_URL = 'https://higgsfield.ai';
const IMAGE_PATH = '/ai/image';

/**
 * Map a config model id to the label Higgsfield shows in its model picker.
 * Override per-model via config `modelLabel` if the UI text differs.
 */
const MODEL_LABELS = {
  seedream_v4_5: 'Seedream 4.5',
  seedream_v4: 'Seedream 4.0',
  soul: 'Soul',
};

/** Best-effort human label for a model id (used to drive + verify the picker). */
function modelLabelFor(model, override) {
  if (override) return override;
  if (MODEL_LABELS[model]) return MODEL_LABELS[model];
  // Fallback: "seedream_v4_5" -> "Seedream V4 5"
  return model
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const SEL = {
  // Prompt box: a Lexical contenteditable (confirmed id #hf:tour-image-prompt).
  promptBox: [
    '#hf\\:tour-image-prompt',
    'div[contenteditable="true"][data-lexical-editor="true"]',
    'textarea[placeholder*="Describe the scene" i]',
    '[contenteditable="true"]',
    'textarea',
  ],
  // Aspect-ratio button (shows e.g. "16:9").
  ratioButton: ['button:has-text(":")'],
  // Quality button (e.g. "2K").
  qualityButton: ['button:has-text("2K")', 'button:has-text("4K")', 'button:has-text("1K")'],
  // ── Model picker (THE new repair point) ──────────────────────────────────
  // The control that shows / opens the current model. Defensive fallbacks; the
  // exact one may need confirming live. modelLabelFor() supplies the text.
  modelPicker: [
    'button[aria-haspopup="listbox"]',
    'button[aria-haspopup="menu"]',
    '[data-testid*="model" i] button',
    '[data-testid*="model" i]',
    'button:has-text("Seedream")',
    'button:has-text("Soul")',
    'button:has-text("Model")',
  ],
  // An option/card inside the open model picker. Matched by visible text in
  // selectModel(); these are extra structural fallbacks.
  modelOption: ['[role="option"]', '[role="menuitem"]', '[data-testid*="model-option" i]'],
  // The "Unlimited" toggle — confirmed a role="switch" button.
  unlimitedSwitch: ['[role="switch"]'],
  // The primary submit/Generate button (reads "Unlimited" when Unlimited is ON,
  // "Generate ✨ 1" when OFF — used as the credit indicator). NOTE: when ON the
  // button text is "Unlimited" — the SAME word as the toggle — so we must never
  // match the [role="switch"] toggle here. generate() guards against that.
  generateButton: [
    'button[type="submit"]',
    'button:has-text("Generate")',
    'button:not([role="switch"]):has-text("Unlimited")',
  ],
  // ── Reference-image upload (THE repair point for character refs) ──────────
  // The "+"/upload control on the prompt that opens a file chooser. Defensive
  // fallbacks; confirm live and repair if needed.
  uploadButton: [
    'button[aria-label*="upload" i]',
    'button[aria-label*="image" i]',
    'button[aria-label*="reference" i]',
    'button[aria-label*="attach" i]',
    'label:has(input[type="file"])',
    'button:has-text("Upload")',
  ],
  // The hidden file input we drive with setInputFiles (bypasses the OS dialog).
  // Confirmed live: sr-only, single-file each; attaching reveals a new empty
  // input, so attachReferences() always uses the LAST (empty) one.
  uploadInput: ['input[type="file"]'],
  // An attached reference = a `div.touch-none.relative` wrapper holding the thumb
  // img + controls (confirmed live 2026-06-22). Clicking a button inside removes
  // it. These are the repair point.
  referenceThumb: ['div.touch-none.relative', '[class*="reference" i] img'],
  referenceRemove: [
    'div.touch-none.relative button',
    'button[aria-label*="remove" i]',
    'button[aria-label*="delete" i]',
  ],
  // Per-image download control (revealed on hover over a result card).
  downloadButton: [
    'button[aria-label*="download" i]',
    '[title="Download" i]',
    'a[download]',
    'button:has-text("Download")',
  ],
  // YOUR generations appear in the feed `#soul-feed-scroll` (confirmed live: it
  // contains only the logged-in user's images, newest by hf_ timestamp). NOTE
  // the `aside figure img` cards are a DIFFERENT user's explore/inspiration
  // sidebar — do NOT use them. The feed is a VIRTUALIZED list (transform-
  // positioned), so DOM order is meaningless — getFirstResult() picks the image
  // with the newest hf_<timestamp> in its URL, not the first in the DOM.
  resultFeed: ['#soul-feed-scroll', 'main'],
  // Images within the result feed (also used for the hover download fallback).
  resultImages: ['#soul-feed-scroll img', 'main img'],
  cookieAccept: [
    '#cookiescript_accept',
    '#cookiescript_reject',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'button:has-text("Got it")',
  ],
};

/** Try a list of selectors and return the first locator that becomes visible. */
async function firstVisible(page, selectors, { timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.count()) {
          await loc.waitFor({ state: 'visible', timeout: 1000 });
          return loc;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `None of these selectors became visible: ${JSON.stringify(selectors)}` +
      (lastErr ? ` (last error: ${lastErr.message})` : '')
  );
}

/** Error thrown when Higgsfield shows its bot-detection challenge. */
class CaptchaError extends Error {
  constructor() {
    super('Higgsfield bot-detection (CAPTCHA) appeared.');
    this.name = 'CaptchaError';
  }
}

/** Error thrown when a generation is rejected for NSFW/content-policy reasons. */
class ModerationError extends Error {
  constructor(matched) {
    super(`Generation rejected (NSFW/content policy)${matched ? `: "${matched}"` : ''}.`);
    this.name = 'ModerationError';
  }
}

// Phrases Higgsfield shows when a generation is blocked/refunded by its content
// classifier. THE REPAIR POINT for moderation detection — confirm the exact toast
// text live and adjust. Kept specific to avoid matching ordinary UI copy.
const MODERATION_RE =
  /\bnsfw\b|content policy|content_policy|policy violation|violat(?:es|ion|ing)|inappropriate content|not allowed|prohibited content|flagged as|has been flagged|sensitive content|couldn't generate|could not generate|failed to generate|generation failed|try a different prompt/i;

class Higgsfield {
  constructor(page, { timeoutMs = 180000, model = '', modelLabel = '', unlimited = true } = {}) {
    this.page = page;
    this.timeoutMs = timeoutMs;
    this.model = model;
    this.modelLabel = modelLabelFor(model, modelLabel);
    this.unlimited = unlimited;
  }

  /** Random human-like pause (ms). */
  _humanPause(min = 700, max = 1800) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return this.page.waitForTimeout(ms);
  }

  /** Human-like click: scroll into view, hover, pause, then click. */
  async _click(locator) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.hover().catch(() => {});
    await this._humanPause();
    await locator.click();
  }

  /** True when the generation UI (prompt box) is present — i.e. logged in. */
  async isReady() {
    try {
      await firstVisible(this.page, SEL.promptBox, { timeout: 4000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Detect the "Verification Required" bot-check page. */
  async isCaptcha() {
    const txt = (await this.page.locator('body').innerText().catch(() => '')) || '';
    return /verification required|slide right to secure|unusual activity/i.test(txt);
  }

  /**
   * All DISTINCT moderation/rejection phrases currently visible in the page body
   * (lowercased). Used as a baseline+diff so that persistent UI copy (e.g. an
   * "NSFW" content-filter label or a "Content Policy" footer link) never counts
   * as a rejection — only text that appears AFTER generation does. Repair point:
   * MODERATION_RE.
   */
  async moderationPhrases() {
    const txt = (await this.page.locator('body').innerText().catch(() => '')) || '';
    const re = new RegExp(MODERATION_RE.source, 'gi');
    const out = new Set();
    let m;
    while ((m = re.exec(txt))) out.add(m[0].toLowerCase());
    return [...out];
  }

  /**
   * The first moderation phrase present NOW that was NOT in `baseline` — i.e. text
   * that surfaced since generation started (a real rejection). Returns null if the
   * page shows nothing beyond the baseline noise.
   */
  async newModeration(baseline = []) {
    const now = await this.moderationPhrases();
    return now.find((p) => !baseline.includes(p)) || null;
  }

  /**
   * Wait until no rejection text beyond `baseline` remains (or timeout), so a
   * retry's result-wait doesn't instantly re-trip on the stale message. Best-effort.
   */
  async waitForModerationClear(baseline = [], timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.newModeration(baseline))) return;
      await this.page.waitForTimeout(500);
    }
  }

  /** Dismiss the cookie banner (it overlays the page and blocks clicks). */
  async dismissCookies() {
    for (const sel of SEL.cookieAccept) {
      const loc = this.page.locator(sel).first();
      try {
        if (await loc.count()) {
          await loc.click({ timeout: 1500 });
          await this.page.waitForTimeout(300);
          break;
        }
      } catch {
        /* next */
      }
    }
    // Forcibly neutralize the CookieScript overlay so it can't intercept clicks.
    try {
      await this.page.evaluate(() => {
        document
          .querySelectorAll('#cookiescript_injected_wrapper, #cookiescript_injected, [id^="cookiescript"], [data-cs-id]')
          .forEach((el) => el.remove());
        if (!document.getElementById('__cs_kill')) {
          const s = document.createElement('style');
          s.id = '__cs_kill';
          s.textContent =
            '#cookiescript_injected_wrapper,#cookiescript_injected,[id^="cookiescript"]{display:none!important;pointer-events:none!important;visibility:hidden!important;}';
          document.head.appendChild(s);
        }
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * Navigate to the image generator. The `?model=` param is only a *hint* — it
   * does NOT reliably switch the active model — so selectModel() does the real
   * work afterwards.
   */
  async openImageGenerator(model) {
    const url = `${BASE_URL}${IMAGE_PATH}?model=${encodeURIComponent(model)}`;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    if (await this.isCaptcha()) throw new CaptchaError();
    await firstVisible(this.page, SEL.promptBox, { timeout: 30000 });
    await this.dismissCookies();
  }

  /** True if the target model's label is currently visible on the page. */
  async _modelLabelVisible() {
    return this.page
      .getByText(this.modelLabel, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
  }

  /**
   * Explicitly switch the active model to `this.modelLabel` via the UI picker.
   * No-op if it's already the active model. Throws if the picker can't be found
   * or the option can't be chosen — the caller treats that as a fatal, fail-fast
   * condition (because the wrong model means no Unlimited toggle = credit risk).
   */
  async selectModel() {
    await this.dismissCookies();

    // Already on the right model? (label shown and Unlimited toggle present)
    if ((await this._modelLabelVisible()) && (await this._unlimitedPresent())) {
      console.log(`  • model already "${this.modelLabel}"`);
      return;
    }

    const picker = await firstVisible(this.page, SEL.modelPicker, { timeout: 10000 }).catch(
      () => null
    );
    if (!picker) {
      throw new Error(
        `Could not find the model picker to switch to "${this.modelLabel}". ` +
          `Fix SEL.modelPicker in src/higgsfield.js.`
      );
    }
    await this._click(picker);
    await this._humanPause(600, 1200);

    // Choose the option by visible text, with structural fallbacks.
    const byText = this.page
      .getByRole('option', { name: this.modelLabel, exact: false })
      .or(this.page.getByRole('menuitem', { name: this.modelLabel, exact: false }))
      .or(this.page.getByText(this.modelLabel, { exact: false }))
      .first();
    try {
      await byText.waitFor({ state: 'visible', timeout: 8000 });
      await this._click(byText);
    } catch (err) {
      throw new Error(
        `Model "${this.modelLabel}" not selectable from the picker (${err.message}). ` +
          `Set "modelLabel" in config.json to the exact UI text, or fix SEL.modelOption.`
      );
    }
    await this._humanPause(900, 1600);
    console.log(`  • switched model to "${this.modelLabel}"`);
  }

  /** True if the Unlimited [role="switch"] toggle exists on the page right now. */
  async _unlimitedPresent() {
    const loc = this.page.locator(SEL.unlimitedSwitch.join(', ')).first();
    return (await loc.count()) > 0;
  }

  /**
   * Confirm the page is in the correct state to generate: the target model is
   * active, and — only when `this.unlimited` — the Unlimited toggle is present
   * (the credit guard). Throws (fail-fast) otherwise.
   */
  async verifyModelAndUnlimited() {
    const labelOk = await this._modelLabelVisible();
    if (this.unlimited) {
      const unlimitedOk = await this._unlimitedPresent();
      if (!unlimitedOk) {
        throw new Error(
          `Unlimited toggle not found for model "${this.modelLabel}". The model likely did ` +
            `not switch (this model may not support Unlimited). Nothing was generated.`
        );
      }
    }
    if (!labelOk) {
      // We couldn't confirm the label on screen — warn, don't abort.
      console.log(`  • (warning: could not confirm model label "${this.modelLabel}" on screen)`);
    }
    if (this.unlimited) {
      console.log(`  • model + Unlimited verified (model="${this.modelLabel}")`);
    } else {
      console.log(`  ⚠ model verified, Unlimited OFF — generations will SPEND CREDITS`);
    }
  }

  /**
   * Ensure the Unlimited toggle is ON. CREDIT GUARD: throws if it cannot be
   * confirmed ON, so the caller never spends a paid credit.
   */
  async ensureUnlimitedOn() {
    const sw = await firstVisible(this.page, SEL.unlimitedSwitch, { timeout: 8000 });
    let on = (await sw.getAttribute('aria-checked').catch(() => null)) === 'true';
    if (!on) {
      await this._click(sw);
      await this._humanPause(800, 1500);
      on = (await sw.getAttribute('aria-checked').catch(() => null)) === 'true';
    }
    if (!on) {
      throw new Error('Could not confirm Unlimited is ON — refusing to spend a credit.');
    }
    console.log('  • Unlimited confirmed ON');
  }

  /**
   * Attach reference images to the prompt via the upload control. Uses the hidden
   * file input + setInputFiles so no OS dialog appears. No-op on an empty list.
   * Selectors are a repair point — confirm live if uploads don't appear.
   */
  async attachReferences(paths) {
    if (!paths || paths.length === 0) return;
    await this.dismissCookies();

    const thumbSel = SEL.referenceThumb[0];
    let attached = 0;
    for (const p of paths) {
      let inputs = this.page.locator(SEL.uploadInput.join(', '));
      if ((await inputs.count()) === 0) {
        // No input in the DOM yet — click the upload control to reveal one.
        const btn = await firstVisible(this.page, SEL.uploadButton, { timeout: 4000 }).catch(
          () => null
        );
        if (btn) await this._click(btn).catch(() => {});
        inputs = this.page.locator(SEL.uploadInput.join(', '));
      }
      if ((await inputs.count()) === 0) {
        console.log(`  ⚠ no file input found — fix SEL.uploadInput/uploadButton`);
        break;
      }
      try {
        // Each attached file consumes one input and reveals a fresh empty one, so
        // always use the LAST input. The thumbnail renders asynchronously — wait
        // for the count to grow rather than a fixed pause.
        const before = await this.page.locator(thumbSel).count();
        await inputs.nth((await inputs.count()) - 1).setInputFiles(p);
        const ok = await this._waitForCount(thumbSel, before + 1, 10000);
        if (ok) attached += 1;
        else console.log(`  ⚠ reference thumbnail didn't appear for ${p}`);
      } catch (err) {
        console.log(`  ⚠ failed to attach ${p} (${err.message})`);
      }
    }
    if (attached) console.log(`  • attached ${attached} reference image(s)`);
  }

  /** Wait until at least `n` elements match `selector`, or timeout. */
  async _waitForCount(selector, n, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.page.locator(selector).count()) >= n) return true;
      await this.page.waitForTimeout(300);
    }
    return false;
  }

  /**
   * Wait until all attached reference thumbnails have finished uploading to the
   * server (not just been selected), so a generation never fires against a
   * half-uploaded reference. Readiness = the expected number of thumbs, each with
   * a fully-loaded <img> backed by a remote http(s) URL (not a blob:/data: local
   * preview) and no upload spinner. Must hold for 2 consecutive polls to count.
   *
   * Returns true once confirmed, false on timeout (caller decides what to do).
   * Repair point: the readiness signal — confirm live which one Higgsfield uses
   * (blob→server-URL swap vs. spinner removal) and tighten if needed.
   */
  async waitForUploadsComplete(expectedCount, timeoutMs = 60000) {
    if (!expectedCount) return true;
    const thumbSel = SEL.referenceThumb[0];
    const deadline = Date.now() + timeoutMs;
    let stable = 0;
    while (Date.now() < deadline) {
      const ready = await this.page
        .$$eval(
          thumbSel,
          (thumbs, expected) => {
            if (thumbs.length < expected) return false;
            for (const t of thumbs) {
              if (t.querySelector('.animate-spin, [role="progressbar"]')) return false;
              const img = t.querySelector('img');
              if (!img) return false;
              if (!img.complete || img.naturalWidth === 0) return false;
              const src = img.currentSrc || img.src || '';
              if (!/^https?:/i.test(src)) return false; // blob:/data: = not yet uploaded
            }
            return true;
          },
          expectedCount
        )
        .catch(() => false);
      stable = ready ? stable + 1 : 0;
      if (stable >= 2) return true;
      await this.page.waitForTimeout(500);
    }
    return false;
  }

  /**
   * Remove any reference images currently attached to the prompt, so each prompt
   * starts from a clean slate. Clicks the remove control on each thumbnail until
   * none remain (with a short settle so late-rendered thumbs are also caught).
   */
  async clearReferences() {
    const thumbSel = SEL.referenceThumb[0];
    const removeSel = SEL.referenceRemove.join(', ');
    for (let i = 0; i < 12; i++) {
      if ((await this.page.locator(thumbSel).count()) === 0) {
        // brief recheck in case a thumb is still rendering
        await this.page.waitForTimeout(400);
        if ((await this.page.locator(thumbSel).count()) === 0) return;
      }
      const btn = this.page.locator(removeSel).first();
      if (!(await btn.count())) break;
      try {
        await btn.click({ timeout: 1500 });
        await this.page.waitForTimeout(400);
      } catch {
        break;
      }
    }
  }

  /** Type the prompt into the Lexical editor (clears any existing text first). */
  async setPrompt(text) {
    await this.dismissCookies();
    const box = await firstVisible(this.page, SEL.promptBox);
    await box.click();
    await this._humanPause(300, 700);
    await box.press('Control+A').catch(() => {});
    await box.press('Delete').catch(() => {});
    // pressSequentially is the current Playwright API (locator.type is deprecated).
    // The default action timeout is 30s; long prompts (scene + style + base
    // instruction) can exceed that at a realistic per-char delay once the Lexical
    // editor's per-keystroke processing overhead is added — which silently aborts
    // the type mid-prompt. Scale the timeout with the text length so it never
    // times out spuriously, and keep a brisk-but-human typing speed.
    const perChar = 15; // ms between keystrokes (fast human typist)
    await box.pressSequentially(text, {
      delay: perChar,
      timeout: Math.max(60000, text.length * (perChar + 45) + 20000),
    });
    console.log(`  • prompt: "${text}"`);
  }

  /** Open a control-bar dropdown and pick an option by exact text. */
  async chooseFromMenu(buttonSelectors, value, label) {
    const btn = await firstVisible(this.page, buttonSelectors);
    const current = (await btn.innerText().catch(() => '')) || '';
    const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
    if (norm(current).includes(norm(value))) return; // already set
    await this._click(btn);
    const option = this.page
      .getByRole('option', { name: value, exact: true })
      .or(this.page.getByRole('menuitem', { name: value, exact: true }))
      .or(this.page.getByText(value, { exact: true }))
      .first();
    await option.waitFor({ state: 'visible', timeout: 8000 });
    await this._click(option);
    console.log(`  • set ${label} to "${value}"`);
  }

  async setRatio(ratio) {
    try {
      await this.chooseFromMenu(SEL.ratioButton, ratio, 'ratio');
    } catch (err) {
      console.log(`  ⚠ ratio NOT set to "${ratio}" (left as-is): ${err.message}`);
    }
  }

  async setQuality(quality) {
    if (!quality) return;
    try {
      await this.chooseFromMenu(SEL.qualityButton, quality, 'quality');
    } catch (err) {
      console.log(`  ⚠ quality NOT set to "${quality}" (left as-is): ${err.message}`);
    }
  }

  /**
   * The newest result's src, chosen by the hf_<timestamp> embedded in the image
   * URL (NOT DOM order — the feed is a virtualized, transform-positioned list).
   * Scans the first result-feed selector that contains any timestamped image.
   */
  async getFirstResult() {
    for (const feed of SEL.resultFeed) {
      const srcs = await this.page
        .$$eval(`${feed} img`, (imgs) => imgs.map((im) => im.currentSrc || im.src || ''))
        .catch(() => []);
      let best = null;
      let bestStamp = '';
      for (const s of srcs) {
        const st = stampOf(s);
        if (st && st > bestStamp) {
          bestStamp = st;
          best = s;
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * All result images currently in the feed, as `[{ src, stamp }]` sorted by
   * stamp ascending (oldest → newest). Used by the post-batch rescan to recover
   * generations that finished after their prompt timed out.
   */
  async listResults() {
    for (const feed of SEL.resultFeed) {
      const srcs = await this.page
        .$$eval(`${feed} img`, (imgs) => imgs.map((im) => im.currentSrc || im.src || ''))
        .catch(() => []);
      const rows = [];
      const seen = new Set();
      for (const s of srcs) {
        const st = stampOf(s);
        if (st && !seen.has(st)) {
          seen.add(st);
          rows.push({ src: s, stamp: st });
        }
      }
      if (rows.length) return rows.sort((a, b) => a.stamp.localeCompare(b.stamp));
    }
    return [];
  }

  /** Scroll the result feed to the top so the newest item is rendered (it's a
   * virtualized list — items scrolled out of view leave the DOM). Best-effort. */
  async _scrollResultsTop() {
    for (const feed of SEL.resultFeed) {
      const done = await this.page
        .evaluate((sel) => {
          const root = document.querySelector(sel);
          if (!root) return false;
          root.scrollTop = 0;
          // also reset the nearest scrollable ancestor/descendant
          root.querySelectorAll('*').forEach((el) => {
            if (el.scrollHeight > el.clientHeight) el.scrollTop = 0;
          });
          return true;
        }, feed)
        .catch(() => false);
      if (done) return;
    }
  }

  /** Click Generate (must be called only after ensureUnlimitedOn). */
  async generate() {
    const btn = await firstVisible(this.page, SEL.generateButton, { timeout: 8000 });
    // CREDIT GUARD: never click the Unlimited toggle by mistake (it also reads
    // "Unlimited"). Clicking it would turn Unlimited OFF and risk a paid render.
    const role = (await btn.getAttribute('role').catch(() => null)) || '';
    if (role === 'switch') {
      throw new Error(
        'Refusing to click: the matched "Generate" target is the Unlimited toggle ' +
          '(role="switch"). Fix SEL.generateButton.'
      );
    }
    await this._click(btn);
    console.log('  • clicked Generate');
  }

  /**
   * Wait until a NEW result image (different from `prevSrc`) appears AND stays
   * stable, so we don't grab a transient loading/blur preview. A candidate src
   * must be the newest result for 2 consecutive polls before we accept it.
   * Returns its src. Throws CaptchaError if the bot-check appears while waiting.
   */
  async waitForResult(prevSrc, { moderationBaseline = [] } = {}) {
    const prevStamp = stampOf(prevSrc) || '';
    const deadline = Date.now() + this.timeoutMs;
    let lastLog = null;
    while (Date.now() < deadline) {
      if (await this.isCaptcha()) throw new CaptchaError();
      // A rejection = moderation text that's NEW vs the pre-generation baseline.
      // Re-confirm after a brief pause so a transient flash doesn't false-trip.
      const novel = await this.newModeration(moderationBaseline);
      if (novel) {
        await this.page.waitForTimeout(800);
        if (await this.newModeration(moderationBaseline)) throw new ModerationError(novel);
      }
      await this._scrollResultsTop();
      const src = await this.getFirstResult();
      const st = stampOf(src) || '';
      if (st !== lastLog) {
        console.log(`  • waiting… newest result stamp=${st || 'none'}`);
        lastLog = st;
      }
      // A NEW result is any image whose hf_ timestamp is later than the newest
      // one present before we clicked Generate. The URL is the final asset, so
      // there's no preview/blur to guard against.
      if (src && st > prevStamp) {
        console.log(`  • generation complete (stamp ${st})`);
        return src;
      }
      await this.page.waitForTimeout(1500);
    }
    throw new Error(
      `Timed out (${this.timeoutMs}ms) waiting for a new result. Newest stamp seen was ` +
        `"${lastLog || 'none'}" (needed one later than "${prevStamp || 'none'}"). ` +
        `If generation is just slow, raise "timeoutMs" in config.json; otherwise check ` +
        `SEL.resultFeed in src/higgsfield.js.`
    );
  }

  /**
   * Download the newest result at full resolution and save it.
   *
   * Primary: the on-page image is an `images.higgs.ai` proxy that downscales to
   * ~640px webp — but it carries the ORIGINAL full-res asset URL in its `url=`
   * query param. We decode that and fetch the original (e.g. 1536×2048 PNG).
   * Fallbacks: hover + click the per-card download control, then the proxy src.
   *
   * @param {string} [src] The result src detected by waitForResult (preferred,
   *   avoids any hover/visibility race). Falls back to getFirstResult().
   * @returns {Promise<string>} saved file path
   */
  async downloadNewest(outputDir, baseName, src) {
    src = src || (await this.getFirstResult());
    if (!src) throw new Error('No result image available to download.');

    // Primary: the NATIVE original asset (e.g. 2560×1440 PNG) derived from the
    // proxy URL. Fallback to a proxy-regenerated large PNG if the native 403s.
    for (const [label, url] of [
      ['native original', originalFromProxy(src)],
      ['proxy hi-res PNG', proxyHighRes(src)],
    ]) {
      if (!url) continue;
      try {
        const p = await downloadImage(this.page, url, { outputDir, baseName });
        console.log(`  • saved ${label} → ${dimsOf(p)}`);
        return p;
      } catch (err) {
        console.log(`  • ${label} fetch failed (${err.message}); trying next`);
      }
    }

    // Fallback A: hover the newest card and click its download control.
    const firstImg = this.page.locator(SEL.resultImages.join(', ')).first();
    await firstImg.hover().catch(() => {});
    await this._humanPause(800, 1500);
    const dlBtn = this.page.locator(SEL.downloadButton.join(', ')).first();
    try {
      const [download] = await Promise.all([
        this.page.waitForEvent('download', { timeout: 15000 }),
        dlBtn.click({ timeout: 5000 }),
      ]);
      const p = await saveDownload(download, { outputDir, baseName });
      console.log(`  • saved via download button → ${dimsOf(p)}`);
      return p;
    } catch (err) {
      // Fallback B: the on-screen proxy src (likely lower-res).
      console.log(
        `  • download button path failed (${err.message}); ` +
          `falling back to the on-screen image (may be lower-res)`
      );
      const p = await downloadImage(this.page, src, { outputDir, baseName });
      console.log(`  • saved via proxy src fallback → ${dimsOf(p)}`);
      return p;
    }
  }
}

/**
 * The images on the page are served through an `images.higgs.ai` resizing proxy
 * that downscales the result. The full-resolution original is in the `url=`
 * query param — decode it so we can fetch the real image.
 * @returns {string|null} the original asset URL, or null if `src` isn't a proxy.
 */
/**
 * Extract the generation timestamp (hf_YYYYMMDD_HHMMSS) from an image URL. This
 * lexicographically-sortable string identifies which result is newest, which is
 * essential because the result feed is a virtualized list with no stable DOM
 * order. Returns null if the URL has no such stamp.
 */
function stampOf(src) {
  const m = (src || '').match(/hf_(\d{8}_\d{6})/);
  return m ? m[1] : null;
}

function originalFromProxy(src) {
  try {
    const u = new URL(src);
    const inner = u.searchParams.get('url');
    if (inner && /^https?:\/\//i.test(inner)) {
      // The feed embeds a downscaled "*_min.webp" thumbnail. The native original
      // lives at the same path as .png (confirmed live: hf_..._min.webp ->
      // hf_....png == 2560×1440 for 16:9 2K). If there's no _min suffix the inner
      // URL already IS the original (e.g. the explore sidebar), so use it as-is.
      const m = inner.match(/^(.*)_min\.\w+(\?.*)?$/);
      return m ? `${m[1]}.png${m[2] || ''}` : inner;
    }
  } catch {
    /* not a parseable URL */
  }
  return null;
}

/**
 * Build a proxy URL that regenerates a large PNG from the result (fallback when
 * the native original 403s). Returns null if `src` isn't an images.higgs.ai proxy.
 */
function proxyHighRes(src) {
  try {
    const u = new URL(src);
    const inner = u.searchParams.get('url');
    if (!inner) return null;
    return `${u.origin}${u.pathname}?url=${encodeURIComponent(inner)}&output=png&w=4096`;
  } catch {
    return null;
  }
}

/** Read the pixel dimensions of a saved PNG/JPEG for the log line (best-effort). */
function dimsOf(filePath) {
  try {
    const fs = require('fs');
    const buf = fs.readFileSync(filePath);
    // PNG: width/height are big-endian uint32 at byte offsets 16 and 20.
    if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
    }
    // JPEG: scan for a SOF0/2 marker to read height/width.
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2;
      while (o < buf.length) {
        if (buf[o] !== 0xff) break;
        const marker = buf[o + 1];
        const len = buf.readUInt16BE(o + 2);
        if (marker >= 0xc0 && marker <= 0xc3) {
          return `${buf.readUInt16BE(o + 7)}x${buf.readUInt16BE(o + 5)}`;
        }
        o += 2 + len;
      }
    }
    return `${buf.length} bytes`;
  } catch {
    return '?';
  }
}

module.exports = {
  Higgsfield,
  SEL,
  BASE_URL,
  IMAGE_PATH,
  firstVisible,
  CaptchaError,
  ModerationError,
  stampOf,
};

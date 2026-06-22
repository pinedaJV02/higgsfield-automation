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
  // The "Unlimited" toggle — confirmed a role="switch" button.
  unlimitedSwitch: ['[role="switch"]'],
  // The primary submit/Generate button (reads "Unlimited" when Unlimited is ON,
  // "Generate ✨ 1" when OFF — used as the credit indicator).
  generateButton: [
    'button[type="submit"]',
    'button:has-text("Generate")',
    'button:has-text("Unlimited")',
  ],
  // Per-image download control (revealed on hover over a result card).
  downloadButton: [
    'button[aria-label*="download" i]',
    '[title="Download" i]',
    'a[download]',
    'button:has-text("Download")',
  ],
  // Result images in the History grid (newest = first in DOM = top-left).
  resultImages: ['main img', 'img[src^="http"]'],
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

class Higgsfield {
  constructor(page, { timeoutMs = 180000 } = {}) {
    this.page = page;
    this.timeoutMs = timeoutMs;
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

  /** Navigate to the image generator for a model (model set via URL param). */
  async openImageGenerator(model) {
    const url = `${BASE_URL}${IMAGE_PATH}?model=${encodeURIComponent(model)}`;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    if (await this.isCaptcha()) throw new CaptchaError();
    await firstVisible(this.page, SEL.promptBox, { timeout: 30000 });
    await this.dismissCookies();
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

  /** Type the prompt into the Lexical editor (clears any existing text first). */
  async setPrompt(text) {
    await this.dismissCookies();
    const box = await firstVisible(this.page, SEL.promptBox);
    await box.click();
    await this._humanPause(300, 700);
    await box.press('Control+A').catch(() => {});
    await box.press('Delete').catch(() => {});
    await box.type(text, { delay: 35 }); // realistic typing speed
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
      console.log(`  • (ratio left as-is: ${err.message})`);
    }
  }

  async setQuality(quality) {
    if (!quality) return;
    try {
      await this.chooseFromMenu(SEL.qualityButton, quality, 'quality');
    } catch (err) {
      console.log(`  • (quality left as-is: ${err.message})`);
    }
  }

  /** The first large, fully-loaded result image (newest generation). */
  async getFirstResult() {
    const handles = await this.page.locator(SEL.resultImages.join(', ')).elementHandles();
    for (const h of handles) {
      const info = await h.evaluate((im) => ({
        src: im.currentSrc || im.src,
        complete: im.complete,
        w: im.naturalWidth,
      }));
      if (info.src && info.complete && info.w > 200) return info.src;
    }
    return null;
  }

  /** Click Generate (must be called only after ensureUnlimitedOn). */
  async generate() {
    const btn = await firstVisible(this.page, SEL.generateButton, { timeout: 8000 });
    await this._click(btn);
    console.log('  • clicked Generate');
  }

  /**
   * Wait until a NEW result image (different from `prevSrc`) appears and is fully
   * loaded as the newest item. Returns its src. Throws CaptchaError if the
   * bot-check appears while waiting.
   */
  async waitForResult(prevSrc) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isCaptcha()) throw new CaptchaError();
      const src = await this.getFirstResult();
      if (src && src !== prevSrc) {
        console.log('  • generation complete');
        return src;
      }
      await this.page.waitForTimeout(1500);
    }
    throw new Error(`Timed out (${this.timeoutMs}ms) waiting for the generated image.`);
  }

  /**
   * Download the newest result at full resolution and save it.
   * Primary: hover the card and click its download control, capturing the
   * browser download event. Fallback: fetch the image src bytes directly.
   * @returns {Promise<string>} saved file path
   */
  async downloadNewest(outputDir, baseName) {
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
      return p;
    } catch (err) {
      console.log(`  • download button path failed (${err.message}); fetching image src`);
      const src = await this.getFirstResult();
      if (!src) throw new Error('No result image available to download.');
      return downloadImage(this.page, src, { outputDir, baseName });
    }
  }
}

module.exports = { Higgsfield, SEL, BASE_URL, IMAGE_PATH, firstVisible, CaptchaError };

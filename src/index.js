'use strict';

const { loadConfig, loadPrompts } = require('./config');
const { launchAndConnect } = require('./browser');
const { Higgsfield, CaptchaError } = require('./higgsfield');
const { sanitize } = require('./download');

/** Timestamp in hhmmddMM (hour, minute, day, month). */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + p(d.getMinutes()) + p(d.getDate()) + p(d.getMonth() + 1);
}

/** Short filename-safe slug from a prompt. */
function slug(s) {
  return sanitize(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Wait until logged in (prompt box visible), prompting the user if needed. */
async function ensureLoggedIn(hf, page) {
  if (await hf.isReady()) return;
  console.log('\n  >>> Please LOG IN to Higgsfield in the Chrome window that just opened. <<<');
  console.log('  (Use your Google account — this is real Chrome, so Google will allow it.)');
  console.log('  Waiting up to 5 minutes...\n');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await hf.isReady()) {
      console.log('  • login detected');
      return;
    }
    await page.waitForTimeout(2000);
  }
  throw new Error('Timed out waiting for login.');
}

async function main() {
  const cfg = loadConfig();
  const prompts = loadPrompts();
  if (prompts.length === 0) {
    console.log('No prompts found in prompts.txt. Add one prompt per line.');
    return;
  }

  console.log('Higgsfield batch generator');
  console.log(`  prompts: ${prompts.length}  |  model=${cfg.model} ratio=${cfg.ratio} quality=${cfg.quality}`);
  console.log(`  output: ${cfg.outputDir}\n`);

  const { browser, page } = await launchAndConnect(cfg);
  const hf = new Higgsfield(page, cfg);

  const results = []; // { prompt, status, file }
  let stoppedEarly = false;

  try {
    await hf.openImageGenerator(cfg.model);
    await ensureLoggedIn(hf, page);
    await hf.dismissCookies();

    // Set ratio/quality once for the whole batch (no-op if already correct).
    await hf.setRatio(cfg.ratio);
    await hf.setQuality(cfg.quality);

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      const n = String(i + 1).padStart(2, '0');
      console.log(`\n=== [${i + 1}/${prompts.length}] ${prompt} ===`);

      try {
        await hf.dismissCookies();

        // CREDIT GUARD: must confirm Unlimited ON or we skip (never spend a credit).
        try {
          await hf.ensureUnlimitedOn();
        } catch (guardErr) {
          console.log(`  ! skipped: ${guardErr.message}`);
          results.push({ prompt, status: 'skipped (Unlimited not ON)', file: '' });
          continue;
        }

        await hf.setPrompt(prompt);
        await hf.ensureUnlimitedOn(); // re-verify right before generating

        const prevSrc = await hf.getFirstResult();
        await hf.generate();

        if (await hf.isCaptcha()) throw new CaptchaError();

        await hf.waitForResult(prevSrc);

        const baseName = `${n}_${slug(prompt)}_${stamp()}`;
        const file = await hf.downloadNewest(cfg.outputDir, baseName);
        console.log(`  • saved ${file}`);
        results.push({ prompt, status: 'ok', file });

        await hf._humanPause(cfg.stepDelayMs, cfg.stepDelayMs + 2000);
      } catch (err) {
        if (err instanceof CaptchaError) {
          console.error('\n!!! CAPTCHA appeared — stopping the batch (cannot auto-solve).');
          results.push({ prompt, status: 'CAPTCHA — not generated', file: '' });
          stoppedEarly = true;
          break;
        }
        console.error(`  ! error: ${err.message}`);
        results.push({ prompt, status: `error: ${err.message}`, file: '' });
      }
    }
  } finally {
    // Leave Chrome running (session stays warm); just drop the CDP connection.
    await browser.close().catch(() => {});
  }

  // --- summary ---
  console.log('\n================= SUMMARY =================');
  results.forEach((r, i) => {
    const tag = r.status === 'ok' ? 'OK ' : '!! ';
    console.log(`${tag}[${i + 1}] ${r.prompt}`);
    console.log(`      ${r.status === 'ok' ? r.file : r.status}`);
  });
  const done = results.filter((r) => r.status === 'ok').length;
  const remaining = prompts.slice(results.length);
  console.log(`\n${done}/${prompts.length} saved to ${cfg.outputDir}`);
  if (stoppedEarly && remaining.length) {
    console.log(`Stopped early. Remaining ${remaining.length} prompt(s):`);
    remaining.forEach((p) => console.log(`  - ${p}`));
    console.log('Re-run after solving the verification to continue.');
  }
  console.log('==========================================');
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});

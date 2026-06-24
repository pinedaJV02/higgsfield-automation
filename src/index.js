'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadConfig,
  loadPrompts,
  loadStyle,
  loadSafety,
  loadCharacters,
  loadBackgrounds,
  loadBaseCharacter,
  DEFAULT_BASE_INSTRUCTION,
} = require('./config');
const { launchAndConnect } = require('./browser');
const { Higgsfield, CaptchaError, ModerationError, stampOf } = require('./higgsfield');
const { sanitize, imageInfo } = require('./download');
const { extractReferences, resolveReferences, selectCharacters, matchByTerms, runPlan } = require('./planner');

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

/** The `{noref}` token disables reference attachment for a prompt. */
const NOREF_RE = /\{\s*noref\s*\}/i;

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
  const style = loadStyle();
  const safetyPreamble = loadSafety();
  const characters = cfg.references ? loadCharacters(cfg.charactersDir) : [];
  const backgrounds = cfg.backgrounds ? loadBackgrounds(cfg.backgroundsDir) : [];
  const base = cfg.useBaseImage ? loadBaseCharacter(cfg.baseCharacterDir) : null;
  if (prompts.length === 0) {
    console.log('No prompts found in prompts.txt. Add one prompt per line.');
    return;
  }

  console.log('Higgsfield batch generator');
  console.log(`  prompts: ${prompts.length}  |  model=${cfg.model} ratio=${cfg.ratio} quality=${cfg.quality}`);
  console.log(`  unlimited: ${cfg.unlimited ? 'ON (no credits)' : 'OFF (SPENDS CREDITS)'}`);
  if (style) console.log(`  style suffix: "${style}"`);
  if (characters.length) {
    console.log(`  characters: ${characters.map((c) => c.keyword).join(', ')}`);
  } else if (cfg.references) {
    console.log(`  characters: (none in ${cfg.charactersDir})`);
  }
  if (backgrounds.length) {
    console.log(`  backgrounds: ${backgrounds.map((c) => c.keyword).join(', ')}`);
  } else if (cfg.backgrounds) {
    console.log(`  backgrounds: (none in ${cfg.backgroundsDir})`);
  }
  if (cfg.useBaseImage) {
    if (base && base.file) {
      const custom = base.instruction !== DEFAULT_BASE_INSTRUCTION;
      console.log(`  base image: ${path.basename(base.file)} (fallback when a prompt has no character)`);
      console.log(`  base instruction: ${custom ? 'custom (instruction.txt)' : 'default'}`);
    } else {
      console.log(`  ⚠ base image: ENABLED but none found in ${cfg.baseCharacterDir}`);
    }
  }
  console.log(`  output: ${cfg.outputDir}\n`);

  const { browser, page } = await launchAndConnect(cfg);
  const hf = new Higgsfield(page, cfg);

  // locked[keyword] = absolute path of the first generated image for that
  // character; reused as its reference in later prompts (lock-first-generation).
  const locked = {};
  const results = []; // { label, prompt, baseName, status, file, stamp, prevStamp }
  let stoppedEarly = false;
  let plan = null;

  try {
    await hf.openImageGenerator(cfg.model);
    await ensureLoggedIn(hf, page);
    await hf.dismissCookies();

    // AI planning (optional): one Claude CLI call → plan.md/plan.json with the cast,
    // 5-6 background scenes, and a per-prompt character suggestion. Runs AFTER login
    // so the Chrome window opens first and you can sign in immediately; it never
    // blocks the login step. Degrades to heuristics on any failure; the master
    // prompt's [reference:] tags still win.
    if (cfg.aiPlanning) {
      console.log('  • AI planning via Claude CLI…');
      plan = await runPlan(cfg, prompts, characters);
      if (plan && Array.isArray(plan.missing) && plan.missing.length) {
        console.log(`  • characters to add to characters/: ${plan.missing.join(', ')}`);
      }
    }

    // Switch to the configured model + verify (Unlimited required only when ON).
    await hf.selectModel();
    await hf.verifyModelAndUnlimited();

    // Set ratio/quality once for the whole batch (no-op if already correct).
    await hf.setRatio(cfg.ratio);
    await hf.setQuality(cfg.quality);

    for (let i = 0; i < prompts.length; i++) {
      const { timestamp } = prompts[i];
      const n = String(i + 1).padStart(2, '0');
      const noref = NOREF_RE.test(prompts[i].text);
      // Pull [reference:]/[main character] tags out (they name which images to
      // attach) and strip them + {noref} from the text that gets typed.
      const { clean: prompt, refs } = extractReferences(prompts[i].text.replace(NOREF_RE, ''));
      const label = timestamp || `#${n}`;
      const baseName = timestamp ? timestamp.replace(/:/g, '_') : `${n}_${slug(prompt)}_${stamp()}`;
      const rec = { label, prompt, baseName, status: 'pending', file: '', stamp: '', prevStamp: '' };
      results.push(rec);
      console.log(`\n=== [${i + 1}/${prompts.length}] [${label}] ${prompt} ===`);

      try {
        await hf.dismissCookies();

        // CREDIT GUARD (only when unlimited mode): confirm Unlimited ON or skip.
        if (cfg.unlimited) {
          try {
            await hf.ensureUnlimitedOn();
          } catch (guardErr) {
            console.log(`  ! skipped: ${guardErr.message}`);
            rec.status = 'skipped (Unlimited not ON)';
            continue;
          }
        }

        // Decide which character references to attach, in priority order:
        //   1. [reference:]/[main character] tags from the master prompt → exact
        //      on-disk character files (authoritative).
        //   2. otherwise the AI planner's per-prompt suggestion (if any), then a
        //      name/alias + role-cue heuristic (selectCharacters).
        // The base style image is attached ONLY as a fallback — when the prompt
        // resolves to NO character at all (so the base guy disappears the moment a
        // real character is present). {noref} skips everything.
        let selected = [];
        let refPaths = [];
        if (!noref) {
          if (refs.length) {
            const { matched, missing } = resolveReferences(refs, characters);
            selected = matched;
            refPaths = matched.map((c) => c.file); // exact reference, not a locked frame
            if (missing.length) {
              console.log(`  ⚠ referenced but missing from characters/: ${missing.join(', ')} — add them`);
            }
          } else if (cfg.references && characters.length) {
            const planForPrompt = plan && Array.isArray(plan.perPrompt)
              ? plan.perPrompt.find((p) => p.i === i)
              : null;
            selected = selectCharacters(prompt, characters, planForPrompt);
            refPaths = selected.map((c) => locked[c.keyword] || c.file);
          }
        }
        rec.matched = selected.map((c) => c.keyword);

        // Background reference: matched by keyword/alias against the prompt, just
        // like characters (e.g. "sunset" → backgrounds/sunset.png). Attach at most
        // one so two backgrounds never fight. Independent of the character choice.
        let bg = [];
        if (!noref && cfg.backgrounds && backgrounds.length) {
          bg = matchByTerms(prompt, backgrounds).slice(0, 1);
          if (bg.length) refPaths.push(bg[0].file);
        }

        // The base style image is the last-resort fallback: only when the prompt
        // resolves to NO character AND no background reference.
        const baseAttached = !!(base && base.file && !noref && selected.length === 0 && bg.length === 0);
        if (baseAttached) refPaths.unshift(base.file);
        refPaths = [...new Set(refPaths)];

        if (selected.length) {
          console.log(`  • characters: ${selected.map((c) => c.keyword).join(', ')}`);
        }
        if (bg.length) {
          console.log(`  • background: ${bg[0].keyword}`);
        }
        if (!selected.length && !bg.length && baseAttached) {
          console.log('  • base style image (no specific character/background)');
        }
        await hf.clearReferences();
        await hf.attachReferences(refPaths);

        // Prompt text = prompt + style suffix + base instruction (only when the
        // base image was actually attached, so the wording never references an
        // image that isn't there).
        const parts = [prompt];
        if (style) parts.push(style);
        if (baseAttached) parts.push(base.instruction);
        const fullPrompt = parts.join(' ').replace(/\s+/g, ' ').trim();
        await hf.setPrompt(fullPrompt);
        if (cfg.unlimited) await hf.ensureUnlimitedOn(); // re-verify before generating

        // Wait for the references to finish uploading before generating, so we
        // never fire against a half-uploaded image. Generate anyway (with a warn)
        // if completion can't be confirmed in time, rather than blocking the batch.
        if (refPaths.length) {
          const ready = await hf.waitForUploadsComplete(refPaths.length);
          if (!ready) {
            console.log('  ⚠ uploads not confirmed complete within window — generating anyway');
          }
        }

        // Baseline of any moderation-matching text already on the page (e.g. an
        // "NSFW" filter label, the prompt itself) captured BEFORE generating, so a
        // real rejection is recognized only as text that appears AFTER Generate.
        const modBaseline = await hf.moderationPhrases();

        // Generate, waiting for the result. If it's rejected as NSFW/content-
        // policy, retry ONCE with the safety preamble prepended; a second
        // rejection (or any other error) propagates to the catch below.
        let newSrc = null;
        for (let attempt = 0; ; attempt++) {
          if (attempt > 0) {
            console.log(`  • rejected — retrying with safety preamble (attempt ${attempt + 1})`);
            await hf.waitForModerationClear(modBaseline); // let the stale rejection clear
            await hf.setPrompt(`${safetyPreamble} ${fullPrompt}`.replace(/\s+/g, ' ').trim());
            if (cfg.unlimited) await hf.ensureUnlimitedOn();
          }
          const prevSrc = await hf.getFirstResult();
          rec.prevStamp = stampOf(prevSrc) || '';
          await hf.generate();
          if (await hf.isCaptcha()) throw new CaptchaError();
          try {
            newSrc = await hf.waitForResult(prevSrc, { moderationBaseline: modBaseline });
            break;
          } catch (genErr) {
            if (genErr instanceof ModerationError && attempt < 1) continue; // retry once
            throw genErr;
          }
        }
        rec.stamp = stampOf(newSrc) || '';

        const file = await hf.downloadNewest(cfg.outputDir, baseName, newSrc);
        console.log(`  • saved ${file}`);
        rec.status = 'ok';
        rec.file = file;

        // Lock the first generation of each newly-seen character.
        for (const kw of rec.matched || []) {
          if (!locked[kw]) {
            locked[kw] = file;
            console.log(`  • locked character "${kw}" → ${path.basename(file)}`);
          }
        }

        await hf._humanPause(cfg.stepDelayMs, cfg.stepDelayMs + 2000);
      } catch (err) {
        if (err instanceof CaptchaError) {
          console.error('\n!!! CAPTCHA appeared — stopping the batch (cannot auto-solve).');
          rec.status = 'CAPTCHA — not generated';
          stoppedEarly = true;
          break;
        }
        if (err instanceof ModerationError) {
          console.error(`  ! rejected (NSFW/moderation): ${err.message}`);
          rec.status = 'rejected (NSFW/moderation)';
        } else if (/Timed out/i.test(err.message)) {
          console.error(`  ! timeout: ${err.message}`);
          rec.status = 'timeout';
        } else {
          console.error(`  ! error: ${err.message}`);
          rec.status = `error: ${err.message}`;
        }
      }
    }

    // --- recover timed-out prompts whose images finished after we gave up ---
    const timeouts = results.filter((r) => r.status === 'timeout');
    if (timeouts.length && !stoppedEarly) {
      console.log(`\n--- Rescanning feed for ${timeouts.length} timed-out prompt(s) ---`);
      await hf._scrollResultsTop().catch(() => {});
      const feed = await hf.listResults(); // [{src,stamp}] oldest→newest
      const claimed = new Set(results.filter((r) => r.stamp).map((r) => r.stamp));
      for (const r of timeouts) {
        const cand = feed.find((f) => f.stamp > (r.prevStamp || '') && !claimed.has(f.stamp));
        if (!cand) {
          console.log(`  • no missed result found for [${r.label}]`);
          continue;
        }
        try {
          const file = await hf.downloadNewest(cfg.outputDir, r.baseName, cand.src);
          claimed.add(cand.stamp);
          r.status = 'ok (recovered)';
          r.file = file;
          r.stamp = cand.stamp;
          console.log(`  • recovered [${r.label}] → ${file}`);
        } catch (e) {
          console.log(`  ! recover failed for [${r.label}]: ${e.message}`);
        }
      }
    }
  } finally {
    // Leave Chrome running (session stays warm); just drop the CDP connection.
    await browser.close().catch(() => {});
  }

  // --- summary ---
  console.log('\n================= SUMMARY =================');
  results.forEach((r) => {
    const ok = r.status.startsWith('ok');
    console.log(`${ok ? 'OK ' : '!! '}[${r.label}] ${r.prompt.slice(0, 60)}`);
    console.log(`      ${ok ? r.file : r.status}`);
  });
  const done = results.filter((r) => r.status.startsWith('ok')).length;
  const remaining = prompts.slice(results.length);
  console.log(`\n${done}/${prompts.length} saved to ${cfg.outputDir}`);
  if (stoppedEarly && remaining.length) {
    console.log(`Stopped early. Remaining ${remaining.length} prompt(s):`);
    remaining.forEach((p) => console.log(`  - ${p.timestamp ? '[' + p.timestamp + '] ' : ''}${p.text}`));
    console.log('Re-run after solving the verification to continue.');
  }

  // --- file-level fulfillment check ---
  console.log('\n================= FULFILLMENT =================');
  let flagged = 0;
  for (const r of results) {
    if (r.status.startsWith('ok') && r.file && fs.existsSync(r.file)) {
      const info = imageInfo(r.file);
      const longSide = Math.max(info.width, info.height);
      const good = info.ok && longSide >= 1000 && info.bytes >= 50 * 1024;
      if (good) {
        console.log(`  ✓ [${r.label}] ${path.basename(r.file)} ${info.width}x${info.height}`);
      } else {
        flagged++;
        const why = !info.ok
          ? 'unreadable image'
          : longSide < 1000
            ? `too small (${info.width}x${info.height})`
            : `tiny file (${info.bytes} bytes)`;
        console.log(`  ⚠ FLAGGED [${r.label}] ${path.basename(r.file)} — ${why}`);
      }
    } else {
      flagged++;
      console.log(`  ⚠ FLAGGED [${r.label}] not fulfilled — ${r.status}`);
    }
  }
  console.log(
    flagged === 0
      ? `All ${results.length} prompt(s) fulfilled. ✓`
      : `${flagged} prompt(s) FLAGGED — review above.`
  );
  console.log('==========================================');
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});

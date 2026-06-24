'use strict';

/**
 * Planning + character-selection helpers.
 *
 * The master prompt (see Project_start/updated_master_prompt_v5.txt) is the brain:
 * it embeds `[reference: FILENAME.PNG]` and `[main character]` tags in each image
 * prompt. The automation's job is to OBEY those tags — `extractReferences` pulls
 * them out (and strips them from the text). When a prompt carries no tags, we fall
 * back to `selectCharacters` (name/alias + role cues) or, if enabled, a one-shot
 * Claude Code CLI plan (`runPlan`) that also writes a human-readable plan.md.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PROJECT_ROOT } = require('./config');

const IMG_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
const PLAN_MD = path.join(PROJECT_ROOT, 'plan.md');
const PLAN_JSON = path.join(PROJECT_ROOT, 'plan.json');

/** Normalize a reference name/keyword to a comparable key. */
function refKey(name) {
  return String(name)
    .replace(IMG_EXT_RE, '')
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Pull `[reference: FILE]` and `[main character]` tags out of a prompt and return
 * the cleaned text (tags removed so they aren't typed) plus the referenced names.
 * `[main character]` resolves to the conventional `Main_character.PNG`.
 * @returns {{ clean: string, refs: string[] }}
 */
function extractReferences(text) {
  const refs = [];
  let clean = String(text || '');

  // [reference: A.PNG] or [reference: A.PNG, B.PNG]
  clean = clean.replace(/\[reference:\s*([^\]]+?)\s*\]/gi, (_m, list) => {
    for (const item of String(list).split(',')) {
      const name = item.trim();
      if (name) refs.push(name);
    }
    return ' ';
  });

  // [main character] tag → the main character's image.
  clean = clean.replace(/\[main character\]/gi, () => {
    refs.push('Main_character.PNG');
    return ' ';
  });

  clean = clean.replace(/\s+/g, ' ').trim();
  // De-dupe by normalized key, keep first spelling.
  const seen = new Set();
  const unique = [];
  for (const r of refs) {
    const k = refKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(r);
    }
  }
  return { clean, refs: unique };
}

/** Does a character match a reference name or role term (by filename/keyword/alias)? */
function characterMatches(character, name) {
  const key = refKey(name);
  if (!key) return false;
  if (path.basename(character.file).toLowerCase() === String(name).toLowerCase()) return true;
  if (character.keyword === key) return true;
  if (Array.isArray(character.terms) && character.terms.includes(key)) return true;
  return false;
}

/**
 * Resolve referenced names to character files in the loaded set.
 * @returns {{ files: string[], matched: object[], missing: string[] }}
 */
function resolveReferences(refs, characters) {
  const files = [];
  const matched = [];
  const missing = [];
  for (const ref of refs) {
    const hit = characters.find((c) => characterMatches(c, ref));
    if (hit) {
      if (!files.includes(hit.file)) {
        files.push(hit.file);
        matched.push(hit);
      }
    } else {
      missing.push(ref);
    }
  }
  return { files, matched, missing };
}

// Scene-role cues → candidate character roles (matched against keyword/aliases).
// Lets a scene pull the right character even when the character's literal name
// isn't written in the prompt. First cue that hits wins.
const ROLE_CUES = [
  { re: /\b(rescue|rescuer|saving|saved|pull(ed|ing)?|trapped|rubble|collaps\w*|drown\w*|emergency)\b/i, roles: ['rescuer', 'rescue man', 'firefighter', 'construction', 'worker'] },
  { re: /\b(doctor|medical|hospital|patient|diagnos\w*|clinic|nurse|surgery)\b/i, roles: ['doctor'] },
  { re: /\b(science|scientific|experiment|laborator\w*|hypothesis|theory|chemical|biolog\w*|physics)\b/i, roles: ['doctor', 'main character'] },
  { re: /\b(explain\w*|teach\w*|lesson|demonstrat\w*|how|why)\b/i, roles: ['main character', 'doctor'] },
  { re: /\b(narrat\w*|intro|host|present\w*|monologue|camera)\b/i, roles: ['main character'] },
  { re: /\b(police|officer|\bcop\b|arrest\w*|crime)\b/i, roles: ['cop', 'police'] },
  { re: /\b(construction|worker|build(ing|er)?|site|labou?r)\b/i, roles: ['worker', 'construction'] },
];

/** Characters whose keyword/aliases match any of the given role names. */
function charactersForRoles(roles, characters) {
  const out = [];
  for (const role of roles) {
    for (const c of characters) {
      if (characterMatches(c, role) && !out.includes(c)) out.push(c);
    }
    if (out.length) break; // first role with a hit wins
  }
  return out;
}

/** Whole-word/phrase match of a character's terms against the prompt. */
function matchByTerms(promptText, characters) {
  const norm = ' ' + String(promptText).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  const inText = (t) =>
    !!t && (norm.includes(' ' + t + ' ') || norm.includes(' ' + t + 's ') ||
      (t.endsWith('s') && norm.includes(' ' + t.slice(0, -1) + ' ')));
  return characters.filter((c) => {
    const terms = c.terms && c.terms.length ? c.terms : [c.keyword];
    return terms.some(inText);
  });
}

/**
 * Choose characters for a prompt that carries NO `[reference:]` tags:
 *   1. explicit plan names (from Claude), if given;
 *   2. direct name/alias match;
 *   3. role cues (rescue→rescuer, explain→main/doctor, …);
 *   4. default to the main character so most human scenes still get a character.
 * Returns matched character objects (possibly empty if the folder has none).
 */
function selectCharacters(promptText, characters, planForPrompt) {
  if (!characters.length) return [];

  if (planForPrompt && Array.isArray(planForPrompt.characters) && planForPrompt.characters.length) {
    const { matched } = resolveReferences(planForPrompt.characters, characters);
    if (matched.length) return matched;
  }

  const direct = matchByTerms(promptText, characters);
  if (direct.length) return direct;

  for (const cue of ROLE_CUES) {
    if (cue.re.test(promptText)) {
      const hit = charactersForRoles(cue.roles, characters);
      if (hit.length) return hit;
    }
  }

  return charactersForRoles(['main character', 'main'], characters);
}

// --------------------------------------------------------------------------
// Claude Code CLI planning (optional, toggleable)
// --------------------------------------------------------------------------

/** Build the planning request sent to Claude (returned as the stdin payload). */
function buildPlanPrompt(prompts, characters) {
  const charLines = characters.length
    ? characters.map((c) => `- ${path.basename(c.file)} (keyword: "${c.keyword}"${c.description ? `; aliases: ${c.description}` : ''})`).join('\n')
    : '(none yet)';
  const scriptLines = prompts
    .map((p, i) => `${i}\t${p.timestamp ? '[' + p.timestamp + '] ' : ''}${p.text}`)
    .join('\n');

  return [
    'You are planning character and background usage for a hand-drawn doodle explainer video.',
    'Below are (A) the reference characters that already exist in the project, and (B) the ordered list of image prompts (one per timestamp), each with its index.',
    '',
    'IMPORTANT: You are running non-interactively and CANNOT ask questions. Plan for exactly the prompts provided — however many there are, even if only one. Never request more input, never ask for clarification, never add commentary. Respond with the JSON object and nothing else.',
    '',
    'Produce a casting + scene plan and respond with ONLY a single JSON object (no prose, no markdown, no code fences) of exactly this shape:',
    '{',
    '  "cast": [{"name": string, "role": string, "description": string, "existing": boolean}],',
    '  "missing": [string],',
    '  "scenes": [{"name": string, "description": string}],',
    '  "perPrompt": [{"i": number, "characters": [string]}]',
    '}',
    'Rules: "cast" = the recurring characters the script needs; set "existing" true if it matches one of the existing reference files, else false and also add its name to "missing". "scenes" = the 5 to 6 recurring BACKGROUND setups the video reuses (flat color block style; say when each is used). "perPrompt" = for every prompt index, the characters (by existing filename when possible, else cast name) that should appear; use [] for prompts with no character. Keep names consistent across the arrays.',
    '',
    'A) EXISTING CHARACTERS:',
    charLines,
    '',
    'B) IMAGE PROMPTS (index<TAB>text):',
    scriptLines,
  ].join('\n');
}

/** Run the claude CLI headlessly. Resolves { out, err, code } (rejects only on
 *  spawn failure or timeout) so the caller can inspect auth/error envelopes. */
function runClaude(cmd, stdinPayload, model, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ['-p', 'Read the planning request from stdin and reply with ONLY the JSON object it specifies.', '--output-format', 'json'];
    if (model) args.push('--model', model);
    const child = spawn(cmd, args, { cwd: PROJECT_ROOT });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ out, err, code });
    });
    child.stdin.end(stdinPayload);
  });
}

/** Extract the plan object from the CLI output (json envelope → result → JSON). */
function parsePlanJson(raw) {
  let text = raw;
  // `--output-format json` wraps the reply: { type:'result', result:'<text>' , ... }
  try {
    const env = JSON.parse(raw);
    if (env && typeof env.result === 'string') text = env.result;
  } catch {
    /* not an envelope — treat raw as the text */
  }
  // Strip code fences if present, then grab the outermost {...}.
  text = text.replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const data = JSON.parse(text.slice(start, end + 1));
    if (data && typeof data === 'object') return data;
  } catch {
    /* unparseable */
  }
  return null;
}

/** Write plan.json (machine) and plan.md (human-readable) to the project root. */
function writePlanFiles(plan, prompts) {
  fs.writeFileSync(PLAN_JSON, JSON.stringify(plan, null, 2) + '\n');

  const lines = ['# Video plan', ''];
  if (Array.isArray(plan.cast) && plan.cast.length) {
    lines.push('## Cast', '');
    for (const c of plan.cast) {
      lines.push(`- **${c.name}** (${c.role || 'role?'})${c.existing ? '' : ' — _missing from characters/_'}${c.description ? ` — ${c.description}` : ''}`);
    }
    lines.push('');
  }
  if (Array.isArray(plan.missing) && plan.missing.length) {
    lines.push('## Characters to add to characters/', '', ...plan.missing.map((m) => `- ${m}`), '');
  }
  if (Array.isArray(plan.scenes) && plan.scenes.length) {
    lines.push('## Background scenes', '');
    for (const s of plan.scenes) lines.push(`- **${s.name}** — ${s.description || ''}`);
    lines.push('');
  }
  if (Array.isArray(plan.perPrompt) && plan.perPrompt.length) {
    lines.push('## Per-prompt characters', '');
    for (const pp of plan.perPrompt) {
      const p = prompts[pp.i];
      const label = p ? (p.timestamp ? `[${p.timestamp}]` : `#${pp.i + 1}`) : `#${pp.i}`;
      const chars = (pp.characters || []).join(', ') || '—';
      lines.push(`- ${label}: ${chars}`);
    }
    lines.push('');
  }
  fs.writeFileSync(PLAN_MD, lines.join('\n'));
}

/**
 * Run a one-shot Claude plan. Returns the parsed plan object (also written to
 * plan.json/plan.md) or null on any failure (caller falls back to heuristics).
 */
async function runPlan(cfg, prompts, characters) {
  const cmd = cfg.claudeCommand;
  if (!cmd || !fs.existsSync(cmd)) {
    console.log('  ⚠ AI planning: Claude CLI not found — skipping (heuristics will be used).');
    return null;
  }
  try {
    const payload = buildPlanPrompt(prompts, characters);
    const { out, err, code } = await runClaude(cmd, payload, cfg.claudeModel, 180000);

    // Not-logged-in is the common case: the standalone CLI has its own auth.
    if (/not logged in|\/login|please run .*login|invalid api key|authentication/i.test(out + err)) {
      console.log('  ⚠ AI planning: the Claude CLI is not logged in — run "claude" once and complete /login (or set ANTHROPIC_API_KEY), or set "aiPlanning": false. Using heuristics for now.');
      return null;
    }

    const plan = parsePlanJson(out);
    if (!plan) {
      console.log(`  ⚠ AI planning: could not parse Claude output (exit ${code}) — using heuristics.`);
      return null;
    }
    writePlanFiles(plan, prompts);
    console.log(`  • plan written: ${path.basename(PLAN_MD)} (+ plan.json)`);
    return plan;
  } catch (e) {
    console.log(`  ⚠ AI planning failed: ${e.message} — using heuristics.`);
    return null;
  }
}

module.exports = {
  extractReferences,
  resolveReferences,
  selectCharacters,
  matchByTerms,
  buildPlanPrompt,
  runPlan,
  PLAN_MD,
  PLAN_JSON,
};

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const PROMPTS_PATH = path.join(PROJECT_ROOT, 'prompts.txt');
const STYLE_PATH = path.join(PROJECT_ROOT, 'style.txt');
const SAFETY_PATH = path.join(PROJECT_ROOT, 'safety.txt');

const DEFAULTS = {
  model: 'seedream_v4_5',
  modelLabel: '', // exact UI text for the model picker; auto-derived if empty
  ratio: '16:9',
  quality: '2K',
  unlimited: true, // true = never spend a credit (credit guard). false = spend credits.
  references: true, // attach matching characters/ images as references to each prompt
  charactersDir: './characters', // folder of character reference images
  useBaseImage: true, // attach the base style image as a reference to EVERY prompt
  baseCharacterDir: './base_character', // folder holding the base style image (+ instruction.txt)
  outputDir: './output',
  timeoutMs: 300000, // max wait per generation (some runs exceed 3 min)
  stepDelayMs: 4000, // base pause between prompts (human-like pacing)
  chromePort: 9222,
  chromePath: '', // auto-detected if empty
  uiPort: 5179, // local web UI (open-ui.bat / src/server.js)
};

/** Auto-detect the installed Chrome executable on Windows. */
function detectChrome() {
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || '';
}

/**
 * Merge a raw config object over DEFAULTS, validate required fields, and coerce
 * numeric fields. Pure — does NO disk I/O (no mkdir, no Chrome detection), so it
 * is safe for the web UI to call when validating a candidate config before save.
 * Throws on invalid input.
 * @returns {object} the merged + coerced config (paths NOT resolved).
 */
function validateConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...raw };

  if (!cfg.model || typeof cfg.model !== 'string') {
    throw new Error('config.model must be a non-empty string (e.g. "seedream_v4_5").');
  }
  if (!cfg.ratio || typeof cfg.ratio !== 'string') {
    throw new Error('config.ratio must be a non-empty string (e.g. "16:9").');
  }
  cfg.timeoutMs = Number(cfg.timeoutMs) || DEFAULTS.timeoutMs;
  cfg.stepDelayMs = Number.isFinite(Number(cfg.stepDelayMs))
    ? Number(cfg.stepDelayMs)
    : DEFAULTS.stepDelayMs;
  cfg.chromePort = Number(cfg.chromePort) || DEFAULTS.chromePort;
  cfg.uiPort = Number(cfg.uiPort) || DEFAULTS.uiPort;
  cfg.unlimited = Boolean(cfg.unlimited);
  cfg.references = Boolean(cfg.references);
  cfg.useBaseImage = Boolean(cfg.useBaseImage);

  return cfg;
}

/**
 * Load config.json, apply defaults, validate, and resolve paths.
 */
function loadConfig() {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      throw new Error(`config.json is not valid JSON: ${err.message}`);
    }
  }

  const cfg = validateConfig(raw);

  // --- resolve paths ---
  cfg.outputDir = path.isAbsolute(cfg.outputDir)
    ? cfg.outputDir
    : path.resolve(PROJECT_ROOT, cfg.outputDir);
  fs.mkdirSync(cfg.outputDir, { recursive: true });

  cfg.charactersDir = path.isAbsolute(cfg.charactersDir)
    ? cfg.charactersDir
    : path.resolve(PROJECT_ROOT, cfg.charactersDir);
  fs.mkdirSync(cfg.charactersDir, { recursive: true });

  cfg.baseCharacterDir = path.isAbsolute(cfg.baseCharacterDir)
    ? cfg.baseCharacterDir
    : path.resolve(PROJECT_ROOT, cfg.baseCharacterDir);
  fs.mkdirSync(cfg.baseCharacterDir, { recursive: true });

  // Dedicated Chrome profile for this tool (keeps the login; separate from the
  // user's everyday Chrome to avoid conflicts).
  cfg.chromeProfileDir = path.join(PROJECT_ROOT, 'chrome-profile');
  fs.mkdirSync(cfg.chromeProfileDir, { recursive: true });

  if (!cfg.chromePath) cfg.chromePath = detectChrome();
  if (!cfg.chromePath) {
    throw new Error(
      'Could not find Google Chrome. Install it, or set "chromePath" in config.json.'
    );
  }

  return cfg;
}

/**
 * Read prompts.txt. Supports two formats — auto-detected:
 *
 * Timestamp format (paste a script list as-is):
 *   [00:00] First prompt text, which may span
 *           multiple lines until the next marker.
 *   [00:05] Second prompt text…
 *   Each [MM:SS] or [HH:MM:SS] marker starts a new prompt.
 *
 * Plain format (original):
 *   One prompt per line. Blank lines ignored.
 *
 * In both formats, lines starting with `#` are treated as comments and ignored.
 */
function loadPrompts() {
  if (!fs.existsSync(PROMPTS_PATH)) {
    throw new Error(`prompts.txt not found at ${PROMPTS_PATH}. Add one prompt per line.`);
  }
  const raw = fs.readFileSync(PROMPTS_PATH, 'utf8');

  // Strip comment lines before any further processing.
  const stripped = raw
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  const TIMESTAMP_SPLIT = /(\[\d+:\d+(?::\d+)?\])/g;

  if (TIMESTAMP_SPLIT.test(stripped)) {
    // Timestamp format: extract each [MM:SS] marker paired with the text that
    // follows it. Returns { timestamp: '00:05', text: '...' } objects so callers
    // can use the timestamp as a filename.
    const parts = stripped.split(TIMESTAMP_SPLIT).filter((s) => s.trim());
    const results = [];
    for (let i = 0; i < parts.length; i++) {
      const tsMatch = parts[i].match(/^\[(\d+:\d+(?::\d+)?)\]$/);
      if (tsMatch && i + 1 < parts.length) {
        results.push({
          timestamp: tsMatch[1],
          text: parts[i + 1].replace(/\s+/g, ' ').trim(),
        });
        i++; // skip the text part — already consumed
      }
    }
    return results;
  }

  // Plain format: one prompt per non-blank line. No timestamp available.
  return stripped
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text) => ({ timestamp: null, text }));
}

/**
 * Read style.txt — the entire file is trimmed and appended to every prompt at
 * runtime (e.g. ", cinematic lighting, 8k"). Returns '' if the file is absent
 * or empty so behaviour is identical to having no style file.
 */
function loadStyle() {
  if (!fs.existsSync(STYLE_PATH)) return '';
  return fs
    .readFileSync(STYLE_PATH, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .join(' ')
    .trim();
}

/**
 * Default safety preamble prepended to a prompt when a generation is rejected as
 * NSFW/content-policy and retried. Steers the model toward an obviously safe,
 * non-graphic rendering. Overridable via `safety.txt` in the project root.
 */
const DEFAULT_SAFETY_PREAMBLE =
  'Non-graphic educational doodle illustration. No gore, blood, injury detail, ' +
  'nudity, or violence — symbolic hand-drawn stick-figure style only.';

/**
 * Read safety.txt — prepended to a prompt on an NSFW/moderation retry. Returns
 * the trimmed file contents (comments/blank lines stripped) if present and
 * non-empty, otherwise DEFAULT_SAFETY_PREAMBLE. Mirrors loadStyle().
 */
function loadSafety() {
  if (fs.existsSync(SAFETY_PATH)) {
    const text = fs
      .readFileSync(SAFETY_PATH, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .join(' ')
      .trim();
    if (text) return text;
  }
  return DEFAULT_SAFETY_PREAMBLE;
}

// Very common words that should never, on their own, trigger a character match
// (they appear in almost any prompt). Multi-word keywords are kept whole, so a
// filename like `main_character.png` simply won't match unless its alias file
// lists real terms.
const STOP_TERMS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'with', 'in', 'on', 'at', 'to', 'for',
  'is', 'it', 'this', 'that', 'as', 'by', 'main', 'character',
]);

/** Normalize a term/phrase: lowercase, non-alphanumeric → single spaces. */
function normTerm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the set of match terms for a character from its filename keyword plus any
 * alias/description text. Includes the full keyword phrase, the keyword with a
 * trailing number stripped (so `dog1` also matches "dog"), and each
 * comma/newline/semicolon-separated alias from the description. Drops blanks,
 * 1-char terms, and stopwords.
 */
function buildTerms(keyword, description) {
  const terms = new Set();
  const add = (raw) => {
    const t = normTerm(raw);
    if (t.length >= 2 && !STOP_TERMS.has(t)) terms.add(t);
  };
  add(keyword);
  const noTrailingNum = normTerm(keyword).replace(/\s*\d+$/, '').trim();
  if (noTrailingNum && noTrailingNum !== normTerm(keyword)) add(noTrailingNum);
  if (description) {
    for (const part of String(description).split(/[\n,;]+/)) add(part);
  }
  return [...terms];
}

/** Read a character's sibling alias/description file (`<base>.txt`), or '' . */
function readDescription(imageFile) {
  const txt = imageFile.replace(/\.(png|jpe?g|webp|gif)$/i, '.txt');
  try {
    if (fs.existsSync(txt)) return fs.readFileSync(txt, 'utf8').trim();
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * Read the characters/ folder. Each image file becomes a named character whose
 * keyword is the filename without extension (separators → spaces, lowercased),
 * e.g. `dog.png` → "dog", `rescue-dog.png` → "rescue dog".
 *
 * A prompt automatically pulls in any character whose `terms` appear in it. Terms
 * come from the filename (incl. `dog1` → also "dog") plus an optional sibling
 * `<base>.txt` alias file (comma/newline-separated aliases, editable in the UI).
 *
 * Returns [{ keyword, file, terms, description }] (absolute `file` paths). Empty
 * if the folder has no images.
 */
function loadCharacters(charactersDir) {
  if (!charactersDir || !fs.existsSync(charactersDir)) return [];
  const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;
  return fs
    .readdirSync(charactersDir)
    .filter((name) => IMG_RE.test(name))
    .map((name) => {
      const keyword = name.replace(IMG_RE, '').replace(/[_-]+/g, ' ').trim().toLowerCase();
      const file = path.join(charactersDir, name);
      const description = readDescription(file);
      return { keyword, file, description, terms: buildTerms(keyword, description) };
    })
    .filter((c) => c.keyword);
}

/**
 * Default instruction appended to every prompt when the base style image is used.
 * Tells the model to keep the base art style and to derive any new character from
 * the base figure with only a minor change. Overridable via `instruction.txt` in
 * the base-character folder (editable from the control panel).
 */
const DEFAULT_BASE_INSTRUCTION =
  'Use the attached reference as the base art style: a hand-drawn black-and-white ' +
  'stick figure with a round head and thick ink outlines on a plain white background. ' +
  'Keep this exact style. If a new character is needed, reuse this base figure and ' +
  'change only a minor feature or the outfit.';

/**
 * Read the base-character folder. The base image (first image file found) is
 * attached as a reference to EVERY prompt (a global style/character anchor), and
 * `instruction` (from `instruction.txt`, or DEFAULT_BASE_INSTRUCTION) is appended
 * to each prompt. Returns { file, instruction, dir } — `file` is null if the
 * folder has no image. Returns null if the folder is missing.
 */
function loadBaseCharacter(baseCharacterDir) {
  if (!baseCharacterDir || !fs.existsSync(baseCharacterDir)) return null;
  const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;
  const imgs = fs.readdirSync(baseCharacterDir).filter((name) => IMG_RE.test(name));
  const file = imgs.length ? path.join(baseCharacterDir, imgs[0]) : null;

  let instruction = DEFAULT_BASE_INSTRUCTION;
  const txt = path.join(baseCharacterDir, 'instruction.txt');
  try {
    if (fs.existsSync(txt)) {
      const t = fs.readFileSync(txt, 'utf8').trim();
      if (t) instruction = t;
    }
  } catch {
    /* use default */
  }
  return { file, instruction, dir: baseCharacterDir };
}

module.exports = {
  loadConfig,
  validateConfig,
  loadPrompts,
  loadStyle,
  loadSafety,
  loadCharacters,
  loadBaseCharacter,
  DEFAULT_BASE_INSTRUCTION,
  DEFAULT_SAFETY_PREAMBLE,
  DEFAULTS,
  PROJECT_ROOT,
  CONFIG_PATH,
  PROMPTS_PATH,
  STYLE_PATH,
  SAFETY_PATH,
};

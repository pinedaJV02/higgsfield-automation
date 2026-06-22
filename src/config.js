'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const PROMPTS_PATH = path.join(PROJECT_ROOT, 'prompts.txt');

const DEFAULTS = {
  model: 'seedream_v4_5',
  ratio: '16:9',
  quality: '2K',
  unlimited: true, // hard requirement: never spend a credit
  outputDir: './output',
  timeoutMs: 180000, // max wait per generation
  stepDelayMs: 4000, // base pause between prompts (human-like pacing)
  chromePort: 9222,
  chromePath: '', // auto-detected if empty
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

  const cfg = { ...DEFAULTS, ...raw };

  // --- validation ---
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

  // --- resolve paths ---
  cfg.outputDir = path.isAbsolute(cfg.outputDir)
    ? cfg.outputDir
    : path.resolve(PROJECT_ROOT, cfg.outputDir);
  fs.mkdirSync(cfg.outputDir, { recursive: true });

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
 * Read prompts.txt — one prompt per line. Blank lines and lines starting with
 * `#` are ignored. Returns an array of prompt strings.
 */
function loadPrompts() {
  if (!fs.existsSync(PROMPTS_PATH)) {
    throw new Error(`prompts.txt not found at ${PROMPTS_PATH}. Add one prompt per line.`);
  }
  return fs
    .readFileSync(PROMPTS_PATH, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

module.exports = { loadConfig, loadPrompts, PROJECT_ROOT };

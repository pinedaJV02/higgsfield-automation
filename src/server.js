'use strict';

/**
 * Zero-dependency local web UI for the Higgsfield batch generator.
 *
 * Serves a small single-page app (ui/index.html) and a JSON API to edit
 * config.json / prompts.txt, upload character reference images, launch the batch
 * (src/index.js) and stream its console output live, and browse the output
 * gallery. Uses only Node's built-in `http` module — no Express/Multer — and
 * binds to 127.0.0.1 only (local control surface). File uploads arrive as
 * base64 JSON so there is no multipart parser to maintain.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const {
  validateConfig,
  loadPrompts,
  loadCharacters,
  loadBackgrounds,
  loadBaseCharacter,
  detectClaude,
  DEFAULT_BASE_INSTRUCTION,
  DEFAULTS,
  PROJECT_ROOT,
  CONFIG_PATH,
  PROMPTS_PATH,
} = require('./config');
const { imageInfo, sanitize } = require('./download');
const { runPlan, PLAN_MD } = require('./planner');

const UI_DIR = path.join(PROJECT_ROOT, 'ui');
const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

/** Read config.json (merged over DEFAULTS). Never throws — returns defaults if
 *  the file is missing/corrupt so the UI can still load and fix it. */
function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return { ...DEFAULTS, ...raw };
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULTS };
}

/** Resolve a possibly-relative path from config against PROJECT_ROOT. */
function resolveDir(p) {
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

function charactersDir() {
  const dir = resolveDir(readConfig().charactersDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function outputDir() {
  const dir = resolveDir(readConfig().outputDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function baseDir() {
  const dir = resolveDir(readConfig().baseCharacterDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backgroundsDir() {
  const dir = resolveDir(readConfig().backgroundsDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Reject filenames that try to escape their folder (path traversal guard). */
function safeName(name) {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const base = path.basename(name);
  return base === name ? base : null;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return; // drain the rest so the socket closes cleanly
      size += c.length;
      if (size > limitBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(c);
    });
    // Resolve/reject only on 'end' so the response can be written without a
    // socket reset (which the browser would surface as "Failed to fetch").
    req.on('end', () =>
      tooLarge ? reject(new Error('Request body too large')) : resolve(Buffer.concat(chunks))
    );
    req.on('error', reject);
  });
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/** Serve <name> from a base dir with a traversal guard + image-extension check. */
function serveFromDir(res, baseDir, name) {
  const safe = safeName(name);
  if (!safe || !IMG_RE.test(safe)) {
    sendJson(res, 400, { error: 'Bad name' });
    return;
  }
  serveFile(res, path.join(baseDir, safe));
}

// ----------------------------------------------------------------------------
// run state (single batch at a time)
// ----------------------------------------------------------------------------

const run = {
  child: null,
  running: false,
  buffer: [], // [{ type:'log'|'exit', stream?:'out'|'err', line }]
  clients: new Set(), // SSE response objects
};
const BUFFER_CAP = 4000;

function broadcast(evt) {
  run.buffer.push(evt);
  if (run.buffer.length > BUFFER_CAP) run.buffer.splice(0, run.buffer.length - BUFFER_CAP);
  const payload = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const c of run.clients) {
    try {
      c.write(payload);
    } catch {
      /* client gone; cleaned up on close */
    }
  }
}

function pumpLines(stream, buf) {
  let pending = '';
  return (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop(); // keep partial line
    for (const line of lines) broadcast({ type: 'log', stream: buf, line });
  };
}

function startRun() {
  if (run.running) return { ok: false, error: 'A run is already in progress.' };
  run.buffer = [];
  run.running = true;
  broadcast({ type: 'log', stream: 'out', line: '=== launching batch (node src/index.js) ===' });

  const child = spawn(process.execPath, [path.join('src', 'index.js')], {
    cwd: PROJECT_ROOT,
    env: process.env,
  });
  run.child = child;

  child.stdout.on('data', pumpLines(child.stdout, 'out'));
  child.stderr.on('data', pumpLines(child.stderr, 'err'));
  child.on('error', (err) => {
    broadcast({ type: 'log', stream: 'err', line: `failed to launch: ${err.message}` });
  });
  child.on('close', (code) => {
    run.running = false;
    run.child = null;
    broadcast({ type: 'exit', line: `=== batch finished (exit code ${code}) ===`, code });
  });
  return { ok: true };
}

function stopRun() {
  if (!run.running || !run.child) return { ok: false, error: 'No run in progress.' };
  const pid = run.child.pid;
  broadcast({ type: 'log', stream: 'err', line: '=== stop requested — terminating batch ===' });
  if (process.platform === 'win32') {
    // Kill the whole process tree (node + the Chrome it spawned).
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  } else {
    try {
      run.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  return { ok: true };
}

// ----------------------------------------------------------------------------
// API handlers
// ----------------------------------------------------------------------------

function handleGetConfig(res) {
  sendJson(res, 200, { config: readConfig(), defaults: DEFAULTS });
}

async function handlePostConfig(req, res) {
  let incoming;
  try {
    incoming = JSON.parse((await readBody(req)).toString() || '{}');
  } catch (e) {
    sendJson(res, 400, { error: `Invalid JSON: ${e.message}` });
    return;
  }
  let validated;
  try {
    validated = validateConfig(incoming);
  } catch (e) {
    sendJson(res, 400, { error: e.message });
    return;
  }
  // Preserve a stable key order matching DEFAULTS for a tidy file.
  const ordered = {};
  for (const k of Object.keys(DEFAULTS)) ordered[k] = validated[k];
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(ordered, null, 2) + '\n');
  } catch (e) {
    sendJson(res, 500, { error: `Could not write config.json: ${e.message}` });
    return;
  }
  sendJson(res, 200, { config: { ...DEFAULTS, ...ordered } });
}

function handleGetPrompts(res) {
  let text = '';
  try {
    if (fs.existsSync(PROMPTS_PATH)) text = fs.readFileSync(PROMPTS_PATH, 'utf8');
  } catch {
    /* leave empty */
  }
  let parsed = [];
  try {
    parsed = loadPrompts();
  } catch {
    parsed = [];
  }
  sendJson(res, 200, { text, count: parsed.length, parsed });
}

async function handlePostPrompts(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString() || '{}');
  } catch (e) {
    sendJson(res, 400, { error: `Invalid JSON: ${e.message}` });
    return;
  }
  const text = typeof body.text === 'string' ? body.text : '';
  try {
    fs.writeFileSync(PROMPTS_PATH, text);
  } catch (e) {
    sendJson(res, 500, { error: `Could not write prompts.txt: ${e.message}` });
    return;
  }
  let count = 0;
  try {
    count = loadPrompts().length;
  } catch {
    /* ignore */
  }
  sendJson(res, 200, { ok: true, count });
}

function handleGetCharacters(res) {
  const chars = loadCharacters(charactersDir()).map((c) => ({
    keyword: c.keyword,
    name: path.basename(c.file),
    url: `/characters/${encodeURIComponent(path.basename(c.file))}`,
    description: c.description || '',
    terms: c.terms || [],
  }));
  sendJson(res, 200, { characters: chars });
}

/** Path of the alias/description sidecar (.txt) for a character image name. */
function descriptionPathFor(imageName) {
  const safe = safeName(imageName);
  if (!safe || !IMG_RE.test(safe)) return null;
  return path.join(charactersDir(), safe.replace(IMG_RE, '.txt'));
}

async function handlePostCharacterDescription(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString() || '{}');
  } catch (e) {
    sendJson(res, 400, { error: `Invalid JSON: ${e.message}` });
    return;
  }
  const txtPath = descriptionPathFor(body.name || '');
  if (!txtPath) {
    sendJson(res, 400, { error: 'Bad character name.' });
    return;
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  try {
    if (text) fs.writeFileSync(txtPath, text + '\n');
    else if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath); // empty clears the alias file
  } catch (e) {
    sendJson(res, 500, { error: `Could not save aliases: ${e.message}` });
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function handlePostCharacter(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString() || '{}');
  } catch (e) {
    sendJson(res, 400, { error: `Invalid JSON: ${e.message}` });
    return;
  }
  const safe = safeName(sanitize(body.name || ''));
  if (!safe || !IMG_RE.test(safe)) {
    sendJson(res, 400, { error: 'Name must be a .png/.jpg/.jpeg/.webp/.gif file.' });
    return;
  }
  const data = String(body.dataBase64 || '').replace(/^data:[^,]*,/, '');
  if (!data) {
    sendJson(res, 400, { error: 'Missing image data.' });
    return;
  }
  try {
    fs.writeFileSync(path.join(charactersDir(), safe), Buffer.from(data, 'base64'));
  } catch (e) {
    sendJson(res, 500, { error: `Could not save image: ${e.message}` });
    return;
  }
  sendJson(res, 200, { ok: true, name: safe });
}

function handleDeleteCharacter(res, name) {
  const safe = safeName(name);
  if (!safe || !IMG_RE.test(safe)) {
    sendJson(res, 400, { error: 'Bad name' });
    return;
  }
  try {
    fs.unlinkSync(path.join(charactersDir(), safe));
    // Also remove the sibling alias/description file, if any.
    const txt = path.join(charactersDir(), safe.replace(IMG_RE, '.txt'));
    if (fs.existsSync(txt)) fs.unlinkSync(txt);
  } catch (e) {
    sendJson(res, 500, { error: `Could not delete: ${e.message}` });
    return;
  }
  sendJson(res, 200, { ok: true });
}

// --- backgrounds (same convention as characters: keyword/alias matched) ---

function handleGetBackgrounds(res) {
  const bgs = loadBackgrounds(backgroundsDir()).map((c) => ({
    keyword: c.keyword,
    name: path.basename(c.file),
    url: `/backgrounds/${encodeURIComponent(path.basename(c.file))}`,
    description: c.description || '',
    terms: c.terms || [],
  }));
  sendJson(res, 200, { backgrounds: bgs });
}

async function handlePostBackground(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString() || '{}');
  } catch (e) {
    sendJson(res, 400, { error: `Invalid JSON: ${e.message}` });
    return;
  }
  const safe = safeName(sanitize(body.name || ''));
  if (!safe || !IMG_RE.test(safe)) {
    sendJson(res, 400, { error: 'Name must be a .png/.jpg/.jpeg/.webp/.gif file.' });
    return;
  }
  const data = String(body.dataBase64 || '').replace(/^data:[^,]*,/, '');
  if (!data) {
    sendJson(res, 400, { error: 'Missing image data.' });
    return;
  }
  try {
    fs.writeFileSync(path.join(backgroundsDir(), safe), Buffer.from(data, 'base64'));
  } catch (e) {
    sendJson(res, 500, { error: `Could not save image: ${e.message}` });
    return;
  }
  sendJson(res, 200, { ok: true, name: safe });
}

async function handlePostBackgroundDescription(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString() || '{}');
  } catch (e) {
    sendJson(res, 400, { error: `Invalid JSON: ${e.message}` });
    return;
  }
  const safe = safeName(body.name || '');
  if (!safe || !IMG_RE.test(safe)) {
    sendJson(res, 400, { error: 'Bad background name.' });
    return;
  }
  const txtPath = path.join(backgroundsDir(), safe.replace(IMG_RE, '.txt'));
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  try {
    if (text) fs.writeFileSync(txtPath, text + '\n');
    else if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
  } catch (e) {
    sendJson(res, 500, { error: `Could not save aliases: ${e.message}` });
    return;
  }
  sendJson(res, 200, { ok: true });
}

function handleDeleteBackground(res, name) {
  const safe = safeName(name);
  if (!safe || !IMG_RE.test(safe)) {
    sendJson(res, 400, { error: 'Bad name' });
    return;
  }
  try {
    fs.unlinkSync(path.join(backgroundsDir(), safe));
    const txt = path.join(backgroundsDir(), safe.replace(IMG_RE, '.txt'));
    if (fs.existsSync(txt)) fs.unlinkSync(txt);
  } catch (e) {
    sendJson(res, 500, { error: `Could not delete: ${e.message}` });
    return;
  }
  sendJson(res, 200, { ok: true });
}

// --- base style image (global reference attached to every prompt) ---

function handleGetBase(res) {
  const cfg = readConfig();
  const base = loadBaseCharacter(baseDir());
  const name = base && base.file ? path.basename(base.file) : null;
  sendJson(res, 200, {
    hasImage: !!name,
    name,
    url: name ? `/base/${encodeURIComponent(name)}` : null,
    instruction: (base && base.instruction) || DEFAULT_BASE_INSTRUCTION,
    defaultInstruction: DEFAULT_BASE_INSTRUCTION,
    useBaseImage: Boolean(cfg.useBaseImage),
  });
}

async function handlePostBaseImage(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString() || '{}');
  } catch (e) {
    sendJson(res, 400, { error: `Invalid JSON: ${e.message}` });
    return;
  }
  const safe = safeName(sanitize(body.name || ''));
  if (!safe || !IMG_RE.test(safe)) {
    sendJson(res, 400, { error: 'Name must be a .png/.jpg/.jpeg/.webp/.gif file.' });
    return;
  }
  const data = String(body.dataBase64 || '').replace(/^data:[^,]*,/, '');
  if (!data) {
    sendJson(res, 400, { error: 'Missing image data.' });
    return;
  }
  const dir = baseDir();
  try {
    // Replace: only one base image at a time — remove any existing images first.
    for (const n of fs.readdirSync(dir)) {
      if (IMG_RE.test(n)) fs.unlinkSync(path.join(dir, n));
    }
    fs.writeFileSync(path.join(dir, safe), Buffer.from(data, 'base64'));
  } catch (e) {
    sendJson(res, 500, { error: `Could not save base image: ${e.message}` });
    return;
  }
  sendJson(res, 200, { ok: true, name: safe });
}

async function handlePostBaseInstruction(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString() || '{}');
  } catch (e) {
    sendJson(res, 400, { error: `Invalid JSON: ${e.message}` });
    return;
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const txtPath = path.join(baseDir(), 'instruction.txt');
  try {
    if (text) fs.writeFileSync(txtPath, text + '\n');
    else if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath); // empty → fall back to default
  } catch (e) {
    sendJson(res, 500, { error: `Could not save instruction: ${e.message}` });
    return;
  }
  sendJson(res, 200, { ok: true });
}

// --- AI plan (Claude CLI): cast + 5-6 background scenes + per-prompt characters ---

function handleGetPlan(res) {
  try {
    const md = fs.existsSync(PLAN_MD) ? fs.readFileSync(PLAN_MD, 'utf8') : '';
    sendJson(res, 200, { exists: !!md, markdown: md });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

async function handlePostPlan(res) {
  let prompts;
  try {
    prompts = loadPrompts();
  } catch (e) {
    sendJson(res, 400, { error: `Add prompts first: ${e.message}` });
    return;
  }
  const cfg = readConfig();
  if (!cfg.claudeCommand) cfg.claudeCommand = detectClaude();
  const characters = loadCharacters(charactersDir());
  try {
    const plan = await runPlan(cfg, prompts, characters);
    if (!plan) {
      sendJson(res, 200, { ok: false, error: 'Planning failed or Claude CLI not found — check the server window.' });
      return;
    }
    sendJson(res, 200, { ok: true, missing: plan.missing || [] });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

function handleGetOutput(res) {
  const dir = outputDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => IMG_RE.test(n));
  } catch {
    files = [];
  }
  const images = files
    .map((name) => {
      const full = path.join(dir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      const info = imageInfo(full);
      return {
        name,
        url: `/output/${encodeURIComponent(name)}`,
        width: info.width,
        height: info.height,
        bytes: info.bytes,
        ok: info.ok,
        mtime,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
  sendJson(res, 200, { images });
}

function handleRunStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(`event: status\ndata: ${JSON.stringify({ running: run.running })}\n\n`);
  // Replay the current buffer so a freshly-opened stream sees the whole run.
  for (const evt of run.buffer) {
    res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  }
  run.clients.add(res);
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    run.clients.delete(res);
  });
}

// ----------------------------------------------------------------------------
// router
// ----------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    sendJson(res, 400, { error: 'Bad URL' });
    return;
  }
  const { pathname } = url;
  const method = req.method;

  try {
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    // --- API ---
    if (pathname === '/api/config' && method === 'GET') return handleGetConfig(res);
    if (pathname === '/api/config' && method === 'POST') return await handlePostConfig(req, res);

    if (pathname === '/api/prompts' && method === 'GET') return handleGetPrompts(res);
    if (pathname === '/api/prompts' && method === 'POST') return await handlePostPrompts(req, res);

    if (pathname === '/api/characters' && method === 'GET') return handleGetCharacters(res);
    if (pathname === '/api/characters' && method === 'POST') return await handlePostCharacter(req, res);
    if (pathname === '/api/characters/description' && method === 'POST')
      return await handlePostCharacterDescription(req, res);
    if (pathname === '/api/characters' && method === 'DELETE')
      return handleDeleteCharacter(res, url.searchParams.get('name'));

    if (pathname === '/api/backgrounds' && method === 'GET') return handleGetBackgrounds(res);
    if (pathname === '/api/backgrounds' && method === 'POST') return await handlePostBackground(req, res);
    if (pathname === '/api/backgrounds/description' && method === 'POST')
      return await handlePostBackgroundDescription(req, res);
    if (pathname === '/api/backgrounds' && method === 'DELETE')
      return handleDeleteBackground(res, url.searchParams.get('name'));

    if (pathname === '/api/base' && method === 'GET') return handleGetBase(res);
    if (pathname === '/api/base/image' && method === 'POST') return await handlePostBaseImage(req, res);
    if (pathname === '/api/base/instruction' && method === 'POST')
      return await handlePostBaseInstruction(req, res);

    if (pathname === '/api/output' && method === 'GET') return handleGetOutput(res);

    if (pathname === '/api/plan' && method === 'GET') return handleGetPlan(res);
    if (pathname === '/api/plan' && method === 'POST') return await handlePostPlan(res);

    if (pathname === '/api/run' && method === 'POST') {
      const r = startRun();
      return sendJson(res, r.ok ? 200 : 409, r);
    }
    if (pathname === '/api/run/stop' && method === 'POST') {
      const r = stopRun();
      return sendJson(res, r.ok ? 200 : 409, r);
    }
    if (pathname === '/api/run/stream' && method === 'GET') return handleRunStream(req, res);

    // --- static image dirs ---
    if (pathname.startsWith('/characters/') && method === 'GET')
      return serveFromDir(res, charactersDir(), decodeURIComponent(pathname.slice('/characters/'.length)));
    if (pathname.startsWith('/backgrounds/') && method === 'GET')
      return serveFromDir(res, backgroundsDir(), decodeURIComponent(pathname.slice('/backgrounds/'.length)));
    if (pathname.startsWith('/output/') && method === 'GET')
      return serveFromDir(res, outputDir(), decodeURIComponent(pathname.slice('/output/'.length)));
    if (pathname.startsWith('/base/') && method === 'GET')
      return serveFromDir(res, baseDir(), decodeURIComponent(pathname.slice('/base/'.length)));

    // --- UI ---
    if ((pathname === '/' || pathname === '/index.html') && method === 'GET')
      return serveFile(res, path.join(UI_DIR, 'index.html'));
    if (pathname.startsWith('/ui/') && method === 'GET') {
      const safe = safeName(path.basename(pathname));
      if (safe) return serveFile(res, path.join(UI_DIR, safe));
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

function openBrowser(targetUrl) {
  try {
    if (process.platform === 'win32') {
      // `start` is a cmd builtin; the empty "" is the window title arg.
      spawn('cmd', ['/c', 'start', '', targetUrl], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [targetUrl], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [targetUrl], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* user can open the URL manually */
  }
}

const PORT = Number(readConfig().uiPort) || DEFAULTS.uiPort;
server.listen(PORT, '127.0.0.1', () => {
  const target = `http://127.0.0.1:${PORT}`;
  console.log(`\nHiggsfield UI running at ${target}`);
  console.log('Leave this window open. Close it (or Ctrl+C) to stop the UI.\n');
  openBrowser(target);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. The UI may already be open, or set a different "uiPort" in config.json.`);
  } else {
    console.error(`\nServer error: ${err.message}`);
  }
  process.exit(1);
});

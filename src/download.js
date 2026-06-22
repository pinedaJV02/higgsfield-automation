'use strict';

const fs = require('fs');
const path = require('path');

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Strip characters that are illegal in Windows filenames.
 */
function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'image';
}

/**
 * Pick a file extension from a content-type header, falling back to the URL,
 * then to .png.
 */
function pickExtension(contentType, url) {
  if (contentType) {
    const ct = contentType.split(';')[0].trim().toLowerCase();
    if (EXT_BY_MIME[ct]) return EXT_BY_MIME[ct];
  }
  const m = /\.(png|jpe?g|webp|gif)(?:\?|$)/i.exec(url || '');
  if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
  return '.png';
}

/**
 * Build the final output file path, adding an index suffix when more than one
 * image is being saved. Avoids overwriting by appending (1), (2)... if needed.
 */
function resolveOutputPath(outputDir, baseName, index, total) {
  const safe = sanitize(baseName);
  // suffix is added later once we know the extension
  return { dir: outputDir, base: total > 1 ? `${safe}-${index + 1}` : safe };
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

/**
 * Download an image URL using the page's request context (so authentication
 * cookies are sent) and write it to disk.
 *
 * @param {import('playwright').Page} page
 * @param {string} url        The full-resolution image URL.
 * @param {object} opts       { outputDir, baseName, index, total }
 * @returns {Promise<string>} The path of the saved file.
 */
async function downloadImage(page, url, opts) {
  const { outputDir, baseName, index = 0, total = 1 } = opts;

  const resp = await page.request.get(url);
  if (!resp.ok()) {
    throw new Error(`Failed to download image (${resp.status()} ${resp.statusText()}): ${url}`);
  }
  const body = await resp.body();
  const ext = pickExtension(resp.headers()['content-type'], url);

  const { dir, base } = resolveOutputPath(outputDir, baseName, index, total);
  const finalPath = uniquePath(dir, base, ext);
  fs.writeFileSync(finalPath, body);
  return finalPath;
}

/**
 * Save image bytes captured from a Playwright download event.
 */
async function saveDownload(download, opts) {
  const { outputDir, baseName, index = 0, total = 1 } = opts;
  const suggested = download.suggestedFilename() || '';
  const ext = pickExtension(null, suggested) || '.png';
  const { dir, base } = resolveOutputPath(outputDir, baseName, index, total);
  const finalPath = uniquePath(dir, base, ext);
  await download.saveAs(finalPath);
  return finalPath;
}

module.exports = { downloadImage, saveDownload, sanitize };

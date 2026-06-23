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

/**
 * Read basic info from a saved image file for the file-level fulfillment check:
 * whether it's a readable PNG/JPEG/WEBP, its pixel dimensions, and byte size.
 * @returns {{ ok: boolean, bytes: number, width: number, height: number }}
 */
function imageInfo(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const bytes = buf.length;
    let width = 0;
    let height = 0;
    if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    } else if (buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2;
      while (o < buf.length) {
        if (buf[o] !== 0xff) break;
        const marker = buf[o + 1];
        const len = buf.readUInt16BE(o + 2);
        if (marker >= 0xc0 && marker <= 0xc3) {
          height = buf.readUInt16BE(o + 5);
          width = buf.readUInt16BE(o + 7);
          break;
        }
        o += 2 + len;
      }
    } else if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8X') {
        width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      } else if (fmt === 'VP8 ') {
        width = buf.readUInt16LE(26) & 0x3fff;
        height = buf.readUInt16LE(28) & 0x3fff;
      } else if (fmt === 'VP8L') {
        const b = buf.readUInt32LE(21);
        width = 1 + (b & 0x3fff);
        height = 1 + ((b >> 14) & 0x3fff);
      }
    }
    return { ok: width > 0 && height > 0, bytes, width, height };
  } catch {
    return { ok: false, bytes: 0, width: 0, height: 0 };
  }
}

module.exports = { downloadImage, saveDownload, sanitize, imageInfo };

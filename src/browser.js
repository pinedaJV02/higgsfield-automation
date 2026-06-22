'use strict';

const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

/**
 * Launch a NORMAL Chrome process (not via Playwright's automation launcher) with
 * a remote-debugging port, then attach Playwright to it over CDP.
 *
 * Why: Google blocks sign-in on automation-controlled Chromium. A plainly-launched
 * Chrome reports `navigator.webdriver === false` and shows no "automation" banner,
 * so Google accepts the login. Playwright simply *attaches* to drive it.
 *
 * @param {object} cfg  Needs { chromePath, chromePort, chromeProfileDir }.
 * @returns {Promise<{ browser, context, page, chromeProc }>}
 */
async function launchAndConnect(cfg) {
  const { chromePath, chromePort, chromeProfileDir } = cfg;

  // If a debuggable Chrome is already up on this port, just attach to it.
  if (!(await isEndpointReady(chromePort))) {
    console.log(`  • launching Chrome (${chromePath})`);
    const args = [
      `--remote-debugging-port=${chromePort}`,
      `--user-data-dir=${chromeProfileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
    ];
    const proc = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
    proc.on('error', (e) => console.error(`Chrome spawn error: ${e.message}`));
    proc.unref(); // let Chrome outlive this Node process (keeps session warm)
    cfg._chromeProc = proc;

    await waitForEndpoint(chromePort, 30000);
  } else {
    console.log(`  • attaching to Chrome already running on port ${chromePort}`);
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chromePort}`);
  const context = browser.contexts()[0] || (await browser.newContext());
  context.setDefaultTimeout(30000);
  const page = context.pages()[0] || (await context.newPage());

  return { browser, context, page, chromeProc: cfg._chromeProc };
}

/** Resolve true if the CDP /json/version endpoint responds. */
function isEndpointReady(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: 1000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Poll the CDP endpoint until it is ready or we time out. */
async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isEndpointReady(port)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome did not expose its debugging port (${port}) in time.`);
}

module.exports = { launchAndConnect };

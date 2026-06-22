'use strict';
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('higgsfield')) || ctx.pages()[0];
  await page.goto('https://higgsfield.ai/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.bringToFront().catch(() => {});
  console.log('Navigated automation Chrome to higgsfield.ai and brought it to front.');
  console.log('Log in there with Google (pinedajv02@gmail.com).');
  await b.close().catch(() => {});
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});

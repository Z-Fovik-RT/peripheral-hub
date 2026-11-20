'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.HUB_PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  if (!process.argv[2]) throw Error('Pass a screenshot output directory.');
  const output = path.resolve(process.argv[2]);
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1380, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
    await page.addInitScript(() => {
      const snapshot = () => ({ scannedAt: new Date().toISOString(), devices: [
        { id: 'aula-f87-pro', connected: true, connection: '无线' },
        { id: 'inphic-in9', connected: true, connection: '无线' },
        { id: 'ikf-v11-pro-71', connected: true, connection: 'USB' }
      ], audio: [], warnings: [] });
      window.hub = {
        snapshot: async () => snapshot(), refresh: async () => snapshot(),
        getInfo: async () => ({ version: '0.6.1-preview', mode: '示例', source: '演示数据' }),
        readDevice: async ({ id }) => ({ id, source: 'hardware', warnings: [], canRestore: false,
          capabilities: { writable: ['brightness','activeMode','speed','colorIndex','sleepCode','debounce'] },
          settings: { brightness: 3, modeRaw: 2, modeName: '呼吸', speed: 2, colorIndex: 3,
            sleepCode: 10, sleepSeconds: 300, debounce: 1, signatureValid: true,
            supportedModes: [{ id: 1, name: '常亮', hasSpeed: false, hasColor: true },
                             { id: 2, name: '呼吸', hasSpeed: true, hasColor: true }] } }),
        features: { invoke: async () => ({ ok: true, data: { colors: [], enabled: false, rules: [] } }) }
      };
    });
    await page.goto(pathToFileURL(path.join(__dirname, '../custom-app/renderer/index.html')).href);
    await page.locator('[data-device="aula-f87-pro"]').waitFor();
    assert.match(await page.title(), /外设中心/);
    await page.screenshot({ path: path.join(output, 'overview.png') });
    await page.locator('#open-settings').click();
    await page.locator('[data-page-tab="lighting"]').click();
    await page.locator('#read-device').click();
    await page.waitForFunction(() => document.querySelector('#brightness-output').textContent === '3');
    await page.screenshot({ path: path.join(output, 'keyboard.png') });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

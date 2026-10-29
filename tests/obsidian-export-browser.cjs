// NODE_PATH points to the bundled Playwright installation.
const { chromium } = require('playwright');
const { expect } = require('playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const server = spawn(process.execPath, ['--input-type=module', '-e',
  "import {createServer} from 'vite'; const s = await createServer({server:{port:5188,strictPort:true,watch:null}}); await s.listen();"],
{ cwd: root, windowsHide: true, stdio: 'ignore' });
(async () => {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    for (let attempt = 0; ; attempt++) {
      try { await page.goto('http://127.0.0.1:5188'); break; }
      catch (e) { if (attempt > 30) throw e; await new Promise(r => setTimeout(r, 100)); }
    }
    await page.waitForFunction(() => !!window.__tauriview);
    await expect(page.locator('#annExport')).toBeHidden();
    await page.locator('#railNotes').click();
    const button = page.getByRole('button', { name: '导出批注到 Obsidian', exact: true });
    await expect(button).toBeVisible();
    const title = await page.locator('#viewTitle').boundingBox();
    const bounds = await button.boundingBox();
    assert(bounds.x > 1100 && Math.abs(bounds.y - title.y) < 15, 'export icon belongs at the top right');
    assert.equal(await button.getAttribute('title'), null, 'use the styled tooltip, not the native tooltip');
    await button.hover();
    await expect(page.locator('#annExportTip')).toBeVisible();
    await expect(page.locator('#annExportTip')).toContainText('保存当前筛选到 Obsidian');
    const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tauriview-export-ui-'));
    await page.screenshot({ path: path.join(screenshotDir, 'annotations.png') });
    await button.click();
    await expect(page.locator('#annExportStatus')).toBeVisible();
    await expect(page.locator('#annExportStatusTitle')).toHaveText('导出未完成');
    await expect(page.locator('#annExportStatusText')).toContainText('当前筛选下没有可导出的批注');
    await expect(button).toBeEnabled();
    await page.locator('#annExportSettings').click();
    await expect(page.locator('.sp-pane[data-pane="export"]')).toBeVisible();
    const input = page.getByLabel('Obsidian 仓库文件夹', { exact: true });
    await expect(input).toHaveValue('C:\\Users\\spark\\Reading');
    await input.fill('relative');
    await page.locator('#setObsidianSave').click();
    await expect(page.locator('#setObsidianStatus')).toContainText('完整的文件夹路径');
    await input.fill('D:\\My Reading Vault');
    await page.locator('#setObsidianSave').click();
    await expect(page.locator('#setObsidianStatus')).toContainText('已保存');
    await page.screenshot({ path: path.join(screenshotDir, 'settings.png') });
    await page.reload();
    await page.waitForFunction(() => !!window.__tauriview);
    await page.locator('#railSettings').click();
    await page.locator('.sn-item[data-pane="export"]').click();
    await expect(input).toHaveValue('D:\\My Reading Vault');
    await page.locator('#railNotes').click();
    await expect(page.locator('#topbar')).toBeVisible();
    await expect(page.locator('#viewTitle')).toHaveText('批注');
    await expect(button).toBeVisible();
    const restored = await button.boundingBox();
    const toolbar = await page.locator('.ann-toolbar').boundingBox();
    assert(restored.x > 1100 && restored.y < toolbar.y, 'settings → annotations restores header and export action');
    await page.locator('#railBooks').click();
    await expect(button).toBeHidden();
    assert.deepEqual(errors, []);
    console.log('Passed: export button, styled tooltip, inline feedback, settings validation, persistence and navigation. Screenshots: ' + screenshotDir);
  } finally { await browser?.close(); server.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

// Run with NODE_PATH pointing at the bundled Playwright installation.
const { chromium } = require("playwright");
const { expect } = require("playwright/test");
const { spawn } = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const JSZip = require("jszip");
const root = path.resolve(__dirname, "..");
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'tauriview-annotations-'));
const server = spawn(process.execPath, ["--input-type=module", "-e", "import {createServer} from 'vite'; const s = await createServer({server:{port:5187,strictPort:true,watch:null}}); await s.listen();"], {
  cwd: root, windowsHide: true, stdio: "ignore",
});

async function chineseBook() {
  // Synthetic text with a publisher font: the reader's later font override must
  // also move existing annotation rectangles when this chapter is re-created.
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">annotation-reflow-test</dc:identifier><dc:title>中文批注排版测试</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>');
  zip.file('nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>目录</title></head><body><nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="one.xhtml">第一章</a></li><li><a href="two.xhtml">第二章</a></li></ol></nav></body></html>');
  const text = '阅读时可以记录自己的想法，再回到原文核对。不同字体会改变换行与段落的位置，批注应该始终贴合对应文字。';
  for (const [file, title] of [['one.xhtml', '第一章'], ['two.xhtml', '第二章']]) {
    zip.file(file, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><style>body { font-family: SimSun; } h2 { margin: 2em 0; } p { text-indent: 2em; }</style></head><body><h2>${title}</h2>${Array.from({ length: 7 }, (_, i) => `<p id="p${i}">${text.repeat(i === 5 ? 1 : 3)}</p>`).join('')}</body></html>`);
  }
  return { name: '中文批注排版测试.epub', mimeType: 'application/epub+zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) };
}
(async () => {
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    const errors = [];
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    page.on("pageerror", (error) => errors.push(error.message));
    for (let attempt = 0; ; attempt++) {
      try { await page.goto("http://127.0.0.1:5187"); break; }
      catch (error) { if (attempt >= 30) throw error; await new Promise((r) => setTimeout(r, 100)); }
    }
    await page.waitForFunction(() => !!window.__tauriview);
    await page.locator("#filePicker").setInputFiles(path.join(root, "tests/fixtures/sherlock.epub"));
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#viewer iframe")).some((f) => f.contentDocument?.body?.textContent.trim().length > 10));
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#viewer iframe")).some((f) => f.getBoundingClientRect().width > 100));
    await page.waitForTimeout(800);
    await page.locator('#tocBtn').click();
    await page.locator('#tocList .toc-label').filter({ hasText: /scandal/i }).first().click();
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const frame = Array.from(document.querySelectorAll("#viewer iframe")).find((f) => f.contentDocument?.body?.textContent.trim().length > 10);
      const doc = frame.contentDocument;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.trim().length < 80) continue;
        const probe = doc.createRange(); probe.selectNodeContents(node);
        const r = probe.getBoundingClientRect();
        if (r.width > 0 && r.right > 0 && r.left < frame.clientWidth && r.bottom > 0 && r.top < frame.clientHeight) break;
      }
      if (!node) throw new Error("No visible text to annotate");
      const range = doc.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(node.textContent.length, 120));
      const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      doc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      document.getElementById("hlNote").click();
      sel.removeAllRanges();
    });
    await expect(page.locator('.tv-note-marker')).toHaveCount(0);
    const markdownNote = "**我的批注**\n第二行 <b>保持纯文本</b>\n\n- **重点一**\n- 重点二\n\n1. 第一步\n2. 第二步\n\n" + "较长的备注内容。".repeat(100);
    await page.locator("#noteInput").fill(markdownNote);
    await page.locator("#noteSave").click();
    await page.waitForSelector(".tv-highlight rect", { state: "attached" });
    await expect(page.locator('.tv-note-marker')).toHaveCount(1);
    const original = await page.evaluate(async () => {
      const storage = await import('/src/storage.ts');
      const book = storage.listBooks()[0];
      return { bookId: book.id, highlight: (await storage.loadAnnotations(book.id))[0] };
    });
    assert.equal(original.highlight.note, markdownNote);
    await page.evaluate(async () => (await import('/src/annotations-ui.ts')).annOpen());
    await expect(page.locator('#annList .mark-note strong').first()).toHaveText('我的批注');
    await expect(page.locator('#annList .mark-note ul > li')).toHaveCount(2);
    await expect(page.locator('#annList .mark-note ol > li')).toHaveCount(2);
    await page.locator('#annClose').click();
    const alignment = (cfi = original.highlight.cfi) => page.evaluate(async cfi => {
      const { EpubCFI } = await import('/node_modules/.vite/deps/epubjs.js');
      const frame = Array.from(document.querySelectorAll('#viewer iframe')).find(f => f.contentDocument?.body?.textContent.trim().length > 10);
      const expected = Array.from(new EpubCFI(cfi).toRange(frame.contentDocument).getClientRects()).filter(r => r.width > 0 && r.height > 0);
      const offset = frame.getBoundingClientRect();
      const actual = Array.from(document.querySelectorAll('.tv-highlight rect')).map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
      if (expected.length !== actual.length) return { drift: 10000, expected: expected.length, actual: actual.length };
      return { drift: Math.max(0, ...actual.flatMap((r, i) => [Math.abs(r.left - offset.left - expected[i].left), Math.abs(r.top - offset.top - expected[i].top), Math.abs(r.width - expected[i].width), Math.abs(r.height - expected[i].height)])) };
    }, cfi);
    console.log('Highlight baseline:', await alignment());
    for (let cycle = 0; cycle < 4; cycle++) {
      const before = await page.locator('#footLeft').textContent();
      await page.mouse.move(1100, 550);
      await page.mouse.wheel(0, 600); await page.waitForTimeout(430);
      const afterNext = await page.locator('#footLeft').textContent();
      assert.notEqual(afterNext, before, 'wheel must actually advance a page');
      const forward = await alignment();
      console.log('Forward alignment:', forward);
      if (forward.drift >= 2) await page.screenshot({ path: path.join(output, 'forward-drift.png') });
      assert.ok(forward.drift < 2, `Highlight drift on forward page: ${forward.drift}px`);
      await page.mouse.wheel(0, -600); await page.waitForTimeout(430);
      const result = await alignment();
      console.log('Wheel cycle', cycle + 1, { before, afterNext, afterBack: await page.locator('#footLeft').textContent(), ...result });
      if (result.drift >= 2) await page.screenshot({ path: path.join(output, 'wheel-drift.png') });
      assert.ok(result.drift < 2, `Highlight drift after wheel pagination: ${result.drift}px`);
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.mouse.move(1100, 550);
      await page.mouse.wheel(0, -600); await page.waitForTimeout(550);
      await page.mouse.wheel(0, 600); await page.waitForTimeout(550);
      const result = await alignment();
      console.log('Chapter boundary cycle', cycle + 1, result);
      if (result.drift >= 2) await page.screenshot({ path: path.join(output, 'chapter-drift.png') });
      assert.ok(result.drift < 2, `Highlight drift after chapter re-entry: ${result.drift}px`);
    }
    const rects = await page.locator(".tv-highlight rect").evaluateAll((nodes) => nodes.map((n) => {
      const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    }).filter((r) => r.width > 0 && r.x >= 0 && r.x < innerWidth && r.y > 0 && r.y < innerHeight));
    assert.ok(rects.length, "A visible highlight must be painted");
    const hover = async (r) => page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await hover(rects[0]);
    await page.waitForTimeout(100);
    await expect(page.locator("#notePreview")).toBeHidden();
    await expect(page.locator("#notePreview")).toBeVisible();
    await expect(page.locator("#notePreviewText")).toContainText("<b>保持纯文本</b>");
    await expect(page.locator('#notePreviewText strong').first()).toHaveText('我的批注');
    await expect(page.locator('#notePreviewText ul > li')).toHaveCount(2);
    await expect(page.locator('#notePreviewText ol > li')).toHaveCount(2);
    assert.equal(await page.locator("#notePreviewText b").count(), 0);
    for (const r of rects) { await hover(r); await expect(page.locator("#notePreview")).toBeVisible(); }
    await page.locator("#notePreviewText").hover();
    await page.waitForTimeout(350);
    await expect(page.locator("#notePreview")).toBeVisible();
    await page.locator("#notePreviewText").evaluate((el) => { el.scrollTop = 80; });
    await expect(page.locator("#notePreview")).toBeVisible();
    await page.locator("#notePreviewEdit").click();
    await expect(page.locator("#noteBox")).toBeVisible();
    await expect(page.locator("#notePreview")).toBeHidden();
    await expect(page.locator('#noteInput')).toHaveValue(markdownNote);
    await page.locator("#noteInput").fill("修改后的备注");
    await page.locator("#noteSave").click();
    await hover(rects[0]);
    await expect(page.locator("#notePreviewText")).toHaveText("修改后的备注");
    await page.keyboard.press("Escape");
    await expect(page.locator("#notePreview")).toBeHidden();
    await page.mouse.move(10, 10); await hover(rects[0]);
    await expect(page.locator("#notePreview")).toBeVisible();
    await page.locator('#next').click();
    await expect(page.locator("#notePreview")).toBeHidden();
    await page.locator('#prev').click();
    await page.waitForTimeout(500);
    await page.mouse.move(10, 10); await hover(rects[0]);
    await expect(page.locator("#notePreview")).toBeVisible();

    // Palette changes must reach the preview, editor and buttons; markers track the
    // final line without modifying the persisted source anchor or text.
    const backgrounds = [];
    for (const theme of ['light', 'sepia', 'dark']) {
      await page.mouse.move(10, 10);
      await page.locator('#readerSettings').click();
      await page.locator(`.theme-dot[data-theme="${theme}"]`).click();
      if (await page.locator('#settingsPop').isVisible()) await page.locator('#readerSettings').click();
      await page.evaluate(({ bookId, cfi }) => window.__tauriview.openBook(bookId, cfi), { bookId: original.bookId, cfi: original.highlight.cfi });
      await expect(page.locator('.tv-note-marker')).toHaveCount(1);
      await page.locator('.tv-note-marker').hover();
      await expect(page.locator('#notePreview')).toBeVisible();
      const colors = await page.evaluate(() => {
        const card = getComputedStyle(document.getElementById('notePreview'));
        const button = getComputedStyle(document.getElementById('notePreviewEdit'));
        const rgb = text => text.match(/[\d.]+/g).slice(0, 3).map(Number);
        const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const ratio = (fg, bg) => { const a = luminance(rgb(fg)), b = luminance(rgb(bg)); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
        return { bg: card.backgroundColor, fg: card.color, contrast: ratio(card.color, card.backgroundColor), buttonColor: button.color };
      });
      backgrounds.push(colors.bg); assert.ok(colors.contrast >= 4.5, `${theme}: preview text contrast`);
      assert.equal(colors.buttonColor, colors.fg);
      await page.locator('#notePreview').screenshot({ path: path.join(output, `preview-${theme}.png`) });
      await page.locator('.tv-note-marker').click();
      await expect(page.locator('#noteBox')).toBeVisible();
      assert.equal(await page.locator('#noteBox').evaluate(el => getComputedStyle(el).backgroundColor), colors.bg);
      assert.equal(await page.locator('#noteInput').evaluate(el => getComputedStyle(el).color), colors.fg);
      await page.locator('#noteBox').screenshot({ path: path.join(output, `editor-${theme}.png`) });
      await page.locator('#noteCancel').click();
    }
    assert.equal(new Set(backgrounds).size, 3);
    await page.setViewportSize({ width: 980, height: 840 });
    await expect.poll(async () => page.evaluate(() => {
      const marker = document.querySelector('.tv-note-marker')?.getBoundingClientRect();
      const lines = [...document.querySelectorAll('.tv-highlight rect')].map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
      const end = lines.at(-1);
      return !!marker && !!end && Math.abs(marker.left - end.right - 1) < 3 && Math.abs(marker.top - end.top + 12) < 3;
    })).toBe(true);
    await page.locator('.tv-note-marker').click();
    await page.locator('#noteInput').fill('   ');
    await page.locator('#noteSave').click();
    await expect(page.locator('.tv-note-marker')).toHaveCount(0);
    await expect(page.locator('.tv-highlight')).toHaveCount(1);
    const line = await page.locator('.tv-highlight rect').first().boundingBox();
    await page.mouse.click(line.x + line.width / 2, line.y + line.height / 2);
    await expect(page.locator('#noteBox')).toBeVisible();
    await page.locator('#noteInput').fill('重新补充批注');
    await page.locator('#noteSave').click();
    await expect(page.locator('.tv-note-marker')).toHaveCount(1);
    const restored = await page.evaluate(async bookId => (await (await import('/src/storage.ts')).loadAnnotations(bookId))[0], original.bookId);
    assert.equal(restored.cfi, original.highlight.cfi); assert.equal(restored.text, original.highlight.text);
    await page.locator('.tv-note-marker').click();
    await page.locator('#noteDelete').click();
    await expect(page.locator('.tv-note-marker')).toHaveCount(0);
    await expect(page.locator('.tv-highlight')).toHaveCount(0);
    await page.evaluate(() => window.__tauriview.showLibrary());
    await expect(page.locator("#notePreview")).toBeHidden();

    // Exercise a Chinese chapter with publisher typography, without depending on
    // any private book. Cross-chapter navigation destroys and reattaches marks.
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.evaluate(() => localStorage.setItem('tauriview.typography', JSON.stringify({ fontSize: 110, font: 'system', theme: 'light', lineHeight: 1.7 })));
    await page.reload();
    await page.waitForFunction(() => !!window.__tauriview);
    await page.locator('#filePicker').setInputFiles(await chineseBook());
    await page.waitForFunction(() => window.__tauriview.listBooks().some(b => b.title === '中文批注排版测试'));
    const id = await page.evaluate(() => window.__tauriview.listBooks().find(b => b.title === '中文批注排版测试').id);
    await page.evaluate(id => window.__tauriview.openBook(id, 'two.xhtml'), id);
    await page.waitForFunction(() => [...document.querySelectorAll('#viewer iframe')].some(f => f.contentDocument?.title === '第二章'));
    const chinese = await page.evaluate(async id => {
      const { EpubCFI } = await import('/node_modules/.vite/deps/epubjs.js');
      const doc = [...document.querySelectorAll('#viewer iframe')].find(f => f.contentDocument?.title === '第二章').contentDocument;
      const range = doc.createRange(); range.selectNodeContents(doc.getElementById('p1'));
      const note = { id: 'reflow-note', cfi: new EpubCFI(range, '/6/4').toString(), text: range.toString(), color: '1', note: '跨章节批注', createdAt: Date.now(), updatedAt: Date.now() };
      await (await import('/src/storage.ts')).saveAnnotations(id, [note]);
      await window.__tauriview.openBook(id, note.cfi);
      return note;
    }, id);
    await expect.poll(async () => (await alignment(chinese.cfi)).drift).toBeLessThan(2);
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.mouse.move(1100, 550);
      await page.mouse.wheel(0, -600); await page.waitForTimeout(550);
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('#viewer iframe')].some(f => f.contentDocument?.title === '第二章')), false, 'wheel must leave the annotated chapter');
      await page.mouse.wheel(0, 600); await page.waitForTimeout(550);
      await expect.poll(async () => (await alignment(chinese.cfi)).drift).toBeLessThan(2);
      await expect(page.locator('.tv-note-marker')).toHaveCount(1);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, checks: 'hover, editing, three theme palettes, marker creation/clearing/deletion, reflow and stable CFIs', output }));
  } finally {
    await browser?.close(); server.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

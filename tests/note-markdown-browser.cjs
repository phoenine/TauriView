// Run with NODE_PATH pointing at the bundled Playwright installation.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="note"></div>');
    const source = fs.readFileSync(path.join(__dirname, "../src/note-markdown.ts"), "utf8");
    await page.addScriptTag({ content: ts.transpileModule(source.replace("export function", "function"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText });
    const result = await page.evaluate(() => {
      const el = document.getElementById("note");
      renderNoteMarkdown(el, '**重点** 与 __加粗__、*斜体*、`**代码**`\r\n下一行\r\n\r\n- **条目一**\r\n+ 条目二\r\n* 条目三\r\n\r\n3. 第三项\r\n4) 第四项');
      return {
        bold: [...el.querySelectorAll('strong')].map(n => n.textContent),
        italic: el.querySelector('em').textContent,
        code: el.querySelector('code').textContent,
        breaks: el.querySelectorAll('br').length,
        bullets: el.querySelectorAll('ul > li').length,
        ordered: el.querySelectorAll('ol > li').length,
        start: el.querySelector('ol').start,
      };
    });
    assert.deepEqual(result, { bold: ['重点', '加粗', '条目一'], italic: '斜体', code: '**代码**', breaks: 1, bullets: 3, ordered: 2, start: 3 });
    const safety = await page.evaluate(() => {
      const el = document.getElementById('note');
      const text = '<img src=x onerror="window.injected=true">\n<script>window.injected=true</script>\n[jump](javascript:alert(1))\n\\*literal\\* 与 **未闭合';
      renderNoteMarkdown(el, text);
      return { tags: el.querySelectorAll('img,script,a').length, injected: !!window.injected, text: el.textContent, bold: el.querySelectorAll('strong').length };
    });
    assert.equal(safety.tags, 0);
    assert.equal(safety.injected, false);
    assert.equal(safety.bold, 0);
    assert.ok(safety.text.includes('*literal* 与 **未闭合'));
    await page.evaluate(() => renderNoteMarkdown(document.getElementById('note'), '普通笔记\n保留换行'));
    assert.equal(await page.locator('#note').innerText(), '普通笔记\n保留换行');
    await page.evaluate(() => renderNoteMarkdown(document.getElementById('note'), ''));
    assert.equal(await page.locator('#note').textContent(), '');
    console.log('Passed: note Markdown formatting, line breaks, list numbering, plain text, escaping and HTML safety.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

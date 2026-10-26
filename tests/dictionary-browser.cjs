const { chromium, expect } = require("playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), output = fs.mkdtempSync(path.join(os.tmpdir(), "tauriview-dictionary-"));
const server = spawn(process.execPath, ["--input-type=module", "-e", "import {createServer} from 'vite'; const s=await createServer({server:{port:5185,strictPort:true,watch:null}}); await s.listen();"], { cwd: root, windowsHide: true, stdio: "ignore" });
(async () => {
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(30000);
    const errors = [], external = [], aiRequests = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith("http://127.0.0.1:5185")) external.push(request.url()); });
    await page.route("https://ai.example/**", async (route) => {
      aiRequests.push(route.request().postDataJSON());
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: "结合原文的解释。" } }] }) });
    });
    for (let i = 0; ; i++) { try { await page.goto("http://127.0.0.1:5185"); break; } catch (error) { if (i > 20) throw error; await new Promise((r) => setTimeout(r, 100)); } }
    await page.waitForFunction(() => !!window.__tauriview);
    await page.locator("#filePicker").setInputFiles(path.join(root, "tests/fixtures/sherlock.epub"));
    await page.waitForFunction(() => document.querySelector("#viewer iframe")?.contentDocument?.body?.textContent.trim().length > 10);
    const cfi = await page.evaluate(async () => {
      const { EpubCFI } = await import("/node_modules/.vite/deps/epubjs.js");
      const doc = document.querySelector("#viewer iframe").contentDocument;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) if (node.textContent.trim().length > 10) break;
      const range = doc.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(node.length, 10));
      return new EpubCFI(range, "/6/2").toString();
    });
    async function lookup(word) {
      await page.evaluate(async ({ word, cfi }) => {
        const { annOnSelect } = await import("/src/annotations-ui.ts");
        annOnSelect({ cfi, text: word, passage: { before: "正在读的原文。" }, rect: { left: 500, top: 200, width: 60, height: 20 } });
        document.getElementById("hlDictionary").click();
      }, { word, cfi });
      await expect(page.locator("#dictionaryBody")).not.toHaveText("正在查词…", { timeout: 60000 });
      await expect(page.locator("#dictionaryBody")).not.toContainText("查词失败");
    }
    await lookup("银行");
    await expect(page.locator("#dictionaryPronunciation")).toContainText("háng");
    await expect(page.locator("#dictionaryBody")).toContainText("金融");
    await page.locator("#dictionaryBox").screenshot({ path: path.join(output, "chinese.png") });
    await page.evaluate(async () => {
      const { annOnSelect } = await import("/src/annotations-ui.ts");
      annOnSelect({ cfi: "different", text: "别的词", rect: { left: 20, top: 20, width: 10, height: 10 } });
    });
    await page.locator("#dictionarySave").click();
    await expect(page.locator("#dictionarySave")).toHaveText("已补充");
    const saved = await page.evaluate(async () => {
      const { listBooks, loadAnnotations } = await import("/src/storage.ts"); return loadAnnotations(listBooks()[0].id);
    });
    assert.equal(saved[0].text, "银行"); assert.equal(saved[0].cfi, cfi);
    assert.match(saved[0].dictionary.pronunciation, /háng/);
    assert.match(saved[0].note, /来源/);
    // Once the local packs are loaded the browser backend also works without the server.
    await page.context().setOffline(true);
    await lookup("画蛇添足");
    await expect(page.locator("#dictionaryAttribution")).toContainText("成语词典");
    await expect(page.locator("#dictionaryPronunciation")).toContainText("huà shé tiān zú");
    await page.locator("#dictionaryBox").screenshot({ path: path.join(output, "idiom.png") });
    await expect(page.locator('#dictionaryDetails')).toBeHidden();
    await expect(page.locator('#dictionaryBody')).not.toContainText('【出处】');
    await expect(page.locator('#dictionaryBody')).not.toContainText('【示例】');
    await lookup("went");
    await expect(page.locator("#dictionarySource option").first()).toContainText("· go ·");
    await page.locator("#dictionaryBox").screenshot({ path: path.join(output, "english.png") });
    await lookup("今天下午");
    await expect(page.locator("#dictionaryAttribution")).not.toContainText("成语词典");
    await lookup("zzzz-unlisted-word");
    await expect(page.locator("#dictionaryBody")).toContainText("未收录");
    assert.equal(external.length, 0, "dictionary lookup must never make external requests");
    await page.context().setOffline(false);
    await lookup("银行");
    await page.locator("#dictionarySettings").click();
    await expect(page.locator('#settingsView .sp-pane[data-pane="dictionary"]')).toBeVisible();
    await expect(page.locator("#dictionaryPacks .sp-row")).toHaveCount(3);
    await expect(page.locator("#dictionaryPacks")).toContainText(/现代汉语词典|汉语词典/);
    await expect(page.locator("#dictionaryPacks")).toContainText("成语词典");
    await expect(page.locator("#dictionaryPacks")).not.toContainText("教育部");
    const toggle = page.locator('#dictionaryPacks button[aria-label="停用ECDICT 常用英汉词典"]');
    await toggle.click();
    await expect(page.locator('#dictionaryPacks button[aria-label="启用ECDICT 常用英汉词典"]')).toBeVisible();
    const disabled = await page.evaluate(async () => (await (await import("/src/dictionary/client.ts")).lookupDictionary("hello")).some((entry) => entry.dictionaryId === "ecdict-core"));
    assert.equal(disabled, false);
    await page.locator('#dictionaryPacks button[aria-label="启用ECDICT 常用英汉词典"]').click();
    // Import an ordinary HTML StarDict; active content must remain inert.
    const data = Buffer.from('IPA\0<div>Custom definition.</div><script>window.dictionaryInjected=true</script><img src="https://invalid.example/tracker"><a href="javascript:alert(1)">safe text</a>');
    const numbers = Buffer.alloc(8); numbers.writeUInt32BE(data.length, 4);
    const index = Buffer.concat([Buffer.from("tauriview\0"), numbers]);
    const ifo = `StarDict's dict ifo file\nversion=2.4.2\nbookname=Imported Test\nwordcount=1\nidxfilesize=${index.length}\nsametypesequence=th\n`;
    const files = [["custom.ifo", ifo], ["custom.idx", index], ["custom.dict", data]].map(([name, bytes]) => { const file = path.join(output, name); fs.writeFileSync(file, bytes); return file; });
    await page.locator("#dictionaryFiles").setInputFiles(files);
    await expect(page.locator("#dictionaryPacks .sp-row")).toHaveCount(4);
    await page.evaluate(async () => { const { listBooks } = await import("/src/storage.ts"); await window.__tauriview.openBook(listBooks()[0].id); });
    await lookup("tauriview");
    await expect(page.locator("#dictionaryBody")).toContainText("Custom definition.");
    await expect(page.locator("#dictionaryBody")).not.toContainText("dictionaryInjected");
    assert.equal(await page.evaluate(() => window.dictionaryInjected), undefined);
    assert.equal(external.length, 0);
    await page.evaluate(() => {
      for (const [key, value] of Object.entries({ "--sheet-bg": "#23262c", "--sheet-fg": "#e7eaf0", "--sheet-sub": "#9aa4b4", "--sheet-line": "rgba(255,255,255,.08)", "--sheet-hover": "rgba(255,255,255,.07)" })) document.documentElement.style.setProperty(key, value);
    });
    await page.locator("#dictionaryBox").screenshot({ path: path.join(output, "dark.png") });
    await page.evaluate(async () => { (await import("/src/ai/client.ts")).saveAiConfig({ base: "https://ai.example/v1", key: "test-only", model: "test" }); });
    await page.locator("#dictionaryAi").click();
    await expect(page.locator("#aiBody")).toContainText("结合原文");
    assert.match(aiRequests[0].messages[1].content, /Custom definition/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#aiBox")).toBeHidden();
    await expect(page.locator("#readerView")).toBeVisible();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, screenshots: output, checks: "offline English/Chinese/idiom, pinyin, original annotation, settings, enable/disable, StarDict import, inert HTML, explicit AI handoff" }));
  } finally { await browser?.close(); server.kill(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

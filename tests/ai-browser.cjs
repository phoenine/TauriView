// Run with NODE_PATH pointing at a Playwright installation (or install it locally).
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "tauriview-ai-"));
const server = spawn(process.execPath, ["--input-type=module", "-e", "import {createServer} from 'vite'; const server = await createServer({server:{port:5184,strictPort:true,watch:null}}); await server.listen();"], {
  cwd: root, windowsHide: true, stdio: "ignore",
});
const { expect } = require("playwright/test");

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = (url, options) => {
        if (!window.__testStreaming || !String(url).startsWith('https://ai.example/')) return original(url, options);
        window.__streamPayload = JSON.parse(options.body);
        const encoder = new TextEncoder();
        const event = content => encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          let aborted = false;
          options.signal.addEventListener('abort', () => { aborted = true; controller.error(new DOMException('Stopped', 'AbortError')); }, { once: true });
          controller.enqueue(event('逐步显示的前半段'));
          window.__finishAiStream = () => {
            if (aborted) return;
            controller.enqueue(event('，这是**完整结果**。'));
            if (window.__testTruncated) controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          };
        } }), { headers: { 'content-type': 'text/event-stream' } }));
      };
    });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = [];
    let pause = false, release;
    await page.route("https://ai.example/**", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
      } });
      requests.push(route.request().postDataJSON());
      if (pause) await new Promise((resolve) => { release = resolve; });
      await route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ choices: [{ message: { content: "这句话指工作节奏从之前的忙碌状态慢慢变得轻松、稳定。在上下文中，它表示本月版本刚发布后进入短暂空闲期，**不再像之前那么紧忙**。" } }] }),
      }).catch(() => {});
    });
    for (let attempt = 0; ; attempt++) {
      try { await page.goto("http://127.0.0.1:5184"); break; }
      catch (error) { if (attempt >= 20) throw error; await new Promise((r) => setTimeout(r, 100)); }
    }
    console.log("Page loaded");
    await page.waitForFunction(() => !!window.__tauriview);
    await page.locator("#filePicker").setInputFiles(path.join(root, "tests/fixtures/sherlock.epub"));
    console.log("EPUB imported");
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#viewer iframe")).some((f) => f.contentDocument?.body?.textContent.trim().length > 10));
    const chosen = await page.evaluate(() => {
      const frame = Array.from(document.querySelectorAll("#viewer iframe")).find((f) => f.contentDocument?.body?.textContent.trim().length > 10);
      const doc = frame.contentDocument;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) if (node.textContent.trim().length > 10) break;
      const range = doc.createRange();
      range.setStart(node, 0); range.setEnd(node, Math.min(node.length, 50));
      const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      doc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      document.getElementById("hlAi").click();
      return range.toString().trim();
    });
    await expect(page.locator("#aiConfigure")).toBeVisible();
    assert.equal(await page.locator("#aiBox input, #aiBox select, #aiBox details").count(), 0);
    await page.locator("#aiConfigure").click();
    await expect(page.locator('#settingsView .sp-pane[data-pane="ai"]')).toBeVisible();
    await page.locator("#setAiBase").fill("https://ai.example/v1");
    await page.locator("#setAiKey").fill("test-only");
    await page.locator("#setAiModel").fill("test-model");
    await page.locator("#setAiTest").click();
    await expect(page.locator("#setAiStatus")).toHaveText("连接成功");
    requests.length = 0;
    await page.evaluate(async () => {
      const { listBooks } = await import("/src/storage.ts");
      await window.__tauriview.openBook(listBooks()[0].id);
    });
    await page.evaluate(async (text) => {
      const { annOnSelect } = await import("/src/annotations-ui.ts");
      const frame = document.querySelector("#viewer iframe");
      const doc = frame.contentDocument;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node; while ((node = walker.nextNode())) if (node.textContent.trim().length > 10) break;
      const range = doc.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(node.length, 50));
      const { EpubCFI } = await import("/node_modules/.vite/deps/epubjs.js");
      const cfi = new EpubCFI(range, '/6/2').toString();
      annOnSelect({ cfi, text, passage: { before: "此前的原文", after: "选区后续的解释" }, rect: { left: 100, top: 100, width: 20, height: 20 } });
      document.getElementById("hlAi").click();
    }, chosen);
    await expect(page.locator("#aiBody")).toContainText("这句话");
    await expect(page.locator("#aiExample")).toBeEnabled();
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].messages[1].content.split("\n").slice(1).join("\n"));
    assert.equal(payload.excerpts.find(e => e.label === '选区').text, chosen);
    assert.equal(payload.excerpts[0].text, "此前的原文");
    assert.equal(payload.excerpts.at(-1).text, '选区后续的解释');
    await page.locator("#aiExample").click();
    await expect(page.locator("#aiExample")).toBeEnabled();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].messages.at(-2).role, "assistant");
    await page.evaluate(async () => {
      const { annOnSelect } = await import("/src/annotations-ui.ts");
      annOnSelect({ cfi: "different", text: "另一个选区", rect: { left: 20, top: 20, width: 10, height: 10 } });
    });
    await page.locator("#aiToNote").click();
    await expect(page.locator("#aiToNote")).toHaveText("已补充");
    const saved = await page.evaluate(async () => {
      const { listBooks, loadAnnotations } = await import("/src/storage.ts");
      return loadAnnotations(listBooks()[0].id);
    });
    assert.equal(saved.length, 1); assert.equal(saved[0].text, chosen);
    assert.notEqual(saved[0].cfi, "different");
    // Match the supplied reference's content and state for visual QA.
    await page.evaluate(async () => {
      const { openReadingAi } = await import("/src/ai/ui.ts");
      openReadingAi({ bookId: "qa", title: "阅读样例", author: "", chapter: "", cfi: "qa", percent: 0,
        text: "最近工作也逐渐平缓了下来", passage: { before: "这个月的版本昨天刚发布，接下来是假期。" } });
    });
    await expect(page.locator("#aiExample")).toBeEnabled();
    await page.locator("#aiBox").screenshot({ path: path.join(output, "light-card.png") });
    await page.screenshot({ path: path.join(output, "light.png") });
    await page.evaluate(() => {
      const style = document.documentElement.style;
      for (const [key, value] of Object.entries({ "--sheet-bg": "#23262c", "--sheet-fg": "#e7eaf0", "--sheet-sub": "#9aa4b4", "--sheet-line": "rgba(255,255,255,.08)", "--sheet-hover": "rgba(255,255,255,.07)" })) style.setProperty(key, value);
    });
    await page.locator("#aiBox").screenshot({ path: path.join(output, "dark-card.png") });
    pause = true;
    await page.locator("#aiExample").click();
    await expect.poll(() => !!release).toBe(true);
    await page.keyboard.press("Escape"); release();
    await expect(page.locator("#aiBox")).toBeHidden();
    await expect(page.locator("#readerView")).toBeVisible();
    const capture = await page.evaluate(async () => {
      const { capturePassageContext } = await import("/src/ai/context.ts");
      const doc = new DOMParser().parseFromString('<body><p>首次重复文字</p><script>不应发送</script><p>再次重复文字</p><p>后续解释</p><p hidden>隐藏内容</p><p>末尾文字</p></body>', 'text/html');
      const target = doc.querySelectorAll("p")[1].firstChild;
      const range = doc.createRange(); range.setStart(target, 2); range.setEnd(target, 6);
      return capturePassageContext(range);
    });
    assert.equal(capture.before.includes("首次重复文字"), true);
    assert.equal(capture.before.includes("后续解释"), false);
    assert.equal(capture.before.includes("不应发送"), false);
    assert.equal(capture.after.includes('后续解释'), true);
    assert.equal(capture.after.includes('隐藏内容'), false);
    assert.equal(capture.after.includes('重复文字'), false);
    // Both explanation and examples must appear before the stream completes.
    await page.evaluate(async () => {
      window.__testStreaming = true;
      const { openReadingAi } = await import('/src/ai/ui.ts');
      openReadingAi({ bookId: 'stream', title: '流式测试', author: '', chapter: '', cfi: 'stream', percent: 0, text: '测试选区' });
    });
    await expect(page.locator('#aiBody')).toHaveText('逐步显示的前半段');
    await expect(page.locator('#aiExample')).toBeDisabled();
    await expect(page.locator('#aiToNote')).toBeDisabled();
    assert.equal(await page.evaluate(() => window.__streamPayload.stream), true);
    await page.evaluate(() => window.__finishAiStream());
    await expect(page.locator('#aiBody strong')).toHaveText('完整结果');
    await page.evaluate(() => { window.__testTruncated = true; });
    await page.locator('#aiExample').click();
    await expect(page.locator('#aiBody')).toHaveText('逐步显示的前半段');
    await page.evaluate(() => window.__finishAiStream());
    await expect(page.locator('#aiBody .ai-partial-warn')).toContainText('尚未完整');
    await expect(page.locator('#aiRetry')).toBeVisible();
    await expect(page.locator('#aiToNote')).toBeDisabled();
    await expect(page.locator('#aiExample')).toBeDisabled();
    await page.evaluate(() => { window.__testTruncated = false; });
    await page.locator('#aiRetry').click();
    await expect(page.locator('#aiBody')).toHaveText('逐步显示的前半段');
    await page.evaluate(() => window.__finishAiStream());
    await expect(page.locator('#aiExample')).toBeEnabled();
    await expect(page.locator('#aiExample')).toBeEnabled();
    await page.locator('#aiExample').click();
    await expect(page.locator('#aiBody')).toHaveText('逐步显示的前半段');
    await expect(page.locator('#aiToNote')).toBeDisabled();
    await page.evaluate(() => window.__finishAiStream());
    await expect(page.locator('#aiExample')).toBeEnabled();
    await expect(page.locator('#aiBody strong')).toHaveText('完整结果');
    await page.locator('#aiExample').click();
    await expect(page.locator('#aiBody')).toHaveText('逐步显示的前半段');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__finishAiStream());
    await expect(page.locator('#aiBox')).toBeHidden();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, screenshots: output, checks: "compact card, settings navigation, context on both sides, examples, original annotation anchor, close cancellation, incomplete output warning and retry, light/dark" }));
  } finally { await browser?.close(); server.kill(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

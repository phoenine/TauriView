// Run with NODE_PATH pointing at a Playwright installation when it is not installed locally.
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const { chromium } = require("playwright-core");

async function epubFixture(toc, firstIsNavigation = false, cut = '<p id="cut">同文件的剧透</p>') {
  const zip = new JSZip();
  const first = firstIsNavigation ? "nav.xhtml" : "text/first.xhtml";
  const nav = '<nav epub:type="toc"><ol>' + toc + '</ol></nav>';
  const xhtml = body => '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>测试</title></head><body>' + body + '</body></html>';
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file("OPS/book.opf", `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">reading-context-test</dc:identifier><dc:title>阅读上下文测试</dc:title><dc:language>zh</dc:language></metadata>
    <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${firstIsNavigation ? "" : '<item id="first" href="text/first.xhtml" media-type="application/xhtml+xml"/>'}
    <item id="second" href="text/second.xhtml" media-type="application/xhtml+xml"/><item id="third" href="text/third.xhtml" media-type="application/xhtml+xml"/></manifest>
    <spine><itemref idref="${firstIsNavigation ? "nav" : "first"}"/><itemref idref="second"/><itemref idref="third"/></spine></package>`);
  const firstBody = '<h1 id="first">第一章</h1><p id="selected">选区原文</p><p>安全第一行<br/>安全第二行</p>';
  zip.file("OPS/" + first, xhtml(firstBody + (firstIsNavigation ? cut + nav : "")));
  if (!firstIsNavigation) zip.file("OPS/nav.xhtml", xhtml(nav));
  zip.file("OPS/text/second.xhtml", xhtml("<p>第二节内容。</p>"));
  zip.file("OPS/text/third.xhtml", xhtml("<p>第三章的剧透。</p>"));
  return Array.from(await zip.generateAsync({ type: "uint8array" }));
}

async function readSelection(page, bytes) {
  return page.evaluate(async data => {
    const { openEpub } = await import("/src/reader/epub.ts");
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;background:white";
    document.body.append(host);
    let ready;
    const selected = new Promise(resolve => { ready = resolve; });
    const book = await openEpub(host, new Uint8Array(data).buffer, {
      singleColumn: true,
      onReady() {}, onRelocated() {}, onPagination() {},
      onSelect(value) { ready(value); },
    });
    try {
      const doc = host.querySelector("iframe").contentDocument;
      const range = doc.createRange();
      const text = doc.getElementById("selected").firstChild;
      range.setStart(text, 0);
      range.setEnd(text, text.length);
      doc.getSelection().removeAllRanges();
      doc.getSelection().addRange(range);
      doc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      const selection = await Promise.race([
        selected, new Promise((_, reject) => setTimeout(() => reject(new Error("EPUB selection was not reported")), 2000)),
      ]);
      return await selection.loadContext(new AbortController().signal);
    } finally {
      book.destroy();
      host.remove();
    }
  }, bytes);
}

async function verifyStorage(page) {
  const result = await page.evaluate(async () => {
    const storage = await import("/src/storage.ts");
    await new Promise((resolve, reject) => {
      const req = indexedDB.open("tauriview-reading-index", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("sections").put({ blocks: ["legacy text"] }, ["test", 0]);
        req.result.createObjectStore("terms").put({ signature: "legacy" }, ["test", 0]);
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { req.result.close(); resolve(); };
    });
    await storage.upsertBook({ id: "test", kind: "epub", title: "测试", author: "", size: 1, addedAt: 1 });
    await storage.saveReadingIndexSection("test", { section: 0, signature: "old", filter: new Uint32Array(256), listCounts: [] });
    await storage.saveReadingIndexSection("test", { section: 1, signature: "current", filter: new Uint32Array(256), listCounts: [3] });
    const active = await storage.loadReadingIndex("test", "current");
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open("tauriview-reading-index");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const stores = Array.from(db.objectStoreNames);
        const keys = db.transaction("terms").objectStore("terms").getAllKeys();
        keys.onerror = () => reject(keys.error);
        keys.onsuccess = () => {
          db.close();
          resolve({ stores, keys: keys.result, counts: active.map(entry => entry.listCounts) });
        };
      };
    });
  });
  assert.deepEqual(result, { stores: ["terms"], keys: [["test", 1]], counts: [[3]] });
}

async function verifyRetry(page) {
  await page.evaluate(async () => {
    const { saveAiConfig } = await import("/src/ai/client.ts");
    const { openReadingAi } = await import("/src/ai/ui.ts");
    saveAiConfig({ base: "https://reading-context.invalid", model: "test", key: "test" });
    const fetch = window.fetch.bind(window);
    window.testReadingPayloads = [];
    window.fetch = (url, options) => {
      if (!String(url).startsWith("https://reading-context.invalid/")) return fetch(url, options);
      const payload = JSON.parse(options.body);
      window.testReadingPayloads.push(JSON.parse(payload.messages[1].content.split("\n")[1]).excerpts);
      return Promise.resolve(Response.json({ choices: [{ message: { content: "回答" } }] }));
    };
    let attempts = 0;
    openReadingAi({
      bookId: "test", title: "测试", author: "", chapter: "", cfi: "test", text: "选区", percent: 0,
      loadPassage: () => ({ before: "回退的前文", after: "不得回退的后文" }),
      loadContext: async () => {
        attempts++;
        if (attempts === 1) throw new Error("模拟首次加载失败");
        if (attempts === 2) return { before: [], after: [] };
        return { before: [{ label: "紧邻前文", text: "重试取得的前文" }], after: [] };
      },
    });
  });
  for (const count of [1, 2, 3, 4]) {
    await page.waitForFunction(n => window.testReadingPayloads.length === n && !document.getElementById("aiExample").disabled, count);
    if (count < 4) await page.locator("#aiExample").click();
  }
  const payloads = await page.evaluate(() => window.testReadingPayloads.map(excerpts => excerpts.map(excerpt => excerpt.text)));
  assert.deepEqual(payloads, [
    ["回退的前文", "选区"], ["回退的前文", "选区"],
    ["重试取得的前文", "选区"], ["重试取得的前文", "选区"],
  ]);
}

(async () => {
  const { createServer } = await import("vite");
  const server = await createServer({ configLoader: "runner", server: { port: 0, strictPort: true, watch: null } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.waitForFunction(() => !!window.__tauriview);

    const first = '<li><a href="text/first.xhtml">第一章</a></li>';
    const third = '<li><a href="text/third.xhtml">第三章</a></li>';
    for (const toc of [first, first + third]) {
      const { after } = await readSelection(page, await epubFixture(toc));
      assert.match(after[0].text, /安全第一行\n\n安全第二行/);
      assert.doesNotMatch(JSON.stringify(after), /第二节内容|第三章的剧透/);
    }
    const confirmed = '<li><a href="text/first.xhtml">第一章</a><ol><li><a href="text/second.xhtml">续节</a></li></ol></li>';
    const continuation = await readSelection(page, await epubFixture(confirmed + third));
    assert.match(JSON.stringify(continuation.after), /第二节内容/);
    assert.doesNotMatch(JSON.stringify(continuation.after), /第三章的剧透/);
    const fragment = await readSelection(page, await epubFixture('<li><a href="#first">第一章</a></li><li><a href="#cut">第二章</a></li>', true));
    assert.match(JSON.stringify(fragment.after), /安全第二行/);
    assert.doesNotMatch(JSON.stringify(fragment.after), /同文件的剧透/);
    const heading = await readSelection(page, await epubFixture('<li><a href="#first">第一章</a></li>', true,
      "<h2>第二章</h2><p>同文件的剧透</p>"));
    assert.match(JSON.stringify(heading.after), /安全第二行/);
    assert.doesNotMatch(JSON.stringify(heading.after), /同文件的剧透/);

    await verifyStorage(page);
    await verifyRetry(page);
    console.log("Passed EPUB chapter boundaries, fragment-only TOC, line breaks, IndexedDB migration, and context fallback/retry.");
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

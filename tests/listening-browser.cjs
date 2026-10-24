// UI integration uses deterministic audio/queue responses; listening-gpu.py tests the real CUDA worker.
const { chromium } = require('playwright');
const { expect } = require('playwright/test');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'tauriview-listening-'));
const server = spawn(process.execPath, ['--input-type=module', '-e', "import {createServer} from 'vite'; const s=await createServer({server:{port:5186,strictPort:true,watch:null}}); await s.listen();"], { cwd: root, windowsHide: true, stdio: 'ignore' });

async function epub() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('book.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">listen-test</dc:identifier><dc:title>听书测试</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>');
  zip.file('nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>目录</title></head><body><nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="chapter.xhtml">第一章 清晨</a></li></ol></nav></body></html>');
  zip.file('chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>清晨</title></head><body><h1>第一章 清晨</h1><p id="one">清晨的阳光洒进窗户。今天是个好天气。</p><p id="two">清晨的阳光洒进窗户。我们从这里开始听书。</p><p id="three">接下来的一段，继续讲述新的故事。</p></body></html>');
  const file = path.join(output, 'listening.epub'); fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' })); return file;
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__nativeAudio = window.Audio;
      class AudioStub extends EventTarget {
        paused = true; currentTime = 0; playbackRate = 1; src = '';
        constructor() { super(); window.__testAudio = this; }
        play() { this.paused = false; return Promise.resolve(); }
        pause() { this.paused = true; }
        load() {}
        removeAttribute() { this.src = ''; }
      }
      window.Audio = AudioStub;
    });
    let state = { voice: 'Serena', selected: null, task: null, tasks: [], engine: { phase: 'idle', message: '' }, cacheBytes: 0, quotaBytes: 2147483648,
      model: { id: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice', installed: true, status: 'ready', done: 2498383534, total: 2498383534, error: '' } };
    let preparedAt = 0, runtimeAvailable = true, installingUntil = 0;
    await page.route('**/__tts', async route => {
      const req = route.request().postDataJSON(); requests.push(req);
      let result = state;
      if (req.action === 'config') {
        if (installingUntil && Date.now() >= installingUntil) runtimeAvailable = true;
        result = { available: runtimeAvailable, installStatus: runtimeAvailable ? 'ready' : installingUntil ? 'installing' : 'missing', installMessage: '' };
      }
      if (req.action === 'install_runtime') { installingUntil = Date.now() + 500; result = { available: false, installStatus: 'installing', installMessage: '正在准备语音组件…' }; }
      if (req.action === 'download_model') state.model.status = 'downloading';
      if (req.action === 'cancel_download') state.model.status = 'paused';
      if (req.action === 'submit') {
        const task = { ...req, id: 'task-' + requests.length, total: req.segments.length, completed: 0, listenIndex: req.startIndex, offset: 0, status: 'queued', error: '', playing: false,
          segments: req.segments.map((segment, i) => ({ ...segment, key: 'key-' + i, ready: false, duration: 10 })) };
        state.task = task; state.selected = task.id; state.tasks = [task]; state.engine = { phase: 'generating', message: '正在准备音频…' }; preparedAt = Date.now() + 800;
      }
      if (req.action === 'snapshot' && state.task && Date.now() >= preparedAt) {
        state.task.segments.forEach(s => { s.ready = true; }); state.task.completed = state.task.total; state.task.status = 'ready'; state.engine = { phase: 'ready', message: '' };
      }
      if (req.action === 'voice') state.voice = req.voice;
      if (req.action === 'position' || req.action === 'seek') Object.assign(state.task, { listenIndex: req.index, offset: req.offset, playing: req.playing });
      if (req.action === 'pause_generation') state.task.status = 'paused';
      if (req.action === 'audio') result = { data: Buffer.from('RIFFdummy-wave').toString('base64') };
      if (req.action === 'clear_cache') { state.cacheBytes = 0; state.task.status = 'paused'; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
    });
    for (let n = 0; ; n++) {
      try { await page.goto('http://127.0.0.1:5186'); break; }
      catch (error) { if (n > 30) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    await page.waitForFunction(() => !!window.__tauriview);
    await page.locator('#filePicker').setInputFiles(await epub());
    await page.waitForFunction(() => document.querySelector('#viewer iframe')?.contentDocument?.getElementById('two'));
    assert.equal(await page.locator('#searchBtn + #listenBtn').count(), 1);
    const cfi = await page.evaluate(() => {
      const doc = document.querySelector('#viewer iframe').contentDocument;
      const range = doc.createRange(), text = doc.getElementById('two').firstChild;
      range.setStart(text, 13); range.setEnd(text, 20);
      const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return range.toString();
    });
    assert.ok(cfi);
    await expect(page.locator('#hlListen')).toBeVisible();
    await page.locator('#hlBar').screenshot({ path: path.join(output, 'selection-toolbar.png') });
    await page.locator('#hlListen').click();
    await expect.poll(() => requests.filter(r => r.action === 'submit').length).toBe(1);
    const submitted = requests.find(r => r.action === 'submit');
    assert.ok(submitted.segments[submitted.startIndex].text.includes('我们从这里开始听书'));
    assert.equal(submitted.segments[submitted.startIndex].cfi.includes('[two]'), true);
    assert.equal(submitted.segments.filter(s => s.text.includes('清晨的阳光')).length, 2);
    assert.notEqual(submitted.segments[1].cfi, submitted.segments[3].cfi);
    await expect(page.locator('#listenStatus')).toContainText('准备');
    await expect.poll(() => requests.filter(r => r.action === 'audio').length).toBe(1);
    await expect(page.locator('#listenPlay')).toHaveAttribute('aria-label', '暂停朗读');
    await page.locator('#listenPlayer').screenshot({ path: path.join(output, 'player-light.png') });
    const readingBefore = await page.evaluate(async () => {
      const storage = await import('/src/storage.ts'); return storage.getProgress(storage.listBooks()[0].id);
    });
    await page.locator('#listenNext').click();
    await expect.poll(() => requests.filter(r => r.action === 'seek').length).toBe(1);
    const readingAfter = await page.evaluate(async () => {
      const storage = await import('/src/storage.ts'); return storage.getProgress(storage.listBooks()[0].id);
    });
    assert.deepEqual(readingAfter, readingBefore);
    await page.locator('#listenPlay').click();
    await expect(page.locator('#listenPlay')).toHaveAttribute('aria-label', '播放朗读');
    await page.locator('#listenHide').click();
    await expect(page.locator('#listenPlayer')).toBeHidden();
    await page.locator('#listenBtn').click();
    await expect(page.locator('#listenPlayer')).toBeVisible();
    await page.locator('#listenPlay').click();
    await expect(page.locator('#listenPlay')).toHaveAttribute('aria-label', '播放朗读');
    await page.evaluate(() => window.__tauriview.showLibrary());
    await expect(page.locator('#listenPlayer')).toBeVisible();
    await page.locator('#listenMore').click(); await page.locator('#listenSettings').click();
    await expect(page.locator('.sp-pane[data-pane="listening"]')).toBeVisible();
    await expect(page.locator('#setTtsStatus')).toContainText('模型已就绪');
    await expect(page.locator('#setTtsDownload')).toBeDisabled();
    assert.equal(await page.locator('#setTtsPython, #setTtsModelPath, #setTtsTasks, .tts-advanced').count(), 0);
    await expect(page.locator('#listenPlayer')).toBeHidden();
    await page.screenshot({ path: path.join(output, 'settings.png') });
    await page.locator('#setTtsVoice').selectOption('Uncle_Fu');
    await expect.poll(() => requests.filter(r => r.action === 'voice').length).toBe(1);
    await page.evaluate(async () => { const book = window.__tauriview.listBooks()[0]; await window.__tauriview.openBook(book.id); });
    await page.locator('#listenBtn').click();
    await expect(page.locator('#listenPlayer')).toBeVisible();
    await page.evaluate(() => {
      for (const [key, value] of Object.entries({ '--sheet-bg': '#23262c', '--sheet-fg': '#e7eaf0', '--sheet-sub': '#9aa4b4', '--sheet-line': 'rgba(255,255,255,.08)', '--sheet-hover': 'rgba(255,255,255,.07)' })) document.documentElement.style.setProperty(key, value);
    });
    await page.locator('#listenPlayer').screenshot({ path: path.join(output, 'player-dark.png') });
    // Detached XML documents retain inline words, ignore ruby readings/scripts, and cap long input.
    const segments = await page.evaluate(async () => {
      const { speechSegments } = await import('/src/listening/segments.ts');
      const doc = new DOMParser().parseFromString('<html><body><p>第一句。第二句包含<b>加粗</b>文字。</p><p hidden="hidden">隐藏内容。</p><script>脚本。</script><p>汉<ruby>字<rt>zi</rt></ruby>读音。</p><p>' + '很长的原文'.repeat(100) + '</p></body></html>', 'application/xhtml+xml');
      return speechSegments(doc, range => `offset:${range.startOffset}`);
    });
    assert.equal(segments[0].text, '第一句。第二句包含加粗文字。');
    assert.ok(segments.some(s => s.text === '汉字读音。')); assert.ok(segments.every(s => s.text.length <= 240));
    assert.ok(segments.every(s => !/脚本|隐藏|zi/.test(s.text)));
    // Exercise the browser's actual WAV decoder, independent of the deterministic player stub.
    const wav = Buffer.alloc(44 + 48000 * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24);
    wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(96000, 40);
    const clip = wav.toString('base64');
    const decoded = await page.evaluate(async data => {
      const wav = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      const audio = new window.__nativeAudio();
      try {
        await new Promise((resolve, reject) => { audio.addEventListener('loadedmetadata', resolve, { once: true }); audio.addEventListener('error', reject, { once: true }); audio.src = url; });
        return { duration: audio.duration, ready: audio.readyState > 0 };
      } finally { audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); }
    }, clip);
    assert.ok(decoded.ready && decoded.duration > 1);
    // Missing Python is handled by the single download action, without exposing paths.
    await page.locator('#listenPlay').click();
    runtimeAvailable = false; state.model.installed = false;
    await page.locator('#listenMore').click(); await page.locator('#listenSettings').click();
    await expect(page.locator('#setTtsDownload')).toHaveText('下载并准备');
    await page.locator('#setTtsDownload').click();
    await expect(page.locator('#setTtsDownload')).toHaveText('正在准备…');
    await expect.poll(() => requests.filter(r => r.action === 'download_model').length).toBe(1);
    await expect(page.locator('#setTtsDownload')).toHaveText('取消下载');
    await page.locator('#setTtsDownload').click();
    await expect(page.locator('#setTtsDownload')).toHaveText('继续下载');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, submittedStartIndex: submitted.startIndex, segments: submitted.segments.length, output }));
  } finally { await browser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

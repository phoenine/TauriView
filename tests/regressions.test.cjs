const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function run(source, context) {
  vm.runInContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
}
function functions(file, names) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  return source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map((node) => node.getFullText(source).replace(/^export /m, "")).join("\n");
}
function storageContext(mockFs) {
  const context = vm.createContext({ exports: {}, mockFs });
  const source = read("src/storage.ts")
    .replace('import { isTauri } from "./platform";', "const isTauri = true;")
    .replace('await import("@tauri-apps/plugin-fs")', "mockFs")
    .replace('await import("@tauri-apps/api/path")', '({ appDataDir: async () => "appdata" })');
  run(source, context);
  return context.exports;
}

test("native writes are serialized and publish complete snapshots", async () => {
  const firstWrite = deferred(), entered = deferred();
  const disk = new Map();
  let calls = 0;
  const storage = storageContext({
    mkdir: async () => {}, exists: async () => false,
    writeTextFile: async (file, data) => {
      if (++calls === 1) { entered.resolve(); await firstWrite.promise; }
      disk.set(file, data);
    },
    rename: async (from, to) => { disk.set(to, disk.get(from)); disk.delete(from); },
  });
  await storage.initStorage();
  const first = storage.setProgress("a", "page-1", 0.1);
  await entered.promise;
  const second = storage.setProgress("a", "page-2", 0.2);
  await tick();
  assert.equal(calls, 1);
  assert.equal(disk.has("appdata/books/library.json"), false);
  firstWrite.resolve();
  await Promise.all([first, second]);
  assert.equal(JSON.parse(disk.get("appdata/books/library.json")).progress.a.loc, "page-2");
});

test("a failed temporary write preserves the library and does not poison the queue", async () => {
  const disk = new Map([["appdata/books/library.json", "original"]]);
  let fail = true;
  const storage = storageContext({
    mkdir: async () => {},
    writeTextFile: async (file, data) => {
      if (fail) { fail = false; throw new Error("disk full"); }
      disk.set(file, data);
    },
    rename: async (from, to) => disk.set(to, disk.get(from)),
  });
  await assert.rejects(storage.setProgress("a", "1", 0.1), /disk full/);
  assert.equal(disk.get("appdata/books/library.json"), "original");
  await storage.setProgress("a", "2", 0.2);
  assert.equal(JSON.parse(disk.get("appdata/books/library.json")).progress.a.loc, "2");
});

function element() {
  return {
    style: {}, classList: { add() {}, remove() {} }, clientWidth: 800,
    children: [], hidden: false, textContent: "",
    set innerHTML(value) { this.children = []; },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    getContext: () => ({}),
  };
}
function pdfContext(getPage) {
  const container = element(), reports = [];
  const context = vm.createContext({
    exports: {}, pdfjsLib: { getDocument: () => ({ promise: Promise.resolve({
      numPages: 5, getPage, destroy: async () => {},
    }) }) },
    document: { createElement: element }, window: { addEventListener() {}, removeEventListener() {} },
  });
  const source = read("src/reader/pdf.ts");
  run(source.slice(source.indexOf("export interface PdfHandle")), context);
  return { container, reports, open: () => context.exports.openPdf(container, new ArrayBuffer(0), {
    onRendered: (report) => reports.push(report),
  }) };
}
const page = (number, render) => ({
  getViewport: () => ({ width: 500, height: 700 }),
  render: render ?? (({ canvas }) => {
    canvas.page = number;
    return { promise: Promise.resolve(), cancel() {} };
  }),
});

test("late PDF page lookup cannot replace the latest page or report stale progress", async () => {
  const slow = deferred();
  const pdf = pdfContext((n) => n === 2 ? slow.promise : Promise.resolve(page(n)));
  const handle = await pdf.open();
  handle.next(); handle.next();
  await tick();
  slow.resolve(page(2)); await tick();
  assert.equal(handle.page(), 3);
  assert.equal(pdf.container.children[0].children[0].page, 3);
  assert.deepEqual(pdf.reports.map((r) => r.page), [1, 3]);
});

test("superseded PDF render tasks are cancelled", async () => {
  const rendering = deferred(); let cancelled = false;
  const pdf = pdfContext(async (n) => page(n, n === 2 ? () => ({
    promise: rendering.promise,
    cancel() { cancelled = true; rendering.reject(new Error("cancelled")); },
  }) : undefined));
  const handle = await pdf.open();
  handle.next(); await tick(); handle.next(); await tick();
  assert.equal(cancelled, true);
  assert.equal(pdf.container.children[0].children[0].page, 3);
  assert.deepEqual(pdf.reports.map((r) => r.page), [1, 3]);
});

test("destroying PDF during page lookup prevents further drawing", async () => {
  const slow = deferred(); let drawn = false;
  const pdf = pdfContext((n) => n === 2 ? slow.promise : Promise.resolve(page(n)));
  const handle = await pdf.open();
  handle.next(); handle.destroy();
  slow.resolve(page(2, () => { drawn = true; })); await tick();
  assert.equal(drawn, false);
  assert.deepEqual(pdf.reports.map((r) => r.page), [1]);
});

function mainContext(overrides = {}) {
  const nodes = Object.fromEntries([
    "viewer", "libraryView", "annView", "settingsView", "topline", "readerView", "docTitle", "footLeft",
    "footCenter", "footRight", "tocPanel", "settingsPop", "moreMenu", "insightView",
  ].map((key) => [key, element()]));
  const context = vm.createContext({
    ...nodes, readerSession: 0, currentId: null, handle: null, tocCache: [],
    lastListView: "ann", lastPercent: 0, typo: {}, performance,
    prefs: { transition: "slide", spread: "auto", unifiedMargin: true, startView: "home", confirmRemove: false },
    document: { createElement: element, body: element() },
    window: { setTimeout, clearTimeout },
    listBooks: () => ["a", "b"].map((id) => ({ id, kind: "pdf", title: id })),
    getProgress: () => ({}), getBytes: async () => new ArrayBuffer(0),
    annClear() {}, annLoadFor: async () => [], setProgressBar() {}, beginSession() {}, flushSession() {},
    setWindowTitle: async () => {}, refreshTocCache() {}, persistTocMap: async () => {},
    renderShelf() {}, renderAnnView: async () => {}, setProgress: async () => {},
    alert(message) { throw new Error(`Unexpected alert: ${message}`); },
    ...overrides,
  });
  run(functions("src/main.ts", ["openBook", "closeReader", "showLibrary"]), context);
  return context;
}

test("returning during file loading cannot reopen the reader", async () => {
  const bytes = deferred(); let engineCalls = 0;
  const context = mainContext({ getBytes: () => bytes.promise, openPdf: async () => { engineCalls++; } });
  const opening = context.openBook("a");
  context.closeReader(); bytes.resolve(new ArrayBuffer(0)); await opening;
  assert.equal(engineCalls, 0);
  assert.equal(context.handle, null);
  assert.equal(context.readerView.hidden, true);
  assert.equal(context.annView.hidden, false);
});

test("overlapping book engines use separate containers and discard old handles and callbacks", async () => {
  const oldEngine = deferred(), mounts = [], options = [];
  let destroyed = false;
  const latestHandle = { destroy() {} };
  const context = mainContext({ openPdf: async (mount, bytes, opts) => {
    mounts.push(mount); options.push(opts);
    return mounts.length === 1 ? oldEngine.promise : latestHandle;
  } });
  const old = context.openBook("a"); await tick();
  await context.openBook("b");
  options[1].onRendered({ page: 3, pageCount: 5, percent: 0.5 });
  options[0].onRendered({ page: 1, pageCount: 5, percent: 0 });
  oldEngine.resolve({ destroy() { destroyed = true; } }); await old;
  assert.notEqual(mounts[0], mounts[1]);
  assert.equal(context.viewer.children[0], mounts[1]);
  assert.equal(context.handle, latestHandle);
  assert.equal(context.footLeft.textContent, "3/5");
  assert.equal(destroyed, true);
});

test("annotation loads cannot restore state after leaving the book", async () => {
  const loaded = deferred();
  const context = vm.createContext({
    exports: {}, loadVersion: 0, bookId: null, highlights: [], bookmarks: [],
    loadAnnotations: () => loaded.promise, loadBookmarks: async () => [],
    panel: element(), filterMenu: element(), hideBar() {}, hideNote() {}, hidePreview() {}, renderCount() {}, closeReadingAi() {}, closeDictionary() {},
  });
  run(functions("src/annotations-ui.ts", ["annLoadFor", "annClear"]), context);
  const loading = context.annLoadFor("a");
  context.annClear(); loaded.resolve([{ id: "stale" }]); await loading;
  assert.equal(context.bookId, null);
  assert.equal(context.highlights.length, 0);
});

test("annotation filters distinguish plain highlights and notes", async () => {
  const context = vm.createContext({
    annOnlyFav: false, annFilterBook: "", annFilterKind: "hl",
    listBooks: () => [{ id: "a" }],
    loadAnnotations: async () => [{ id: "plain", createdAt: 1 }, { id: "note", note: "memo", createdAt: 2 }],
  });
  run(functions("src/main.ts", ["collectAnnGroups"]), context);
  assert.equal((await context.collectAnnGroups())[0].items.map((a) => a.id).join(), "plain");
  context.annFilterKind = "note";
  assert.equal((await context.collectAnnGroups())[0].items.map((a) => a.id).join(), "note");
});

test("back button and Escape both return to annotations, including while loading", () => {
  const context = mainContext();
  let back, keydown;
  context.prevBtn = context.nextBtn = { addEventListener() {} };
  context.backBtn = { addEventListener(event, fn) { back = fn; } };
  context.window.addEventListener = (event, fn) => { keydown = fn; };
  const source = read("src/main.ts");
  run(source.slice(source.indexOf('prevBtn.addEventListener("click"'), source.indexOf("function annPanelVisible")), context);
  back();
  assert.equal(context.annView.hidden, false);
  context.annView.hidden = true; context.readerView.hidden = false;
  keydown({ key: "Escape", target: { tagName: "BODY" } });
  assert.equal(context.annView.hidden, false);
  assert.equal(context.readerView.hidden, true);
});

/**
 * 标注 / 书签面板（仿 Aquile）
 *
 * 同一张浅色纸卡承载高亮、笔记、书签三类：顶部可筛选、可切时间排序，
 * 右上「+」在当前阅读位置加书签。选中文字后的浮动色板逻辑保持独立。
 */
import {
  Highlight,
  Bookmark,
  loadAnnotations,
  saveAnnotations,
  loadBookmarks,
  saveBookmarks,
  newId,
  listBooks,
} from "./storage";
import { HIGHLIGHT_COLORS } from "./reader/epub";
import { renderNoteMarkdown } from "./note-markdown";
import type { PassageContext, ReadingAnchor } from "./ai/context";
import { initReadingAi, openReadingAi, closeReadingAi } from "./ai/ui";
import { initDictionary, openDictionary, closeDictionary, type DictionarySnapshot } from "./dictionary/ui";

export interface AnnHandle {
  addHighlight(h: Highlight): void;
  removeHighlight(h: Highlight): void;
  display(cfi: string): void;
  currentLabel(): string;
  cfi(): string;
  percentFor?(cfi: string): number;
}

export interface AnnCtx {
  listenFrom?(cfi: string): void;
  openAiSettings(): void;
  openDictionarySettings(): void;
  bookId(): string | null;
  handle(): AnnHandle | null;
  percent(): number;
  /** 目录面包屑（「第2章 他不是懒孩子 › 疯狂的麦卡锡」） */
  chapterPath(label?: string): string;
}

type Filter = "all" | "hl" | "note" | "bm";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const hlBar = $<HTMLElement>("#hlBar");
const noteBox = $<HTMLElement>("#noteBox");
const noteQuote = $<HTMLElement>("#noteQuote");
const noteInput = $<HTMLTextAreaElement>("#noteInput");
const notePreview = $<HTMLElement>("#notePreview");
const notePreviewText = $<HTMLElement>("#notePreviewText");
let previewId: string | null = null;
let previewShowTimer: number | undefined;
let previewHideTimer: number | undefined;

function hidePreview(): void {
  window.clearTimeout(previewShowTimer);
  window.clearTimeout(previewHideTimer);
  previewShowTimer = previewHideTimer = undefined;
  previewId = null;
  notePreview.hidden = true;
}

function leavePreview(): void {
  window.clearTimeout(previewShowTimer);
  previewShowTimer = undefined;
  if (notePreview.matches(":hover") || notePreview.contains(document.activeElement)) return;
  if (previewHideTimer === undefined) previewHideTimer = window.setTimeout(hidePreview, 200);
}

/** 悬停只预览已有备注；留出短延时，避免经过高亮时打断阅读。 */
export function annOnHover(hit: { id: string; rect: { left: number; top: number; width: number; height: number } } | null): void {
  const h = hit && highlights.find((item) => item.id === hit.id);
  if (!h?.note?.trim() || !noteBox.hidden || !hlBar.hidden) {
    leavePreview();
    return;
  }
  window.clearTimeout(previewHideTimer);
  previewHideTimer = undefined;
  if (previewId === h.id && (previewShowTimer !== undefined || !notePreview.hidden)) return;
  hidePreview();
  previewId = h.id;
  previewShowTimer = window.setTimeout(() => {
    previewShowTimer = undefined;
    if (previewId !== h.id || !noteBox.hidden || !hlBar.hidden) return;
    renderNoteMarkdown(notePreviewText, h.note);
    notePreview.style.setProperty("--note-color", HIGHLIGHT_COLORS[h.color] ?? HIGHLIGHT_COLORS["1"]);
    notePreview.hidden = false;
    const width = notePreview.offsetWidth;
    const height = notePreview.offsetHeight;
    const left = Math.max(12, Math.min(hit.rect.left, window.innerWidth - width - 12));
    const below = hit.rect.top + hit.rect.height + 8;
    const top = below + height <= window.innerHeight - 12 ? below : hit.rect.top - height - 8;
    notePreview.style.left = `${left}px`;
    notePreview.style.top = `${Math.max(12, Math.min(top, window.innerHeight - height - 12))}px`;
  }, 300);
}
const panel = $<HTMLElement>("#annPanel");
const list = $<HTMLElement>("#annList");
const emptyBox = $<HTMLElement>("#marksEmpty");
const emptyText = $<HTMLElement>("#marksEmptyText");
const filterLabel = $<HTMLElement>("#marksFilterLabel");
const filterMenu = $<HTMLElement>("#marksMenu");
const annCount = $<HTMLElement>("#annCount");
const bmCount = $<HTMLElement>("#bmCount");

const FILTER_TEXT: Record<Filter, string> = { all: "标注与笔记", hl: "只看高亮", note: "只看笔记", bm: "书签" };
/** 面板有两种入口：标注（高亮+笔记）与书签，两者不混排、菜单也不互通 */
type PanelScope = "marks" | "bm";
let scope: PanelScope = "marks";

/** 筛选菜单只列出当前入口对应的选项 */
function syncFilterMenu(): void {
  for (const btn of Array.from(filterMenu.querySelectorAll<HTMLElement>("button"))) {
    btn.hidden = btn.dataset.scope !== scope;
  }
  // 标注入口给「只看收藏」，书签入口给「加书签」，两者不共存
  const favBtn = document.getElementById("marksFav");
  const addBtn = document.getElementById("marksAdd");
  if (favBtn) favBtn.hidden = scope !== "marks";
  if (addBtn) addBtn.hidden = scope !== "bm";
  if (favBtn) favBtn.classList.toggle("on", favOnly);
}

let ctx: AnnCtx | null = null;
let bookId: string | null = null;
let highlights: Highlight[] = [];
let bookmarks: Bookmark[] = [];
let filter: Filter = "all";
/** 标注视图：只看收藏的条目（星标按钮切换） */
let favOnly = false;
let sortDesc = true;
let pending: { cfi: string; text: string; passage?: PassageContext } | null = null;
let editing: string | null = null;
let dirtyHl = false;
let dirtyBm = false;
let wired = false;
let loadVersion = 0;

export function initAnnotationUI(context: AnnCtx): void {
  ctx = context;
  wireOnce();
}

export async function annLoadFor(id: string): Promise<Highlight[]> {
  const version = ++loadVersion;
  const [loadedHighlights, loadedBookmarks] = await Promise.all([
    loadAnnotations(id), loadBookmarks(id),
  ]);
  if (version !== loadVersion) return [];
  bookId = id;
  highlights = loadedHighlights;
  bookmarks = loadedBookmarks;
  dirtyHl = false;
  dirtyBm = false;
  renderCount();
  if (!panel.hidden) render();
  return highlights;
}

export function annClear(): void {
  ++loadVersion;
  hidePreview();
  closeReadingAi();
  closeDictionary();
  bookId = null;
  highlights = [];
  bookmarks = [];
  dirtyHl = false;
  dirtyBm = false;
  pending = null;
  editing = null;
  hideBar();
  hideNote();
  panel.hidden = true;
  filterMenu.hidden = true;
  renderCount();
}

/** 打开面板，可指定初始筛选（书签按钮传 bm） */
/** 当前筛选（主进程用它决定按钮是「收起」还是「切换」） */
export function annCurrentFilter(): Filter {
  return filter;
}

export function annOpen(next?: Filter): void {
  if (next) filter = next;
  scope = filter === "bm" ? "bm" : "marks";
  if (scope === "marks") favOnly = false;
  filterLabel.textContent = FILTER_TEXT[filter];
  syncFilterMenu();
  panel.hidden = false;
  render();
}

/* ---------------- 选中文字 → 浮动色板 ---------------- */

export function annOnSelect(sel: { cfi: string; text: string; passage?: PassageContext; rect: { left: number; top: number; width: number; height: number } }): void {
  if (!sel.cfi || !sel.text) return;
  hidePreview();
  pending = { cfi: sel.cfi, text: sel.text, passage: sel.passage };
  editing = null;

  const barW = hlBar.offsetWidth || 260;
  const left = Math.min(Math.max(sel.rect.left + sel.rect.width / 2, barW / 2 + 8), window.innerWidth - barW / 2 - 8);
  const top = Math.max(sel.rect.top - 10, 52);
  hlBar.style.left = `${left}px`;
  hlBar.style.top = `${top}px`;
  hlBar.hidden = false;
}

export function annOnClick(id: string): void {
  const h = highlights.find((x) => x.id === id);
  if (h) openNote(h);
}

export function annHideBar(): void {
  hideBar();
  hidePreview();
}

/* ---------------- 内部 ---------------- */

function hideBar(): void {
  hlBar.hidden = true;
}

function hideNote(): void {
  noteBox.hidden = true;
}

function renderCount(): void {
  // 标注按钮只数高亮/笔记，书签按钮单独数
  annCount.textContent = String(highlights.length);
  annCount.hidden = highlights.length === 0;
  bmCount.textContent = String(bookmarks.length);
  bmCount.hidden = bookmarks.length === 0;
}

function persistHighlights(): void {
  if (!bookId || !dirtyHl) return;
  dirtyHl = false;
  void saveAnnotations(bookId, highlights).catch(() => { dirtyHl = true; });
}

function persistBookmarks(): void {
  if (!bookId || !dirtyBm) return;
  dirtyBm = false;
  void saveBookmarks(bookId, bookmarks);
}

function percentOf(cfi: string, fallback?: number): number {
  const live = ctx?.handle()?.percentFor?.(cfi);
  return typeof live === "number" && live > 0 ? live : (fallback ?? 0);
}

function createHighlight(color: string, note?: string): Highlight | null {
  if (!pending) return null;
  const h: Highlight = {
    id: newId(),
    cfi: pending.cfi,
    text: pending.text,
    color,
    note: note?.trim() || undefined,
    chapter: ctx?.handle()?.currentLabel() || undefined,
    percent: ctx?.percent() ?? 0,
    createdAt: Date.now(),
  };
  highlights.push(h);
  ctx?.handle()?.addHighlight(h);
  dirtyHl = true;
  persistHighlights();
  renderCount();
  if (!panel.hidden) render();
  pending = null;
  return h;
}

/** 在当前位置加/取消书签 */
function toggleBookmarkHere(): void {
  const handle = ctx?.handle();
  if (!handle) return;
  const cfi = handle.cfi();
  if (!cfi) return;

  const exist = bookmarks.find((b) => b.cfi === cfi);
  if (exist) {
    bookmarks = bookmarks.filter((b) => b.id !== exist.id);
  } else {
    bookmarks.push({
      id: newId(),
      cfi,
      chapter: handle.currentLabel(),
      percent: ctx?.percent() ?? 0,
      createdAt: Date.now(),
    });
  }
  dirtyBm = true;
  persistBookmarks();
  renderCount();
  render();
}

function openNote(h: Highlight): void {
  hidePreview();
  editing = h.id;
  pending = null;
  noteQuote.textContent = h.text;
  noteInput.value = h.note ?? "";
  $<HTMLElement>("#noteDelete").hidden = false;
  noteBox.hidden = false;
  noteInput.focus();
  hideBar();
}

function clearSelection(): void {
  try {
    window.getSelection()?.removeAllRanges();
  } catch {
    /* 选区在 iframe 内时清不掉 */
  }
}

const ICON_PATH = {
  highlight: '<path d="M4 17.5 12.2 9.3l2.5 2.5L6.5 20H4zM15.4 6.1l2.5 2.5-1.6 1.6-2.5-2.5z"/>',
  note: '<path d="M4 4h16v12l-4 4H4zm2 2v10h8l3-3V6z"/>',
  bookmark: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.2L5 21V4a1 1 0 0 1 1-1z"/>',
  all: '<path d="M5 4h14v3H5zm0 6h14v3H5zm0 6h9v3H5z"/>',
};

const ICON = {
  highlight: '<svg viewBox="0 0 24 24"><path d="M4 17.5 12.2 9.3l2.5 2.5L6.5 20H4zM15.4 6.1l2.5 2.5-1.6 1.6-2.5-2.5z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M4 4h16v12l-4 4H4zm2 2v10h8l3-3V6z"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.2L5 21V4a1 1 0 0 1 1-1z"/></svg>',
};

/** 列表里的时间用日期（Aquile 的写法：2026/10/22） */
function ymd(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function render(): void {
  list.innerHTML = "";
  const rows: { at: number; build: () => HTMLElement }[] = [];

  // 标注视图（全部/高亮/笔记）里不放书签；书签只在书签视图出现
  if (filter === "bm") {
    for (const b of bookmarks) rows.push({ at: b.createdAt, build: () => bookmarkRow(b) });
  } else {
    for (const h of highlights) {
      const isNote = !!h.note;
      if (filter === "note" && !isNote) continue;
      if (filter === "hl" && isNote) continue;
      if (favOnly && !h.fav) continue;
      rows.push({ at: h.createdAt, build: () => highlightRow(h, isNote) });
    }
  }

  rows.sort((a, b) => (sortDesc ? b.at - a.at : a.at - b.at));
  for (const r of rows) list.appendChild(r.build());

  emptyBox.hidden = rows.length > 0;
  // 空状态图标跟着筛选走，别让「笔记」也显示一枚书签
  const emptyIcon = emptyBox.querySelector("svg");
  if (emptyIcon) emptyIcon.innerHTML = filter === "bm" ? ICON_PATH.bookmark : filter === "note" ? ICON_PATH.note : filter === "hl" ? ICON_PATH.highlight : ICON_PATH.all;
  emptyText.textContent =
    favOnly
      ? "还没有收藏的标注"
      : filter === "bm"
      ? "在此处查找书签"
      : filter === "note"
        ? "还没有笔记"
        : filter === "hl"
          ? "还没有高亮"
          : "还没有标注。选中文字即可高亮或写笔记。";
}

function highlightRow(h: Highlight, isNote: boolean): HTMLElement {
  const li = document.createElement("li");
  li.className = "mark-row";

  const badge = document.createElement("span");
  badge.className = "mark-badge";
  badge.style.setProperty("--c", isNote ? "#ffd54a" : HIGHLIGHT_COLORS[h.color] ?? HIGHLIGHT_COLORS["1"]);
  badge.innerHTML = isNote ? ICON.note : ICON.highlight;

  const body = document.createElement("div");
  body.className = "mark-body";

  const text = document.createElement("div");
  text.className = "mark-text";
  text.textContent = h.text;
  body.appendChild(text);

  if (h.note) {
    const note = document.createElement("div");
    note.className = "mark-note";
    renderNoteMarkdown(note, h.note);
    body.appendChild(note);
  }

  const sub = document.createElement("div");
  sub.className = "mark-sub";
  sub.textContent = ctx?.chapterPath(h.chapter) || "—";
  body.appendChild(sub);

  const time = document.createElement("div");
  time.className = "mark-time";
  time.textContent = ymd(h.createdAt);
  body.appendChild(time);

  const pct = document.createElement("span");
  pct.className = "mark-pct";
  pct.textContent = `${Math.round(percentOf(h.cfi, h.percent) * 100)} %`;

  const star = document.createElement("button");
  star.className = `mark-star${h.fav ? " on" : ""}`;
  star.title = h.fav ? "取消收藏" : "收藏这条标注";
  star.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.5 6 .8-4.4 4.1 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.8l6-.8z"/></svg>';
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    const target = highlights.find((x) => x.id === h.id);
    if (!target) return;
    target.fav = !target.fav;
    star.classList.toggle("on", !!target.fav);
    star.title = target.fav ? "取消收藏" : "收藏这条标注";
    dirtyHl = true;
    persistHighlights();
    if (favOnly) render();
  });

  const del = document.createElement("button");
  del.className = "mark-del";
  del.title = "删除";
  del.textContent = "✕";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    highlights = highlights.filter((x) => x.id !== h.id);
    ctx?.handle()?.removeHighlight(h);
    dirtyHl = true;
    persistHighlights();
    renderCount();
    render();
  });

  li.append(badge, body, pct, star, del);
  li.addEventListener("click", () => {
    ctx?.handle()?.display(h.cfi);
    panel.hidden = true;
  });
  return li;
}

function bookmarkRow(b: Bookmark): HTMLElement {
  const li = document.createElement("li");
  li.className = "mark-row";

  const badge = document.createElement("span");
  badge.className = "mark-badge";
  badge.style.setProperty("--c", "#1a73e8");
  badge.innerHTML = ICON.bookmark;

  const body = document.createElement("div");
  body.className = "mark-body";

  // 书签行只放位置信息：章节路径 + 读到百分之多少（不再重复写「书签」二字，
  // 图标已经说明类型；也不能混进高亮的原文）
  const pctValue = Math.round(percentOf(b.cfi, b.percent) * 100);

  const text = document.createElement("div");
  text.className = "mark-text";
  text.textContent = ctx?.chapterPath(b.chapter) || "此处书签";
  body.appendChild(text);

  const sub = document.createElement("div");
  sub.className = "mark-sub";
  sub.textContent = `读到 ${pctValue}%`;
  body.appendChild(sub);

  const time = document.createElement("div");
  time.className = "mark-time";
  time.textContent = ymd(b.createdAt);
  body.appendChild(time);


  const del = document.createElement("button");
  del.className = "mark-del";
  del.title = "删除书签";
  del.textContent = "✕";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    bookmarks = bookmarks.filter((x) => x.id !== b.id);
    dirtyBm = true;
    persistBookmarks();
    renderCount();
    render();
  });

  li.append(badge, body, del);
  li.addEventListener("click", () => {
    ctx?.handle()?.display(b.cfi);
    panel.hidden = true;
  });
  return li;
}

function wireOnce(): void {
  if (wired) return;
  wired = true;
  notePreview.addEventListener("mouseenter", () => {
    window.clearTimeout(previewHideTimer);
    previewHideTimer = undefined;
  });
  notePreview.addEventListener("mouseleave", leavePreview);
  notePreview.addEventListener("focusin", () => {
    window.clearTimeout(previewHideTimer);
    previewHideTimer = undefined;
  });
  notePreview.addEventListener("focusout", () => window.setTimeout(leavePreview, 0));
  $("#notePreviewEdit").addEventListener("click", () => {
    const h = highlights.find((item) => item.id === previewId);
    if (h) openNote(h);
  });
  window.addEventListener("resize", hidePreview);
  window.addEventListener("blur", hidePreview);
  document.addEventListener("scroll", (event) => {
    if (!(event.target instanceof Node) || !notePreview.contains(event.target)) hidePreview();
  }, true);

  hlBar.querySelectorAll<HTMLButtonElement>(".hl-dot").forEach((dot) => {
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      createHighlight(dot.dataset.color || "1");
      hideBar();
      clearSelection();
    });
  });

  $<HTMLElement>("#hlNote").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pending) return;
    const h = createHighlight("1");
    if (!h) return;
    editing = h.id;
    noteQuote.textContent = h.text;
    noteInput.value = "";
    $<HTMLElement>("#noteDelete").hidden = false;
    hideBar();
    clearSelection();
    noteBox.hidden = false;
    noteInput.focus();
  });

  $<HTMLElement>("#noteSave").addEventListener("click", () => {
    if (editing) {
      const h = highlights.find((x) => x.id === editing);
      if (h) {
        h.note = noteInput.value.trim() || undefined;
        h.updatedAt = Date.now();
        ctx?.handle()?.addHighlight(h);
        dirtyHl = true;
        persistHighlights();
        if (!panel.hidden) render();
      }
    }
    hideNote();
    editing = null;
  });

  $<HTMLElement>("#noteCancel").addEventListener("click", () => {
    hideNote();
    editing = null;
  });

  $<HTMLElement>("#noteDelete").addEventListener("click", () => {
    if (!editing) return;
    const h = highlights.find((x) => x.id === editing);
    if (h) {
      highlights = highlights.filter((x) => x.id !== h.id);
      ctx?.handle()?.removeHighlight(h);
      dirtyHl = true;
      persistHighlights();
      renderCount();
      if (!panel.hidden) render();
    }
    hideNote();
    editing = null;
  });

  /* 面板头部 */
  $<HTMLElement>("#marksFilter").addEventListener("click", (e) => {
    e.stopPropagation();
    filterMenu.hidden = !filterMenu.hidden;
  });

  filterMenu.addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    const f = btn?.dataset.filter as Filter | undefined;
    if (btn && btn.dataset.scope !== scope) return;
    filterMenu.hidden = true;
    if (!f) return;
    filter = f;
    filterLabel.textContent = FILTER_TEXT[f];
    render();
  });

  $<HTMLElement>("#marksSort").addEventListener("click", (e) => {
    e.stopPropagation();
    sortDesc = !sortDesc;
    render();
  });

  $<HTMLElement>("#marksAdd").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleBookmarkHere();
  });

  // 收藏筛选：标注视图里替代了原来的「加书签」
  $<HTMLElement>("#marksFav").addEventListener("click", (e) => {
    e.stopPropagation();
    favOnly = !favOnly;
    $<HTMLElement>("#marksFav").classList.toggle("on", favOnly);
    render();
  });

  $<HTMLElement>("#annClose").addEventListener("click", () => {
    panel.hidden = true;
  });

  /* AI 理解：原选区快照独立于之后的选择和翻页。 */
  const savePassageNote = async (selection: ReadingAnchor, output: string, label: string, dictionary?: DictionarySnapshot) => {
    if (bookId !== selection.bookId || ctx?.bookId() !== selection.bookId) {
      throw new Error("已切换图书，请回到原书后重试。");
    }
    const existing = highlights.find((h) => h.cfi === selection.cfi);
    const note = existing?.note ? existing.note + `\n\n${label}：\n` + output : `${label}：\n` + output;
    const highlight: Highlight = existing ? { ...existing, note, updatedAt: Date.now() } : {
      id: newId(), cfi: selection.cfi, text: selection.text, color: "1", note,
      chapter: selection.chapter, percent: selection.percent, createdAt: Date.now(),
    };
    const next = existing ? highlights.map((h) => h.id === existing.id ? highlight : h) : [...highlights, highlight];
    if (dictionary) highlight.dictionary = dictionary;
    const version = loadVersion;
    await saveAnnotations(selection.bookId, next);
    if (version !== loadVersion) return;
    highlights = next;
    ctx?.handle()?.addHighlight(highlight);
    renderCount();
    if (!panel.hidden) render();
  };
  initReadingAi((selection, output) => savePassageNote(selection, output, "AI 理解"), () => ctx?.openAiSettings());
  initDictionary((selection, dictionary) => savePassageNote(selection,
    `${dictionary.word}\n${dictionary.pronunciation}\n${dictionary.definition}\n来源：${dictionary.name}${dictionary.version ? " · " + dictionary.version : ""}${dictionary.pronunciationSource ? "；拼音：" + dictionary.pronunciationSource : ""}`,
    "词典", dictionary), () => ctx?.openDictionarySettings());
  $("#hlAi").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pending || !bookId) return;
    const meta = listBooks().find((b) => b.id === bookId);
    if (!meta) return;
    openReadingAi({
      ...pending, bookId, title: meta.title, author: meta.author,
      chapter: ctx?.chapterPath(ctx?.handle()?.currentLabel()) || "",
      percent: ctx?.percent() ?? 0,
    });
    closeDictionary();
    hideBar(); clearSelection();
  });
  $("#hlDictionary").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pending || !bookId) return;
    const meta = listBooks().find((b) => b.id === bookId);
    if (!meta) return;
    void openDictionary({ ...pending, bookId, title: meta.title, author: meta.author,
      chapter: ctx?.chapterPath(ctx?.handle()?.currentLabel()) || "", percent: ctx?.percent() ?? 0 });
    hideBar(); clearSelection();
  });
  $("#hlListen").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pending || !bookId) return;
    const cfi = pending.cfi;
    ctx?.listenFrom?.(cfi);
    hideBar(); clearSelection();
  });

  document.addEventListener("mousedown", (e) => {
    const t = e.target as Node | null;
    if (t && !notePreview.contains(t)) hidePreview();
    if (!hlBar.hidden && t && !hlBar.contains(t)) hideBar();
    if (!filterMenu.hidden && t && !filterMenu.contains(t) && !(t instanceof Element && t.closest("#marksFilter"))) {
      filterMenu.hidden = true;
    }
  });

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const previewOpen = !notePreview.hidden || previewShowTimer !== undefined;
      hidePreview();
      const boxOpen = !noteBox.hidden;
      const barOpen = !hlBar.hidden;
      if (!boxOpen && !barOpen && !previewOpen) return;
      e.stopPropagation();
      hideBar();
      if (boxOpen) {
        hideNote();
        editing = null;
        e.preventDefault();
      }
    },
    true,
  );
}

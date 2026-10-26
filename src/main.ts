import "./styles.css";
import { renderNoteMarkdown } from "./note-markdown";
import { initDictionarySettings, refreshDictionarySettings } from "./dictionary/settings";
import { loadAiConfig, saveAiConfig, requestReadingAi } from "./ai/client";
import { isTauri } from "./platform";
import { initListeningUI, listenFrom, refreshListeningSettings } from "./listening/ui";
import {
  BookMeta,
  initStorage,
  lastRead,
  listBooks,
  upsertBook,
  removeBook,
  putBytes,
  getBytes,
  putCover,
  getCoverUrl,
  setProgress,
  getProgress,
  progressAt,
  loadAnnotations,
  saveAnnotations,
  Highlight,
  newId,
  fileSignature,
} from "./storage";
import {
  openEpub,
  extractEpubCover,
  measureEpubPages,
  EpubHandle,
  Typography,
  TocEntry,
  SearchHit,
  DEFAULT_TYPO,
  READER_THEMES,
  HIGHLIGHT_COLORS,
} from "./reader/epub";
import { openPdf, extractPdfCover, PdfHandle } from "./reader/pdf";
import {
  addReadingMs,
  dayKey,
  loadSeconds,
  maxStreakRange,
  maxWeekStreakRange,
  streakDays,
  streakWeeks,
} from "./stats";
import {
  AnnHandle,
  initAnnotationUI,
  annLoadFor,
  annClear,
  annOnSelect,
  annOnClick,
  annOnHover,
  annHideBar,
  annOpen,
  annCurrentFilter,
} from "./annotations-ui";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

/** 窗口标题跟随当前书；浏览器模式忽略 */

/* ---------------- 自绘标题栏：窗口控制 ---------------- */

async function tauriWindow(): Promise<any | null> {
  if (!isTauri) return null;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow();
  } catch {
    return null;
  }
}

$<HTMLElement>("#winMin").addEventListener("click", async () => {
  const w = await tauriWindow();
  try {
    await w?.minimize();
  } catch {
    /* 浏览器模式忽略 */
  }
});

$<HTMLElement>("#winMax").addEventListener("click", async () => {
  const w = await tauriWindow();
  try {
    await w?.toggleMaximize();
  } catch {
    /* 浏览器模式忽略 */
  }
});

$<HTMLElement>("#winClose").addEventListener("click", async () => {
  const w = await tauriWindow();
  try {
    await w?.close();
  } catch {
    /* 浏览器模式忽略 */
  }
});

// 双击标题栏空白处 = 最大化 / 还原
$<HTMLElement>("#titlebar").addEventListener("dblclick", async (e) => {
  if ((e.target as Element)?.closest(".tb-controls")) return;
  const w = await tauriWindow();
  try {
    await w?.toggleMaximize();
  } catch {
    /* 忽略 */
  }
});

// 8 个缩放热区：无边框窗口要自己转发给系统
for (const handle of Array.from(document.querySelectorAll<HTMLElement>(".rz"))) {
  handle.addEventListener("mousedown", async (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const w = await tauriWindow();
    try {
      await w?.startResizeDragging(handle.dataset.rz);
    } catch {
      /* 浏览器模式忽略 */
    }
  });
}

const APP_NAME = "TauriView";

/**
 * 窗口标题永远带软件名：切到设置 / 批注 / 见解时只显示 "TauriView"，
 * 读书时显示 "书名 — TauriView"。自绘标题栏里的文字同步更新。
 */
async function setWindowTitle(title: string): Promise<void> {
  const text = !title || title === APP_NAME ? APP_NAME : `${title} — ${APP_NAME}`;
  const label = document.querySelector("#winTitle");
  if (label) label.textContent = text;
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(text);
  } catch {
    /* 标题设置失败不影响阅读 */
  }
}

const grid = $<HTMLElement>("#grid");
const bookCount = $<HTMLElement>("#bookCount");
const continueSection = $<HTMLElement>("#continueSection");
const continueHero = $<HTMLButtonElement>("#continueHero");
const heroCover = $<HTMLElement>("#heroCover");
const heroTitle = $<HTMLElement>("#heroTitle");
const heroAuthor = $<HTMLElement>("#heroAuthor");
const heroFill = $<HTMLElement>("#heroFill");
const heroSub = $<HTMLElement>("#heroSub");
const emptyState = $<HTMLElement>("#emptyState");
const libraryView = $<HTMLElement>("#libraryView");
const readerView = $<HTMLElement>("#readerView");
const viewTitle = $<HTMLElement>("#viewTitle");
const topline = $<HTMLElement>("#topbar");

const docTitle = $<HTMLElement>("#docTitle");
const viewer = $<HTMLElement>("#viewer");
const footLeft = $<HTMLElement>("#footLeft");
const footCenter = $<HTMLElement>("#footCenter");
const footRight = $<HTMLElement>("#footRight");
const progressFill = $<HTMLElement>("#progressFill");
const prevBtn = $<HTMLButtonElement>("#prev");
const nextBtn = $<HTMLButtonElement>("#next");
const backBtn = $<HTMLButtonElement>("#backToShelf");
const filePicker = $<HTMLInputElement>("#filePicker");

let currentId: string | null = null;
let handle: EpubHandle | PdfHandle | null = null;

/* ---------------- 阅读时长（给阅读见解用） ---------------- */

let sessionStart = 0;

function beginSession(): void {
  sessionStart = Date.now();
}

function flushSession(): void {
  if (!sessionStart) return;
  addReadingMs(Date.now() - sessionStart);
  sessionStart = 0;
}

window.addEventListener("visibilitychange", () => {
  if (document.hidden) flushSession();
  else if (currentId) beginSession();
});
window.addEventListener("beforeunload", flushSession);
let readerSession = 0;
/** 最近一次定位的百分比，新建标注时记进去 */
let lastPercent = 0;

/* ---------------- 阅读设置（全局，跨书生效） ---------------- */

const TYPO_KEY = "tauriview.typography";

function loadTypo(): Typography {
  try {
    const raw = localStorage.getItem(TYPO_KEY);
    if (!raw) return { ...DEFAULT_TYPO };
    const merged = { ...DEFAULT_TYPO, ...JSON.parse(raw) } as Typography;
    // 早期版本存的是 system/serif/sans/kai 这类 key，统一归到「系统默认」
    if (["system", "serif", "sans", "kai"].includes(merged.font)) merged.font = "";
    return merged;
  } catch {
    return { ...DEFAULT_TYPO };
  }
}

let typo: Typography = loadTypo();

/** 只有 EPUB 文字书支持标注；PDF/漫画没有文字层 */
function annHandle(): AnnHandle | null {
  const h = handle as Partial<AnnHandle> | null;
  return h && typeof h.addHighlight === "function" ? (h as AnnHandle) : null;
}
/** 封面 objectURL 缓存，避免每次重排都重新读盘 */
const coverCache = new Map<string, string>();

/* ---------------- 书架 ---------------- */

function renderHero(): void {
  const recent = lastRead();
  const book = recent ? listBooks().find((b) => b.id === recent.id) : undefined;
  if (!recent || !book || recent.percent <= 0) {
    continueSection.hidden = true;
    return;
  }
  continueSection.hidden = false;
  heroTitle.textContent = book.title;
  heroAuthor.textContent = book.author || book.kind.toUpperCase();
  heroFill.style.width = `${Math.min(100, recent.percent * 100).toFixed(1)}%`;
  const when = new Date(recent.at);
  heroSub.textContent = `上次读到 ${(recent.percent * 100).toFixed(1)}% · ${when.getMonth() + 1}月${when.getDate()}日`;

  heroCover.innerHTML = "";
  mountCoverImage(heroCover, book.id);
}

/**
 * 把封面图挂进容器；图一旦加载成功就移除书名占位，
 * 否则占位文字会压在封面上（漫画、深色封面尤其明显）。
 */
function mountCoverImage(container: HTMLElement, id: string): void {
  const apply = (url: string): void => {
    const img = document.createElement("img");
    img.alt = "";
    const clearFallback = (): void => {
      container.querySelector(".cover-fallback")?.remove();
    };
    img.addEventListener("load", clearFallback);
    img.src = url;
    if (img.complete) clearFallback();
    container.appendChild(img);
  };
  const cached = coverCache.get(id);
  if (cached) {
    apply(cached);
    return;
  }
  void getCoverUrl(id).then((url) => {
    if (!url) return;
    coverCache.set(id, url);
    apply(url);
  });
}

/**
 * 早期版本用 epub.js 的 coverUrl() 取封面，部分书（漫画、国内 EPUB2）会失败，
 * 导致卡片只有书名占位。这里在启动后逐个补：读字节 → 重新抽封面 → 落盘 → 重绘。
 */
let coverBackfillStarted = false;

async function backfillCovers(): Promise<void> {
  if (coverBackfillStarted) return;
  coverBackfillStarted = true;
  for (const b of listBooks()) {
    if (b.kind !== "epub") continue;
    try {
      const url = await getCoverUrl(b.id);
      if (url) {
        URL.revokeObjectURL(url);
        continue;
      }
      const buf = await getBytes(b);
      if (!buf) continue;
      const cover = await extractEpubCover(buf);
      if (!cover) continue;
      await putCover(b.id, cover);
      coverCache.delete(b.id);
      renderShelf();
    } catch {
      /* 单本失败不影响其他 */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

/* ---------------- 全部图书：筛选 / 分组 / 分类 / 多选 ---------------- */

type ShelfView = "home" | "books";
type ShelfFilter = "all" | "fav" | "downloaded" | "reading" | "unstarted" | "done";
type GroupMode = "none" | "author" | "status" | "folder";
type SortMode = "recent" | "added" | "title" | "author" | "size";

const FILTER_LABEL: Record<ShelfFilter, string> = {
  all: "所有图书",
  fav: "收藏",
  downloaded: "下载",
  reading: "正在阅读",
  unstarted: "未开始",
  done: "完成",
};
const GROUP_LABEL: Record<GroupMode, string> = { none: "不分组", author: "按作者", status: "按阅读状态", folder: "按分组" };
const SORT_LABEL: Record<SortMode, string> = {
  recent: "最近阅读",
  added: "添加时间",
  title: "书名",
  author: "作者",
  size: "文件大小",
};
const STATUS_LABEL = { unstarted: "未开始", reading: "正在阅读", done: "完成" } as const;

let shelfView: ShelfView = "home";
let shelfFilter: ShelfFilter = "all";
let libQuery = "";
let groupMode: GroupMode = "none";
let sortMode: SortMode = "recent";
let multiMode = false;
const selectedIds = new Set<string>();
/** 文件是否还在本机：「下载」筛选 = 本地文件就绪 */
const fileOk = new Map<string, boolean>();

const filterBar = $<HTMLElement>("#libFilterBar");
const filterBtn = $<HTMLButtonElement>("#filterBtn");
const filterLabel = $<HTMLElement>("#filterLabel");
const shelfHead = $<HTMLElement>("#shelfHeading").parentElement as HTMLElement;
const libActions = $<HTMLElement>("#libActions");
const homeActions = $<HTMLElement>("#homeActions");
const libMenu = $<HTMLElement>("#libMenu");
const libSearchWrap = $<HTMLElement>("#libSearchWrap");
const libSearchInput = $<HTMLInputElement>("#libSearchInput");
const multiBar = $<HTMLElement>("#multiBar");
const multiCount = $<HTMLElement>("#multiCount");
const shelfHeading = $<HTMLElement>("#shelfHeading");
const moreBooks = $<HTMLButtonElement>("#moreBooks");

function percentOf(id: string): number {
  return getProgress(id).percent ?? 0;
}

function statusOf(p: number): keyof typeof STATUS_LABEL {
  if (p >= 0.99) return "done";
  if (p > 0.001) return "reading";
  return "unstarted";
}

/** 对应 Aquile 的分类：最近阅读 / 添加时间 / 书名 / 作者 / 文件大小 */
function sortBooks(list: BookMeta[]): BookMeta[] {
  const out = [...list];
  switch (sortMode) {
    case "recent":
      out.sort((a, b) => progressAt(b.id) - progressAt(a.id) || b.addedAt - a.addedAt);
      break;
    case "added":
      out.sort((a, b) => b.addedAt - a.addedAt);
      break;
    case "title":
      out.sort((a, b) => a.title.localeCompare(b.title, "zh"));
      break;
    case "author":
      out.sort((a, b) => (a.author || "\uffff").localeCompare(b.author || "\uffff", "zh"));
      break;
    case "size":
      out.sort((a, b) => b.size - a.size);
      break;
  }
  return out;
}

function filterBooks(): BookMeta[] {
  let list = listBooks();
  if (shelfView === "books") {
    if (shelfFilter === "fav") list = list.filter((b) => b.fav);
    else if (shelfFilter === "downloaded") list = list.filter((b) => fileOk.get(b.id) !== false);
    else if (shelfFilter !== "all") list = list.filter((b) => statusOf(percentOf(b.id)) === shelfFilter);

    const q = libQuery.trim().toLowerCase();
    if (q) list = list.filter((b) => `${b.title} ${b.author} ${b.folder ?? ""}`.toLowerCase().includes(q));
  }
  return sortBooks(list);
}

function groupKeyOf(b: BookMeta): string {
  if (groupMode === "author") return b.author || "未知作者";
  if (groupMode === "status") return STATUS_LABEL[statusOf(percentOf(b.id))];
  if (groupMode === "folder") return b.folder || "未分组";
  return "";
}

async function setFavorite(id: string, fav: boolean): Promise<void> {
  const meta = listBooks().find((b) => b.id === id);
  if (!meta) return;
  await upsertBook({ ...meta, fav });
}

function buildCard(b: BookMeta): HTMLElement {
  const card = document.createElement("button");
  card.className = "book-card";
  card.type = "button";
  if (multiMode) card.classList.add("multi");
  if (selectedIds.has(b.id)) card.classList.add("selected");

  const frame = document.createElement("div");
  frame.className = "cover-frame";

  const fallback = document.createElement("div");
  fallback.className = "cover-fallback";
  fallback.textContent = b.title;
  frame.appendChild(fallback);

  mountCoverImage(frame, b.id);

  // 收藏星标（对应 Aquile 的 FavoriteBookList）
  const fav = document.createElement("button");
  fav.className = `cover-fav${b.fav ? " on" : ""}`;
  fav.type = "button";
  fav.title = b.fav ? "取消收藏" : "收藏";
  fav.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.5 6 .8-4.4 4.1 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.8l6-.8z"/></svg>';
  fav.addEventListener("click", async (e) => {
    e.stopPropagation();
    await setFavorite(b.id, !b.fav);
    renderShelf();
  });
  frame.appendChild(fav);

  const badge = document.createElement("span");
  badge.className = "cover-badge";
  badge.textContent = b.kind.toUpperCase();
  frame.appendChild(badge);

  if (multiMode) {
    const check = document.createElement("span");
    check.className = "cover-check";
    frame.appendChild(check);
  }

  const del = document.createElement("button");
  del.className = "cover-del";
  del.title = "从书架移除";
  del.textContent = "×";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (prefs.confirmRemove && !window.confirm(`从书架移除《${b.title}》？本机副本会被删除。`)) return;
    if (currentId === b.id) closeReader();
    await removeBook(b.id);
    coverCache.delete(b.id);
    selectedIds.delete(b.id);
    renderShelf();
  });
  frame.appendChild(del);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  const t = document.createElement("span");
  t.className = "card-title";
  t.textContent = b.title;
  const sub = document.createElement("span");
  sub.className = "card-sub";
  const pct = percentOf(b.id);
  const bits: string[] = [];
  if (b.author) bits.push(b.author);
  if (b.folder) bits.push(`· ${b.folder}`);
  if (!b.author && !b.folder) bits.push(pct > 0 ? `读到 ${Math.round(pct * 100)}%` : "未知作者");
  sub.textContent = bits.join(" ");
  meta.append(t, sub);

  // 进度条始终占位：未读的书也留出同样的高度，一排卡片底边才能对齐
  const bar = document.createElement("span");
  bar.className = "card-progress";
  if (pct > 0) {
    const fill = document.createElement("span");
    fill.style.width = `${Math.min(100, Math.round(pct * 100))}%`;
    bar.appendChild(fill);
  } else {
    bar.style.visibility = "hidden";
  }
  meta.appendChild(bar);

  card.append(frame, meta);
  card.addEventListener("click", () => {
    if (multiMode) {
      if (selectedIds.has(b.id)) selectedIds.delete(b.id);
      else selectedIds.add(b.id);
      card.classList.toggle("selected");
      syncMultiBar();
      return;
    }
    void openBook(b.id);
  });
  return card;
}

/**
 * 首页书架只展示一排：以第一张卡片的 offsetTop 为基准，
 * 把不在同一排的卡片摘掉，并算出被隐藏的数量。
 */
function trimToFirstRow(): void {
  const cards = Array.from(grid.children) as HTMLElement[];
  if (!cards.length) {
    moreBooks.hidden = true;
    return;
  }
  const top = cards[0].offsetTop;
  let keep = 0;
  while (keep < cards.length && cards[keep].offsetTop === top) keep++;
  for (let i = keep; i < cards.length; i++) cards[i].remove();
  const hidden = cards.length - keep;
  moreBooks.hidden = hidden <= 0;
  moreBooks.textContent = "查看更多 →";
}

function syncMultiBar(): void {
  multiBar.hidden = !multiMode;
  multiCount.textContent = `已选 ${selectedIds.size} 本`;
  $<HTMLElement>("#libMultiBtn").classList.toggle("on", multiMode);
}


/* ---------- 首页：今日阅读 + 每日目标 ---------- */

const goalCard = $<HTMLElement>("#goalCard");
const goalArc = document.getElementById("goalArc") as unknown as SVGCircleElement;
const goalValue = $<HTMLElement>("#goalValue");
const goalUnit = $<HTMLElement>("#goalUnit");
const goalSub = $<HTMLElement>("#goalSub");

const RING_LEN = 2 * Math.PI * 52; // 与 CSS 里的 dasharray 对应

/** 今日 / 本周 / 连续达标都从同一份按日账本算 */
function renderGoal(): void {
  const log = loadSeconds();
  const todaySec = log[dayKey()] ?? 0;
  const todayMin = Math.round(todaySec / 60);
  const goal = prefs.dailyGoal;

  goalCard.classList.toggle("no-goal", goal <= 0);

  // 达标日集合：拿到目标后才有意义
  const met = new Set<string>();
  if (goal > 0) {
    for (const [k, v] of Object.entries(log)) if (v >= goal * 60) met.add(k);
  }

  if (goal <= 0) {
    goalValue.textContent = String(todayMin);
    goalUnit.textContent = "分钟";
    goalSub.textContent = todayMin > 0 ? "在设置里设定每日目标" : "今天还没开始读";
    goalCard.classList.remove("done");
    goalArc.style.strokeDashoffset = String(RING_LEN);
    return;
  }

  const ratio = Math.min(1, todaySec / (goal * 60));
  const done = todaySec >= goal * 60;
  goalArc.style.strokeDashoffset = String(RING_LEN * (1 - ratio));
  // 环里放两行：大号分钟数 + 小号「/ 目标 分钟」，避免长文本在 120px 的环里折行
  goalValue.textContent = String(todayMin);
  goalUnit.textContent = `/ ${goal} 分钟`;
  goalCard.classList.toggle("done", done);

  const streak = streakDays(met);
  // 本周（周一起算）达标天数
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  let weekMet = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    if (met.has(dayKey(d))) weekMet++;
  }

  const bits: string[] = [];
  if (done) bits.push("今日已达标");
  bits.push(streak > 0 ? `连续达标 ${streak} 天` : "还没有达标记录");
  bits.push(`本周 ${weekMet}/7`);
  goalSub.textContent = bits.join(" · ");
}

goalCard.addEventListener("click", () => showInsightView());

function renderShelf(): void {
  const books = filterBooks();
  const inBooks = shelfView === "books";

  renderHero();
  if (inBooks) continueSection.hidden = true;
  else renderGoal();

  viewTitle.textContent = inBooks ? "全部图书" : "最近阅读";
  // 首页不再显示页面标题：「继续阅读」本身就是页面级标题
  viewTitle.hidden = !inBooks;
  shelfHeading.textContent = inBooks ? FILTER_LABEL[shelfFilter] : "我的书架";
  bookCount.textContent = `${books.length} 本`;
  // 全部图书视图里分类名由下拉承担，标题行只留数量会重复，直接收起
  shelfHead.hidden = inBooks && !libQuery.trim();

  grid.innerHTML = "";
  emptyState.hidden = books.length > 0;
  if (!books.length) {
    const title = emptyState.querySelector(".empty-title");
    const hint = emptyState.querySelector(".hint");
    if (title) title.textContent = inBooks ? `${FILTER_LABEL[shelfFilter]}里还没有书` : "书架是空的";
    if (hint) {
      hint.textContent = inBooks
        ? libQuery
          ? "换个关键词，或清除搜索"
          : "换个分类看看"
        : "点右上角的 + 导入 EPUB 或 PDF";
    }
  }

  if (inBooks) moreBooks.hidden = true;

  if (groupMode === "none") {
    for (const b of books) grid.appendChild(buildCard(b));
    // 首页书架只留第一排，其余交给「查看更多」跳全部图书
    if (!inBooks) trimToFirstRow();
  } else {
    const groups = new Map<string, BookMeta[]>();
    for (const b of books) {
      const key = groupKeyOf(b);
      const arr = groups.get(key);
      if (arr) arr.push(b);
      else groups.set(key, [b]);
    }
    const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, "zh"));
    for (const key of keys) {
      const items = groups.get(key)!;
      const head = document.createElement("h3");
      head.className = "group-row";
      head.textContent = `${key} · ${items.length}`;
      grid.appendChild(head);
      for (const b of items) grid.appendChild(buildCard(b));
    }
  }

  syncMultiBar();
}


/* ---------------- 批注视图（仿 Aquile 的批注列表） ---------------- */

const annView = $<HTMLElement>("#annView");
const annBulkList = $<HTMLElement>("#annBulkList");
const annBookBtn = $<HTMLButtonElement>("#annBookBtn");
const annBookLabel = $<HTMLElement>("#annBookLabel");
const annKindBtn = $<HTMLButtonElement>("#annKindBtn");
const annKindLabel = $<HTMLElement>("#annKindLabel");
const annFavOnly = $<HTMLInputElement>("#annFavOnly");

let annFilterBook = "";
let annFilterKind: "all" | "hl" | "note" = "all";
let annOnlyFav = false;
/** 收起状态的书记下来，重绘时保持 */
const annCollapsed = new Set<string>();
/** 从批注列表进的书，退出阅读时回批注列表 */
let lastListView: "library" | "ann" = "library";

function fmtTime(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

interface AnnGroup {
  book: BookMeta;
  items: Highlight[];
}

async function collectAnnGroups(): Promise<AnnGroup[]> {
  const out: AnnGroup[] = [];
  for (const b of listBooks()) {
    if (annFilterBook && b.id !== annFilterBook) continue;
    let items = await loadAnnotations(b.id);
    // 「只显示收藏夹」筛的是这条批注本身，不是书
    if (annOnlyFav) items = items.filter((a) => a.fav);
    if (annFilterKind === "note") items = items.filter((a) => !!a.note?.trim());
    if (annFilterKind === "hl") items = items.filter((a) => !a.note?.trim());
    if (!items.length) continue;
    items.sort((x, y) => y.createdAt - x.createdAt);
    out.push({ book: b, items });
  }
  out.sort((a, b) => (b.items[0]?.createdAt ?? 0) - (a.items[0]?.createdAt ?? 0));
  return out;
}

/** 图书筛选下拉的数据源（自绘菜单，见 syncAnnBookMenu） */
let annBookChoices: Array<{ id: string; title: string }> = [];

function syncAnnBookSelect(groups: AnnGroup[]): void {
  const books = listBooks();
  const current = annFilterBook;
  annBookChoices = books.map((b) => ({ id: b.id, title: b.title }));
  if (!annBookChoices.some((b) => b.id === current)) annFilterBook = "";
  const shown = annBookChoices.find((b) => b.id === annFilterBook);
  annBookLabel.textContent = shown ? shown.title : "全部";
  annBookBtn.hidden = books.length === 0 && groups.length === 0;
}

/** 章节展示：优先用已存的目录映射，退回落盘文件名 */
function chapterLabelOf(book: BookMeta, a: Highlight): string {
  const raw = (a.chapter ?? "").trim();
  if (!raw) return "";
  if (!/\.x?html?($|#)/i.test(raw)) return raw;
  let key = raw.split("#")[0];
  try {
    key = decodeURIComponent(key);
  } catch {
    /* 保留原样 */
  }
  const map = book.tocMap ?? {};
  if (map[key]) return map[key];
  const hit = Object.keys(map).find((k) => k.split("/").pop() === key.split("/").pop());
  if (hit) return map[hit];
  return key.split("/").pop()!.replace(/\.x?html?$/i, "");
}

/** 收藏 / 取消收藏某条批注（写回该书的 annotations 文件） */
async function toggleAnnFav(book: BookMeta, ann: Highlight): Promise<void> {
  const list = await loadAnnotations(book.id);
  const hit = list.find((a) => a.id === ann.id);
  if (!hit) return;
  hit.fav = !hit.fav;
  hit.updatedAt = hit.updatedAt;
  await saveAnnotations(book.id, list);
  void renderAnnView();
}

/** 删除一条高亮/批注：从该书的 annotations 文件里去掉，正文里同步撤掉 */
async function deleteAnnotation(book: BookMeta, ann: Highlight): Promise<void> {
  if (ann.note?.trim() && !window.confirm("这条批注带笔记，删除后无法恢复。仍要删除？")) return;
  const list = await loadAnnotations(book.id);
  await saveAnnotations(book.id, list.filter((a) => a.id !== ann.id));
  if (currentId === book.id) {
    const h = annHandle();
    if (h) {
      try {
        h.removeHighlight(ann);
      } catch {
        /* 该书没打开或未绘制 */
      }
    }
  }
  void renderAnnView();
}

function annIcon(color: string, isNote: boolean): HTMLElement {
  const ico = document.createElement("span");
  ico.className = "ann-ico";
  ico.style.background = isNote ? "#a9d94a" : (HIGHLIGHT_COLORS[color] ?? HIGHLIGHT_COLORS["1"]);
  ico.innerHTML = isNote
    ? '<svg viewBox="0 0 24 24"><path d="M4 4h16v11l-4 4H4zm2 2v11h9l3-3V6z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z"/></svg>';
  return ico;
}

async function renderAnnView(): Promise<void> {
  const groups = await collectAnnGroups();
  syncAnnBookSelect(groups);

  annBulkList.innerHTML = "";
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "ann-empty";
    empty.textContent = annOnlyFav
      ? "还没有收藏的批注：把鼠标移到某条批注上，点左侧的星标"
      : annFilterKind === "note"
        ? "还没有写过笔记：选中正文后点铅笔图标即可"
        : "还没有批注：阅读时选中正文即可划线或写批注";
    annBulkList.appendChild(empty);
    return;
  }

  for (const { book, items } of groups) {
    const card = document.createElement("div");
    card.className = `ann-book${annCollapsed.has(book.id) ? " collapsed" : ""}`;

    const head = document.createElement("button");
    head.className = "ann-book-head";
    head.type = "button";

    const cover = document.createElement("div");
    cover.className = "ab-cover";
    cover.textContent = book.title.slice(0, 12);
    void getCoverUrl(book.id).then((url) => {
      if (!url) return;
      cover.textContent = "";
      const img = document.createElement("img");
      img.alt = "";
      img.src = url;
      cover.appendChild(img);
    });

    const meta = document.createElement("div");
    meta.className = "ab-meta";
    const title = document.createElement("div");
    title.className = "ab-title";
    title.textContent = book.title;
    if (book.author) {
      const au = document.createElement("span");
      au.className = "ab-author";
      au.textContent = book.author;
      title.appendChild(au);
    }
    const dates = document.createElement("div");
    dates.className = "ab-dates";
    const at = progressAt(book.id);
    dates.innerHTML = `添加日期：${fmtTime(book.addedAt)}<br>最后阅读：${at ? fmtTime(at) : "—"}`;
    meta.append(title, dates);

    const toggle = document.createElement("button");
    toggle.className = "ab-toggle";
    toggle.type = "button";
    toggle.title = "展开 / 收起";
    toggle.textContent = "⌃";
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (annCollapsed.has(book.id)) annCollapsed.delete(book.id);
      else annCollapsed.add(book.id);
      card.classList.toggle("collapsed", annCollapsed.has(book.id));
    });

    head.append(cover, meta, toggle);
    head.addEventListener("click", () => {
      lastListView = "ann";
      void openBook(book.id);
    });

    const body = document.createElement("div");
    body.className = "ab-body";
    for (const a of items) {
      const row = document.createElement("div");
      row.className = "ann-row";
      row.appendChild(annIcon(a.color, !!a.note));

      const content = document.createElement("div");
      content.className = "ann-content";

      const path = document.createElement("div");
      path.className = "ann-path";
      path.textContent = chapterLabelOf(book, a) || `${Math.round((a.percent ?? 0) * 100)}%`;
      const time = document.createElement("div");
      time.className = "ann-time";
      time.textContent = fmtTime(a.updatedAt ?? a.createdAt);
      const text = document.createElement("div");
      text.className = "ann-text";
      text.textContent = a.text;
      content.append(path, time, text);

      if (a.note?.trim()) {
        const note = document.createElement("div");
        note.className = "ann-note";
        const label = document.createElement("b");
        label.textContent = "Note：";
        // 注意：这里不能用 content 命名——外层 .ann-content 也叫 content，
        // 内层同名变量会遮蔽它，content.appendChild(note) 就变成把 note 塞进自己的子孙节点，
        // 直接抛 HierarchyRequestError，整页批注渲染中断。
        const md = document.createElement("div");
        renderNoteMarkdown(md, a.note.trim());
        note.append(label, md);
        content.appendChild(note);
      }

      row.appendChild(content);

      const actions = document.createElement("div");
      actions.className = "ann-actions";

      const star = document.createElement("button");
      star.className = `ann-star${a.fav ? " on" : ""}`;
      star.type = "button";
      star.title = a.fav ? "取消收藏" : "收藏这条批注";
      star.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.5 6 .8-4.4 4.1 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.8l6-.8z"/></svg>';
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        void toggleAnnFav(book, a);
      });

      const del = document.createElement("button");
      del.className = "ann-del";
      del.type = "button";
      del.title = "删除这条批注";
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/></svg>';
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void deleteAnnotation(book, a);
      });

      actions.append(star, del);
      row.appendChild(actions);

      row.addEventListener("click", () => {
        lastListView = "ann";
        void openBook(book.id, a.cfi);
      });
      body.appendChild(row);
    }

    card.append(head, body);
    annBulkList.appendChild(card);
  }
}

function showAnnView(): void {
  shelfView = "home";
  $<HTMLElement>("#railHome").classList.remove("active");
  $<HTMLElement>("#railBooks").classList.remove("active");
  $<HTMLElement>("#railNotes").classList.add("active");
  libraryView.hidden = true;
  settingsView.hidden = true;
  insightView.hidden = true;
  annView.hidden = false;
  libActions.hidden = true;
  homeActions.hidden = true;
  filterBar.hidden = true;
  viewTitle.hidden = false;
  viewTitle.textContent = "批注";
  void setWindowTitle("TauriView");
  void renderAnnView();
}

const ANN_KIND_LABEL: Record<"all" | "hl" | "note", string> = { all: "全部", hl: "高亮", note: "笔记" };

annBookBtn.addEventListener("click", () => {
  openLibMenu(annBookBtn, [
    { label: "全部", on: annFilterBook === "", run: () => { annFilterBook = ""; void renderAnnView(); } },
    ...annBookChoices.map((b) => ({
      label: b.title,
      on: annFilterBook === b.id,
      run: () => { annFilterBook = b.id; void renderAnnView(); },
    })),
  ]);
});

annKindBtn.addEventListener("click", () => {
  openLibMenu(
    annKindBtn,
    (["all", "hl", "note"] as const).map((k) => ({
      label: ANN_KIND_LABEL[k],
      on: annFilterKind === k,
      run: () => {
        annFilterKind = k;
        annKindLabel.textContent = ANN_KIND_LABEL[k];
        void renderAnnView();
      },
    })),
  );
});
annFavOnly.addEventListener("change", () => {
  annOnlyFav = annFavOnly.checked;
  void renderAnnView();
});
$<HTMLElement>("#railNotes").addEventListener("click", () => showAnnView());

/* ---------------- 视图 / 筛选 切换 ---------------- */

function showShelfView(view: ShelfView): void {
  shelfView = view;
  viewTitle.hidden = false;
  lastListView = "library";
  annView.hidden = true;
  settingsView.hidden = true;
  insightView.hidden = true;
  libraryView.hidden = false;
  for (const b of Array.from(document.querySelectorAll<HTMLElement>("#rail .rail-btn"))) b.classList.remove("active");
  $<HTMLElement>("#railNotes").classList.remove("active");
  $<HTMLElement>("#railHome").classList.toggle("active", view === "home");
  $<HTMLElement>("#railBooks").classList.toggle("active", view === "books");
  libActions.hidden = view !== "books";
  homeActions.hidden = view !== "home";
  filterBar.hidden = view !== "books";
  if (view !== "books") {
    libSearchWrap.hidden = true;
    libQuery = "";
    libSearchInput.value = "";
    multiMode = false;
    selectedIds.clear();
  }
  renderShelf();
}

function setFilter(f: ShelfFilter): void {
  shelfFilter = f;
  filterLabel.textContent = FILTER_LABEL[f];
  renderShelf();
}

/* ---------------- 小菜单（分组 / 分类 共用） ---------------- */

let menuAnchor: HTMLElement | null = null;

function closeLibMenu(): void {
  menuAnchor?.setAttribute("aria-expanded", "false");
  menuAnchor = null;
  libMenu.hidden = true;
}

function openLibMenu(
  anchor: HTMLElement,
  entries: Array<{ label: string; on: boolean; run: () => void }>,
  opts: { wide?: boolean } = {},
): void {
  // 再点同一个按钮就收起
  if (menuAnchor === anchor && !libMenu.hidden) {
    closeLibMenu();
    return;
  }
  closeLibMenu();
  libMenu.innerHTML = "";
  for (const entry of entries) {
    const item = document.createElement("button");
    item.className = `lib-menu-item${entry.on ? " on" : ""}`;
    item.type = "button";
    const label = document.createElement("span");
    label.textContent = entry.label;
    item.appendChild(label);
    if (entry.on) {
      const tick = document.createElement("span");
      tick.className = "tick";
      tick.textContent = "✓";
      item.appendChild(tick);
    }
    item.addEventListener("click", () => {
      closeLibMenu();
      entry.run();
    });
    libMenu.appendChild(item);
  }
  const r = anchor.getBoundingClientRect();
  libMenu.classList.toggle("wide", !!opts.wide);
  libMenu.style.minWidth = opts.wide ? "300px" : `${Math.max(172, Math.round(r.width))}px`;
  libMenu.hidden = false;
  menuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  const w = libMenu.offsetWidth;
  libMenu.style.top = `${Math.round(r.bottom + 6)}px`;
  libMenu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - w - 10))}px`;
}

/* ---------------- 视图切换 ---------------- */

function showLibrary(): void {
  flushSession();
  ++readerSession;
  handle?.destroy();
  handle = null;
  viewer.replaceChildren();
  tocCache = [];
  currentId = null;
  annClear();
  tocPanel.hidden = true;
  settingsPop.hidden = true;
  readerView.hidden = true;
  libraryView.hidden = false;
  topline.hidden = false;
  document.body.classList.remove("reading");
  moreMenu.hidden = true;
  lastListView = "library";
  void setWindowTitle("TauriView");
  showShelfView("home");
}

function closeReader(): void {
  flushSession();
  ++readerSession;
  handle?.destroy();
  handle = null;
  viewer.replaceChildren();
  tocCache = [];
  currentId = null;
  annClear();
  tocPanel.hidden = true;
  settingsPop.hidden = true;
  moreMenu.hidden = true;
  readerView.hidden = true;
  document.body.classList.remove("reading");
  if (lastListView === "ann") {
    topline.hidden = false;
    annView.hidden = false;
    libraryView.hidden = true;
    void setWindowTitle("TauriView");
    void renderAnnView();
    return;
  }
  libraryView.hidden = false;
  topline.hidden = false;
  void setWindowTitle("TauriView");
  renderShelf();
}

/* ---------------- 打开书 ---------------- */

async function openBook(id: string, startCfi?: string): Promise<void> {
  const meta = listBooks().find((b) => b.id === id);
  if (!meta) return;

  const session = ++readerSession;
  const active = () => session === readerSession;
  handle?.destroy();
  handle = null;
  annClear();
  tocCache = [];
  currentId = id;
  beginSession();

  libraryView.hidden = true;
  annView.hidden = true;
  settingsView.hidden = true;
  insightView.hidden = true;
  topline.hidden = true;
  readerView.hidden = false;
  // 阅读态：侧栏收起，整窗给页面（Aquile 的做法）
  document.body.classList.add("reading");
  void setWindowTitle(meta.title);
  docTitle.textContent = meta.title;
  viewer.innerHTML = "";
  // 每次打开使用独立容器，过期的引擎只能修改已移除的容器。
  const mount = document.createElement("div");
  mount.style.cssText = "width:100%;height:100%;min-width:0;min-height:0;";
  viewer.appendChild(mount);
  setProgressBar(0);
  footLeft.textContent = "…";
  footCenter.textContent = "";
  footRight.textContent = "";

  const prog = getProgress(id);
  lastPercent = prog.percent ?? 0;
  const from = startCfi ?? prog.loc;

  try {
    const bytes = await getBytes(meta);
    if (!active()) return;
    if (!bytes) throw new Error("读不到文件；如果它被移动或删除，请重新导入。");
    let opened: EpubHandle | PdfHandle;
    if (meta.kind === "epub") {
      let persistTimer: number | undefined;
      const openedAt = performance.now();
      const saved = await annLoadFor(id);
      if (!active()) return;
      const pageMapSig = await fileSignature(meta);
      if (!active()) return;
      opened = await openEpub(mount, bytes, {
        startCfi: from,
        highlights: saved,
        onSelect: (selection) => { if (active()) annOnSelect(selection); },
        onHighlightClick: (highlightId) => { if (active()) annOnClick(highlightId); },
        onHighlightHover: (hit) => { if (active()) annOnHover(hit); },
        onDeselect: () => { if (active()) annHideBar(); },
        cachedPagination: meta.pagination,
        cachedPageMap: meta.pageMap,
        pageMapSig,
        typography: typo,
      transition: prefs.transition,
      singleColumn: prefs.spread === "single",
        onFirstPaint: () => {
          if (!active()) return;
          (window as any).__paintMs = Math.round(performance.now() - openedAt);
        },
        onReady: async ({ title, author }) => {
          if (!active()) return;
          const latest = listBooks().find((b) => b.id === id);
          if (!latest) return;
          // 用户手动改过书名就保留，别被 EPUB 元数据盖回去
          const nextTitle = latest.titleEdited ? latest.title : title || meta.title;
          await upsertBook({ ...latest, title: nextTitle, author: author || meta.author });
          if (!active()) return;
          docTitle.textContent = nextTitle;
        },
        onPageMap: (m) => {
          if (!active()) return;
          const latest = listBooks().find((b) => b.id === id);
          if (!latest) return;
          (window as any).__pageMapMs = Math.round(performance.now() - openedAt);
          void upsertBook({ ...latest, pageMap: m });
        },
        onRelocated: ({ cfi, percent, label, globalPage, totalPages }) => {
          if (!active()) return;
          footLeft.textContent = totalPages > 0 ? `${globalPage}/${totalPages}` : "—";
          footCenter.textContent = chapterPath(label);
          footCenter.title = footCenter.textContent;
          footRight.textContent = `${(percent * 100).toFixed(2)}%`;
          setProgressBar(percent);
          lastPercent = percent;
          annHideBar();
          void setProgress(id, cfi, percent);
        },
        onPagination: (p) => {
          if (!active()) return;
          refreshTocCache();
          // 分页结果合并进书库元数据（library.json / localStorage 一起落盘）
          window.clearTimeout(persistTimer);
          persistTimer = window.setTimeout(() => {
            if (!active()) return;
            const latest = listBooks().find((b) => b.id === id);
            if (!latest) return;
            void upsertBook({ ...latest, pagination: p });
          }, 400);
        },
      });
    } else {
      const parsed = prog.loc ? Number(prog.loc) : 1;
      opened = await openPdf(mount, bytes, {
        startPage: Number.isFinite(parsed) ? parsed : 1,
        onRendered: ({ page, pageCount, percent }) => {
          if (!active()) return;
          footLeft.textContent = `${page}/${pageCount}`;
          footCenter.textContent = meta.title;
          footRight.textContent = `${(percent * 100).toFixed(2)}%`;
          setProgressBar(percent);
          lastPercent = percent;
          void setProgress(id, String(page), percent);
        },
      });
    }
    if (!active()) {
      opened.destroy();
      return;
    }
    handle = opened;
    refreshTocCache();
    if (meta.kind === "epub") await persistTocMap();
  } catch (error) {
    if (!active()) return;
    closeReader();
    alert(`打开《${meta.title}》失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function setProgressBar(ratio: number): void {
  progressFill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
}

/* ---------------- 导入 ---------------- */

function detectKind(name: string): "epub" | "pdf" | null {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "epub") return "epub";
  if (ext === "pdf") return "pdf";
  return null;
}

async function importBytes(name: string, bytes: ArrayBuffer, originalPath?: string): Promise<void> {
  const kind = detectKind(name);
  if (!kind) {
    alert(`不支持的文件类型：${name}（目前只吃 .epub / .pdf）`);
    return;
  }

  const id = newId();
  const filePath = await putBytes(id, bytes, kind);

  // 封面：EPUB 取内嵌封面，PDF 渲染第一页
  try {
    const cover = kind === "epub" ? await extractEpubCover(bytes) : await extractPdfCover(bytes);
    if (cover) await putCover(id, cover);
  } catch {
    /* 没封面就退回占位卡片 */
  }

  await upsertBook({
    id,
    title: name.replace(/\.(epub|pdf)$/i, ""),
    author: "",
    kind,
    size: bytes.byteLength,
    addedAt: Date.now(),
    filePath: filePath ?? originalPath,
  });
  renderShelf();
  await openBook(id);
}

async function pickNative(): Promise<void> {
  const dialog: any = await import("@tauri-apps/plugin-dialog");
  const picked = await dialog.open({
    multiple: true,
    title: "选择 EPUB 或 PDF",
    filters: [{ name: "电子书", extensions: ["epub", "pdf"] }],
  });
  const paths: string[] = Array.isArray(picked) ? picked : picked ? [picked] : [];
  for (const p of paths) await importNativePath(p);
}

interface ImportedFile {
  path: string;
  size: number;
  mtime: number;
}

/**
 * Tauri 导入：由 Rust 把文件复制进 $APPDATA/books，
 * 前端只读复制后的副本 —— 所以 fs scope 不需要放开任意路径。
 */
async function importNativePath(src: string): Promise<void> {
  const name = src.split(/[\\/]/).pop() || "book.epub";
  const kind = detectKind(name);
  if (!kind) {
    alert(`不支持的文件类型：${name}（目前只吃 .epub / .pdf）`);
    return;
  }

  const id = newId();
  let info: ImportedFile;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    info = await invoke<ImportedFile>("import_book", { src, id });
  } catch (e) {
    alert(`导入失败：${String(e)}`);
    return;
  }

  // 抽封面：读复制后的文件（scope 允许）
  try {
    const fs: any = await import("@tauri-apps/plugin-fs");
    const bytes: Uint8Array = await fs.readFile(info.path);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const cover = kind === "epub" ? await extractEpubCover(buf) : await extractPdfCover(buf);
    if (cover) await putCover(id, cover);
  } catch {
    /* 没封面就退回占位卡片 */
  }

  await upsertBook({
    id,
    title: name.replace(/\.(epub|pdf)$/i, ""),
    author: "",
    kind,
    size: info.size,
    addedAt: Date.now(),
    mtime: info.mtime,
    filePath: info.path,
  });
  renderShelf();
  await openBook(id);
}

filePicker.addEventListener("change", async () => {
  const file = filePicker.files?.[0];
  if (!file) return;
  await importBytes(file.name, await file.arrayBuffer());
  filePicker.value = "";
});

$("#openFile").addEventListener("click", () => {
  if (isTauri) void pickNative();
  else filePicker.click();
});
$("#railStats").addEventListener("click", () => showInsightView());
moreBooks.addEventListener("click", () => showShelfView("books"));

/* ---------------- 全部图书：接线 ---------------- */

$<HTMLElement>("#railHome").addEventListener("click", () => showShelfView("home"));
$<HTMLElement>("#railBooks").addEventListener("click", () => showShelfView("books"));

filterBtn.addEventListener("click", () => {
  openLibMenu(
    filterBtn,
    (Object.keys(FILTER_LABEL) as ShelfFilter[]).map((k) => ({
      label: FILTER_LABEL[k],
      on: shelfFilter === k,
      run: () => setFilter(k),
    })),
  );
});

$<HTMLElement>("#libSearchBtn").addEventListener("click", () => {
  libSearchWrap.hidden = !libSearchWrap.hidden;
  if (libSearchWrap.hidden) {
    libQuery = "";
    libSearchInput.value = "";
    renderShelf();
  } else {
    libSearchInput.focus();
  }
});

libSearchInput.addEventListener("input", () => {
  libQuery = libSearchInput.value;
  renderShelf();
});

$<HTMLElement>("#libSearchClear").addEventListener("click", () => {
  libQuery = "";
  libSearchInput.value = "";
  libSearchInput.focus();
  renderShelf();
});

$<HTMLElement>("#libGroupBtn").addEventListener("click", (e) => {
  const btn = e.currentTarget as HTMLElement;
  openLibMenu(
    btn,
    (Object.keys(GROUP_LABEL) as GroupMode[]).map((k) => ({
      label: GROUP_LABEL[k],
      on: groupMode === k,
      run: () => {
        groupMode = k;
        renderShelf();
      },
    })),
  );
});

$<HTMLElement>("#libSortBtn").addEventListener("click", (e) => {
  const btn = e.currentTarget as HTMLElement;
  openLibMenu(
    btn,
    (Object.keys(SORT_LABEL) as SortMode[]).map((k) => ({
      label: SORT_LABEL[k],
      on: sortMode === k,
      run: () => {
        sortMode = k;
        renderShelf();
      },
    })),
  );
});

$<HTMLElement>("#libAddBtn").addEventListener("click", () => $<HTMLElement>("#openFile").click());

$<HTMLElement>("#libMultiBtn").addEventListener("click", () => {
  multiMode = !multiMode;
  if (!multiMode) selectedIds.clear();
  renderShelf();
});

$<HTMLElement>("#multiDone").addEventListener("click", () => {
  multiMode = false;
  selectedIds.clear();
  renderShelf();
});

$<HTMLElement>("#multiAll").addEventListener("click", () => {
  const ids = filterBooks().map((b) => b.id);
  const allOn = ids.length > 0 && ids.every((id) => selectedIds.has(id));
  for (const id of ids) {
    if (allOn) selectedIds.delete(id);
    else selectedIds.add(id);
  }
  renderShelf();
});

$<HTMLElement>("#multiFav").addEventListener("click", () => void batchFavorite(true));
$<HTMLElement>("#multiFavOff").addEventListener("click", () => void batchFavorite(false));
$<HTMLElement>("#multiGroup").addEventListener("click", () => void batchGroup());
$<HTMLElement>("#multiRemove").addEventListener("click", () => void batchRemove());

async function batchFavorite(fav: boolean): Promise<void> {
  for (const id of [...selectedIds]) await setFavorite(id, fav);
  renderShelf();
}

async function batchGroup(): Promise<void> {
  if (!selectedIds.size) return;
  const name = window.prompt("分组名（留空 = 移出分组）", "");
  if (name === null) return;
  const folder = name.trim();
  for (const id of [...selectedIds]) {
    const meta = listBooks().find((b) => b.id === id);
    if (meta) await upsertBook({ ...meta, folder: folder || undefined });
  }
  renderShelf();
}

async function batchRemove(): Promise<void> {
  if (!selectedIds.size) return;
  if (!window.confirm(`从书架移除选中的 ${selectedIds.size} 本？只删本机副本，原文件不动。`)) return;
  for (const id of [...selectedIds]) {
    await removeBook(id);
    coverCache.delete(id);
  }
  selectedIds.clear();
  renderShelf();
}

// 点空白处 / Esc 收起菜单与筛选面板
document.addEventListener("mousedown", (e) => {
  const t = e.target as Element | null;
  if (!libMenu.hidden) {
    const inside = !!t?.closest("#libMenu, #libGroupBtn, #libSortBtn");
    if (!inside) closeLibMenu();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!libMenu.hidden) {
    closeLibMenu();
    return;
  }
  if (multiMode) {
    multiMode = false;
    selectedIds.clear();
    renderShelf();
  }
});

/* ---------------- 翻页 ---------------- */

prevBtn.addEventListener("click", () => handle?.prev());
nextBtn.addEventListener("click", () => handle?.next());
backBtn.addEventListener("click", closeReader);

window.addEventListener("keydown", (e) => {
  if (readerView.hidden) return;
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "Escape") {
    closeReader();
    return;
  }
  if (!handle) return;
  if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
    e.preventDefault();
    handle.next();
  } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
    e.preventDefault();
    handle.prev();
  }
});

function annPanelVisible(): boolean {
  return !$<HTMLElement>("#annPanel").hidden;
}

/* ---------------- 页脚：章节路径 / 外壳配色 ---------------- */

type TocCrumb = { href: string; label: string; crumbs: string[] };
let tocCache: TocCrumb[] = [];

/** 目录是树，把每条拍平成「父 › 子」的路径，给页脚中栏用 */
function refreshTocCache(): void {
  const h = handle as Partial<EpubHandle> | null;
  const entries: TocEntry[] = h && typeof h.toc === "function" ? h.toc() : [];
  const stack: string[] = [];
  tocCache = entries.map((e) => {
    stack.length = e.level;
    stack[e.level] = e.label || "";
    return { href: e.href, label: e.label ?? "", crumbs: stack.slice(0, e.level + 1).filter(Boolean) };
  });
}

/** 把当前书的目录映射写回元数据，批注列表里才能显示章节路径 */
async function persistTocMap(): Promise<void> {
  if (!currentId || !tocCache.length) return;
  const meta = listBooks().find((b) => b.id === currentId);
  if (!meta) return;
  const map: Record<string, string> = {};
  for (const t of tocCache) {
    const file = (t.href || "").split("#")[0];
    if (!file) continue;
    let key = file;
    try {
      key = decodeURIComponent(file);
    } catch {
      /* 保留原样 */
    }
    map[key] = t.crumbs.length ? t.crumbs.join(" › ") : t.label;
  }
  const prev = meta.tocMap ?? {};
  const keys = Object.keys(map);
  if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === map[k])) return;
  await upsertBook({ ...meta, tocMap: map });
}

function chapterPath(label?: string): string {
  if (!label) return "";
  if (!tocCache.length) refreshTocCache();
  let clean = label;
  try {
    clean = decodeURIComponent(label);
  } catch {
    /* 保留原样 */
  }
  const file = clean.split("#")[0].split("/").pop() ?? clean;
  const hit = tocCache.find((t) => {
    let href = t.href;
    try {
      href = decodeURIComponent(t.href);
    } catch {
      /* 保留原样 */
    }
    return href.split("#")[0].endsWith(file);
  });
  if (hit && hit.crumbs.length) return hit.crumbs.join(" › ");
  return file.replace(/\.x?html?$/i, "");
}

/** 页脚、翻页按钮、目录卡、标注卡都跟随纸色主题 */
function applyChrome(): void {
  const th = READER_THEMES[typo.theme];
  const dark = typo.theme === "dark";
  readerView.style.setProperty("--foot-fg", th.fg);
  readerView.style.setProperty("--page-btn-fg", th.fg);
  readerView.style.setProperty("--page-btn-bg", dark ? "rgba(255, 255, 255, .10)" : "rgba(0, 0, 0, .10)");
  readerView.style.setProperty("--page-btn-border", dark ? "rgba(255, 255, 255, .10)" : "rgba(0, 0, 0, .10)");

  // 浮层跟随阅读纸色：暖白、护眼米色、深灰。
  const root = document.documentElement.style;
  const sheet = dark
    ? { bg: "#23262c", fg: "#e7eaf0", sub: "#9aa4b4", time: "#7f8899", line: "rgba(255,255,255,.08)", hover: "rgba(255,255,255,.07)", danger: "#ffaaa4", shadow: "0 12px 32px rgba(0,0,0,.38)" }
    : typo.theme === "sepia"
      ? { bg: "#f7efdf", fg: "#493e2e", sub: "#74654e", time: "#8b7a62", line: "rgba(94,72,40,.14)", hover: "rgba(98,75,43,.07)", danger: "#9c392b", shadow: "0 12px 32px rgba(74,55,28,.18)" }
      : { bg: "#faf8f3", fg: "#14161a", sub: "#6b6b6b", time: "#8d8d8d", line: "rgba(0,0,0,.06)", hover: "rgba(0,0,0,.05)", danger: "#b42318", shadow: "0 12px 32px rgba(39,32,20,.16)" };
  root.setProperty("--sheet-bg", sheet.bg);
  root.setProperty("--sheet-fg", sheet.fg);
  root.setProperty("--sheet-sub", sheet.sub);
  root.setProperty("--sheet-time", sheet.time);
  root.setProperty("--sheet-line", sheet.line);
  root.setProperty("--sheet-hover", sheet.hover);
  root.setProperty("--sheet-danger", sheet.danger);
  root.setProperty("--sheet-shadow", sheet.shadow);
  root.setProperty("--sheet-scheme", dark ? "dark" : "light");
}

/* ---------------- 全文搜索 ---------------- */

const searchPanel = $<HTMLElement>("#searchPanel");
const searchInput = $<HTMLInputElement>("#searchInput");
const searchList = $<HTMLElement>("#searchList");
const searchStatus = $<HTMLElement>("#searchStatus");
const caseToggle = $<HTMLButtonElement>("#caseToggle");
const wordToggle = $<HTMLButtonElement>("#wordToggle");
const searchScope = $<HTMLSelectElement>("#searchScope");

let searchCase = false;
let searchWord = false;
let searchHits: SearchHit[] = [];
let searchQuery = "";
let searchCursor = -1;
let searchTimer: number | undefined;
let searching = false;

function sectionIndexNow(): number | undefined {
  const cfi = (handle as Partial<EpubHandle> | null)?.cfi?.() ?? "";
  const m = /^epubcfi\(\/(\d+)\/(\d+)/.exec(cfi);
  return m ? Math.max(0, parseInt(m[2], 10) / 2 - 1) : undefined;
}

function renderSearchResults(): void {
  searchList.innerHTML = "";
  if (!searchQuery) return;
  if (!searchHits.length) {
    const li = document.createElement("li");
    li.className = "sp-empty";
    li.textContent = "没有找到匹配的内容";
    searchList.appendChild(li);
    return;
  }
  searchHits.forEach((hit, i) => {
    const li = document.createElement("li");
    // 片段里的【命中】段落成 <mark>
    const parts = hit.snippet.split(/【|】/);
    parts.forEach((seg, idx) => {
      if (idx % 2 === 1) {
        const mark = document.createElement("mark");
        mark.textContent = seg;
        li.appendChild(mark);
      } else if (seg) {
        li.appendChild(document.createTextNode(seg));
      }
    });
    const where = document.createElement("span");
    where.className = "sp-where";
    where.textContent = hit.label || `第 ${hit.sectionIndex + 1} 节`;
    li.appendChild(where);
    li.addEventListener("click", () => {
      searchCursor = i;
      void (handle as Partial<EpubHandle> | null)?.revealHit?.(hit, searchQuery);
    });
    searchList.appendChild(li);
  });
}

async function runSearch(): Promise<void> {
  const q = searchInput.value.trim();
  searchQuery = q;
  searchHits = [];
  searchCursor = -1;
  searchList.innerHTML = "";
  if (!q) {
    searchStatus.textContent = "";
    return;
  }
  const h = handle as Partial<EpubHandle> | null;
  if (!h || typeof h.search !== "function") {
    searchStatus.textContent = "先打开一本书";
    return;
  }
  if (searching) return;
  searching = true;
  searchStatus.textContent = "搜索中…";
  try {
    const hits = await h.search(q, (done, total) => {
      searchStatus.textContent = `建索引 ${done}/${total}`;
    }, {
      caseSensitive: searchCase,
      wholeWord: searchWord,
      scopeIndex: searchScope.value === "chapter" ? sectionIndexNow() : undefined,
    });
    searchHits = hits;
    searchStatus.textContent = hits.length ? `${hits.length} 处` : "没有结果";
    renderSearchResults();
    if (hits.length) {
      searchCursor = 0;
      void h.revealHit?.(hits[0], q);
    }
  } catch {
    searchStatus.textContent = "搜索失败";
  } finally {
    searching = false;
  }
}

function gotoNextHit(): void {
  if (!searchHits.length) return;
  searchCursor = (searchCursor + 1) % searchHits.length;
  const hit = searchHits[searchCursor];
  void (handle as Partial<EpubHandle> | null)?.revealHit?.(hit, searchQuery);
  const li = searchList.children[searchCursor] as HTMLElement | undefined;
  li?.scrollIntoView({ block: "nearest" });
}

/**
 * 浮层贴到触发按钮下方：右边对齐按钮右缘，顶部对齐工具栏底边 + 间距。
 * 用工具栏底边而不是按钮底边，免得按钮在栏内垂直居中时浮层压到栏上。
 */
function placeUnder(panel: HTMLElement, btn: HTMLElement, gap = 8): void {
  const bar = (btn.closest("#readerBar") ?? btn).getBoundingClientRect();
  // 右边对齐「整组图标」的右缘，而不是单个按钮：
  // 搜索键是右组第一个，若按它对齐，浮层右边缘会离窗口边 140px 左右，看着很空
  const anchor = (btn.closest(".rb-group") as HTMLElement | null) ?? btn;
  const r = anchor.getBoundingClientRect();
  panel.style.top = `${Math.round(bar.bottom + gap)}px`;
  panel.style.bottom = "auto";
  if (panel.classList.contains("side-left")) {
    panel.style.left = "12px";
    panel.style.right = "auto";
  } else {
    panel.style.left = "auto";
    panel.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  }
}

function toggleSearch(): void {
  if (!searchPanel.hidden) {
    searchPanel.hidden = true;
    return;
  }
  searchPanel.hidden = false;
  placeUnder(searchPanel, $<HTMLElement>("#searchBtn"));
  searchInput.focus();
  searchInput.select();
}

$<HTMLElement>("#searchBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSearch();
});

$<HTMLElement>("#searchClose").addEventListener("click", () => {
  searchPanel.hidden = true;
});

const SEARCH_SIDE_KEY = "tauriview.searchSide";
if (localStorage.getItem(SEARCH_SIDE_KEY) === "left") searchPanel.classList.add("side-left");

$<HTMLElement>("#searchSide").addEventListener("click", (e) => {
  e.stopPropagation();
  const toLeft = !searchPanel.classList.contains("side-left");
  searchPanel.classList.toggle("side-left", toLeft);
  try {
    localStorage.setItem(SEARCH_SIDE_KEY, toLeft ? "left" : "right");
  } catch {
    /* 存不下就只在本次生效 */
  }
  placeUnder(searchPanel, $<HTMLElement>("#searchBtn"));
});

searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void runSearch(), 280);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (searchHits.length) gotoNextHit();
    else void runSearch();
  } else if (e.key === "Escape") {
    searchPanel.hidden = true;
  }
});

$<HTMLElement>("#searchNext").addEventListener("click", () => {
  if (searchHits.length) gotoNextHit();
  else void runSearch();
});

caseToggle.addEventListener("click", () => {
  searchCase = !searchCase;
  caseToggle.classList.toggle("on", searchCase);
  void runSearch();
});

wordToggle.addEventListener("click", () => {
  searchWord = !searchWord;
  wordToggle.classList.toggle("on", searchWord);
  void runSearch();
});

searchScope.addEventListener("change", () => void runSearch());

/* ---------------- 目录 ---------------- */

const tocPanel = $<HTMLElement>("#tocPanel");
const tocList = $<HTMLElement>("#tocList");
const tocBtn = $<HTMLButtonElement>("#tocBtn");
const settingsPop = $<HTMLElement>("#settingsPop");
const fontSelect = $<HTMLSelectElement>("#fontSelect");
const fsVal = $<HTMLElement>("#fsVal");
const railSettings = $<HTMLButtonElement>("#railSettings");

interface TocNode {
  label: string;
  href: string;
  level: number;
  children: TocNode[];
}

/** 把 level 拍平的目录还原成树，章节可以就地展开 */
function buildTocTree(entries: TocEntry[]): TocNode[] {
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];
  for (const e of entries) {
    const node: TocNode = { label: e.label || e.href, href: e.href, level: e.level, children: [] };
    while (stack.length && stack[stack.length - 1].level >= e.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

const CARET_SVG = '<svg viewBox="0 0 24 24"><path d="M9 4.5 16.5 12 9 19.5l-1.4-1.4L13.7 12 7.6 5.9z"/></svg>';
/** 当前所在章节（取自页脚中栏的章节名），用于高亮 */
let currentChapter = "";
const openNodes = new Set<string>();

function renderTocNode(node: TocNode, ul: HTMLElement): void {
  const li = document.createElement("li");

  const row = document.createElement("div");
  row.className = "toc-row";
  const isCurrent = !!currentChapter && node.label && currentChapter.includes(node.label);
  if (isCurrent) row.classList.add("current");

  const caret = document.createElement("span");
  caret.className = "toc-caret" + (node.children.length ? "" : " empty");
  if (node.children.length) {
    caret.innerHTML = CARET_SVG;
    if (openNodes.has(node.href)) caret.classList.add("open");
    caret.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = openNodes.has(node.href);
      if (open) openNodes.delete(node.href);
      else openNodes.add(node.href);
      caret.classList.toggle("open", !open);
      childBox.hidden = open;
    });
  }
  row.appendChild(caret);

  const label = document.createElement("span");
  label.className = "toc-label";
  label.textContent = node.label || node.href;
  row.appendChild(label);

  row.addEventListener("click", () => {
    (handle as Partial<EpubHandle> | null)?.display?.(node.href);
    tocPanel.hidden = true;
  });

  li.appendChild(row);

  const childBox = document.createElement("ul");
  childBox.hidden = node.children.length > 0 && !openNodes.has(node.href);
  if (!node.children.length) childBox.hidden = true;
  for (const child of node.children) renderTocNode(child, childBox);
  li.appendChild(childBox);

  ul.appendChild(li);
}

function renderToc(): void {
  const h = handle as Partial<EpubHandle> | null;
  const entries: TocEntry[] = h && typeof h.toc === "function" ? h.toc() : [];
  tocCache = [];
  tocList.innerHTML = "";
  currentChapter = footCenter.textContent ?? "";

  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "toc-row";
    li.textContent = handle ? "这本书没有目录" : "先打开一本书";
    tocList.appendChild(li);
    return;
  }

  // 展开当前章的祖先，其余保持折叠（和 Aquile 一样只给箭头）
  const tree = buildTocTree(entries);
  const walk = (nodes: TocNode[], trail: TocNode[]): boolean => {
    for (const n of nodes) {
      const next = [...trail, n];
      if (currentChapter && n.label && currentChapter === n.label) {
        for (const p of trail) openNodes.add(p.href);
        return true;
      }
      if (walk(n.children, next)) return true;
    }
    return false;
  };
  walk(tree, []);

  for (const node of tree) renderTocNode(node, tocList);

  // 打开时把当前章滚到中间，别让人自己找
  const cur = tocList.querySelector<HTMLElement>(".toc-row.current");
  const box = tocPanel.querySelector<HTMLElement>(".toc-scroll");
  if (cur && box) {
    const b = box.getBoundingClientRect();
    const r = cur.getBoundingClientRect();
    box.scrollTop += r.top - b.top - (box.clientHeight - r.height) / 2;
  }
}

tocBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  tocPanel.hidden = !tocPanel.hidden;
  if (!tocPanel.hidden) renderToc();
});

$<HTMLElement>("#tocClose").addEventListener("click", () => {
  tocPanel.hidden = true;
});

// 点目录外面关闭（Aquile 没有关闭按钮，靠这个）
document.addEventListener("mousedown", (e) => {
  const t = e.target as Node | null;
  if (tocPanel.hidden || !t) return;
  if (tocPanel.contains(t)) return;
  if (t instanceof Element && t.closest("#tocBtn, #moreMenu")) return;
  tocPanel.hidden = true;
});

/* ---------------- 全屏 / 更多菜单 ---------------- */

const moreMenu = $<HTMLElement>("#moreMenu");
let isFull = false;

async function toggleFullscreen(): Promise<void> {
  if (isTauri) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      isFull = !(await win.isFullscreen());
      await win.setFullscreen(isFull);
      return;
    } catch {
      /* 权限或平台不支持就退到浏览器全屏 */
    }
  }
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      isFull = false;
    } else {
      await document.documentElement.requestFullscreen();
      isFull = true;
    }
  } catch {
    /* 用户环境不允许全屏 */
  }
}

$<HTMLElement>("#fullBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  void toggleFullscreen();
});

function toggleMore(): void {
  moreMenu.hidden = !moreMenu.hidden;
}

$<HTMLElement>("#moreBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMore();
});

/* ---------------- 编辑书名 ---------------- */

const renameWrap = $<HTMLElement>("#renameWrap");
const renameInput = $<HTMLInputElement>("#renameInput");

function openRename(): void {
  const meta = listBooks().find((b) => b.id === currentId);
  if (!meta) return;
  renameInput.value = meta.title;
  renameWrap.hidden = false;
  renameInput.focus();
  renameInput.select();
}

function closeRename(): void {
  renameWrap.hidden = true;
}

async function applyRename(title: string, edited: boolean): Promise<void> {
  const meta = listBooks().find((b) => b.id === currentId);
  if (!meta) return;
  const original = meta.originalTitle ?? meta.title;
  await upsertBook({ ...meta, title, titleEdited: edited, originalTitle: original });
  docTitle.textContent = title;
  void setWindowTitle(title);
  closeRename();
  renderShelf();
}

$<HTMLElement>("#renameCancel").addEventListener("click", () => closeRename());
$<HTMLElement>("#renameSave").addEventListener("click", () => {
  const value = renameInput.value.trim();
  if (!value) { renameInput.focus(); return; }
  void applyRename(value, true);
});
$<HTMLElement>("#renameReset").addEventListener("click", () => {
  const meta = listBooks().find((b) => b.id === currentId);
  if (!meta) return;
  const original = meta.originalTitle ?? meta.title;
  void applyRename(original, false);
});
renameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $<HTMLElement>("#renameSave").click(); }
  else if (e.key === "Escape") { e.preventDefault(); closeRename(); }
});
renameWrap.addEventListener("mousedown", (e) => {
  if (e.target === renameWrap) closeRename();
});

moreMenu.addEventListener("click", (e) => {
  e.stopPropagation();
  const act = (e.target as HTMLElement).closest("button")?.dataset.act;
  moreMenu.hidden = true;
  if (act === "toc") {
    tocPanel.hidden = !tocPanel.hidden;
    if (!tocPanel.hidden) renderToc();
  } else if (act === "ann") {
    $<HTMLElement>("#annBtn").click();
  } else if (act === "typo") {
    toggleSettings();
  } else if (act === "rename") {
    openRename();
  }
});

document.addEventListener("mousedown", (e) => {
  const t = e.target as Node | null;
  if (!moreMenu.hidden && t && !moreMenu.contains(t) && !(t instanceof Element && t.closest("#moreBtn"))) {
    moreMenu.hidden = true;
  }
});

/* ---------------- 阅读设置 ---------------- */

/** 浏览器模式没有本机字体表，给几个通用族兜底 */
const FALLBACK_FONTS = ["Segoe UI", "Microsoft YaHei", "SimSun", "SimHei", "KaiTi", "Georgia", "Arial"];
let fontList: string[] | null = null;

async function ensureFontList(): Promise<string[]> {
  if (fontList) return fontList;
  let names: string[] = [];
  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      names = await invoke<string[]>("list_fonts");
    } catch {
      names = [];
    }
  }
  fontList = names.length ? names : FALLBACK_FONTS;
  return fontList;
}

/** 把字体列表铺进下拉框（第一项永远是「系统默认」） */
function renderFontOptions(): void {
  if (fontSelect.dataset.filled === "1" || !fontList) return;
  const head = document.createElement("option");
  head.value = "";
  head.textContent = "系统默认";
  fontSelect.replaceChildren(head);
  for (const name of fontList) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = name;
    fontSelect.appendChild(o);
  }
  fontSelect.dataset.filled = "1";
}

/** 回填当前字体；旧配置里的字体栈不在列表时临时插一项，避免选中态丢失 */
function syncFontSelect(): void {
  renderFontOptions();
  const current = typo.font || "";
  if (current && !Array.from(fontSelect.options).some((o) => o.value === current)) {
    const o = document.createElement("option");
    o.value = current;
    o.textContent = current.length > 22 ? `${current.slice(0, 22)}…` : current;
    fontSelect.appendChild(o);
  }
  fontSelect.value = current;
}

async function fillFontSelect(): Promise<void> {
  if (!fontList) {
    fontList = await ensureFontList();
    fontSelect.dataset.filled = "";
  }
  syncFontSelect();
}

fontSelect.addEventListener("change", () => {
  applyTypo({ ...typo, font: fontSelect.value });
});

function syncSettings(): void {
  fsVal.textContent = `${typo.fontSize}%`;
  settingsPop.querySelectorAll<HTMLElement>("[data-lh]").forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.lh) === typo.lineHeight);
  });
  settingsPop.querySelectorAll<HTMLElement>("[data-theme]").forEach((b) => {
    b.classList.toggle("on", b.dataset.theme === typo.theme);
  });
  syncFontSelect();
}

function applyTypo(next: Typography): void {
  typo = next;
  try {
    localStorage.setItem(TYPO_KEY, JSON.stringify(typo));
  } catch {
    /* 存不下就只在本次生效 */
  }
  syncSettings();
  applyChrome();
  const h = handle as Partial<EpubHandle> | null;
  if (h && typeof h.setTypography === "function") h.setTypography(typo);
}



/* ---------- 设置页：AI 配置 ---------- */

const setAiBase = $<HTMLInputElement>("#setAiBase");
const setAiKey = $<HTMLInputElement>("#setAiKey");
const setAiModel = $<HTMLInputElement>("#setAiModel");
const setAiStatus = $<HTMLElement>("#setAiStatus");

function loadAiForm(): void {
  const cfg = loadAiConfig();
  setAiBase.value = cfg.base; setAiKey.value = cfg.key; setAiModel.value = cfg.model;
}

function saveAiForm(): boolean {
  try {
    const persisted = saveAiConfig({ base: setAiBase.value, key: setAiKey.value, model: setAiModel.value });
    setAiStatus.textContent = persisted ? "已保存" : "仅在本次运行生效";
    setAiStatus.style.color = "";
    return true;
  } catch (error) {
    setAiStatus.textContent = (error as Error).message;
    setAiStatus.style.color = "#ff8a8a";
    return false;
  }
}

async function testAi(): Promise<void> {
  if (!saveAiForm()) return;
  const button = $<HTMLButtonElement>("#setAiTest");
  button.disabled = true;
  setAiStatus.textContent = "测试中…";
  setAiStatus.style.color = "";
  try {
    await requestReadingAi(loadAiConfig(), [{ role: "user", content: "只回复：连接成功" }], new AbortController().signal);
    setAiStatus.textContent = "连接成功";
    setAiStatus.style.color = "#7fe6dd";
  } catch (error) {
    setAiStatus.textContent = (error as Error).message;
    setAiStatus.style.color = "#ff8a8a";
  } finally { button.disabled = false; }
}

for (const input of [setAiBase, setAiKey, setAiModel]) {
  input.addEventListener("change", saveAiForm);
  input.addEventListener("blur", saveAiForm);
}
$<HTMLElement>("#setAiTest").addEventListener("click", () => void testAi());


/* ---------------- 阅读见解 ---------------- */

const insightView = $<HTMLElement>("#insightView");
const inSummary = $<HTMLElement>("#inSummary");
const inStreaks = $<HTMLElement>("#inStreaks");
const inRecords = $<HTMLElement>("#inRecords");
const inChart = $<HTMLElement>("#inChart");
const inYearBtn = $<HTMLButtonElement>("#inYearBtn");
const inYearLabel = $<HTMLElement>("#inYearLabel");
const inScopeBtn = $<HTMLButtonElement>("#inScopeBtn");
const inScopeLabel = $<HTMLElement>("#inScopeLabel");
const inMetricBtn = $<HTMLButtonElement>("#inMetricBtn");
const inMetricLabel = $<HTMLElement>("#inMetricLabel");

type InsightMetric = "days" | "books" | "hours";

const METRIC_LABEL: Record<InsightMetric, string> = {
  days: "几天阅读",
  books: "读书",
  hours: "阅读时间（HRS）",
};

let insightYear = new Date().getFullYear();
/** null = 整年，1-12 = 只看某个月 */
let insightMonth: number | null = null;
let insightMetric: InsightMetric = "days";

function monthLabel(m: number | null): string {
  return m === null ? "全部" : `${m}月`;
}

/** 有阅读活动的日期：时长账本 ≥60 秒，或该书有进度时间（兼容升级前的记录） */
function activityDays(): Set<string> {
  const days = new Set<string>();
  for (const [k, v] of Object.entries(loadSeconds())) if (v >= 60) days.add(k);
  for (const b of listBooks()) {
    const at = progressAt(b.id);
    if (at) days.add(dayKey(new Date(at)));
  }
  return days;
}

/** 日期键是否落在当前「年 + 可选月份」范围内 */
function inPeriod(key: string): boolean {
  if (!key.startsWith(String(insightYear))) return false;
  if (insightMonth === null) return true;
  return key.slice(5, 7) === String(insightMonth).padStart(2, "0");
}

/** 中国大陆习惯：2026年10月24日 */
function fmtDay(key: string): string {
  const [y, m, d] = key.split("-");
  return `${y}年${Number(m)}月${Number(d)}日`;
}

/** 连胜区间：同一天只写一次；同年时后半段省略年份 */
function fmtRange(start?: string, end?: string): string {
  if (!start || !end) return "还没有记录";
  if (start === end) return fmtDay(start);
  const [sy] = start.split("-");
  const [ey, em] = end.split("-");
  if (sy === ey) {
    const [, , d] = end.split("-");
    return `${fmtDay(start)} - ${Number(em)}月${Number(d)}日`;
  }
  return `${fmtDay(start)} - ${fmtDay(end)}`;
}

function card(label: string, value: string, foot = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = "in-card";
  const l = document.createElement("div");
  l.className = "in-card-label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "in-card-value";
  v.textContent = value;
  el.append(l, v);
  if (foot) {
    const f = document.createElement("div");
    f.className = "in-card-foot";
    f.textContent = foot;
    el.appendChild(f);
  }
  return el;
}

function renderInsightChart(days: Set<string>): void {
  const log = loadSeconds();
  const books = listBooks();
  const months = Array.from({ length: 12 }, (_, i) => `${insightYear}-${String(i + 1).padStart(2, "0")}`);
  const booksInMonth = (m: string): number =>
    books.filter((b) => {
      const at = progressAt(b.id);
      return at > 0 && dayKey(new Date(at)).startsWith(m);
    }).length;
  const secondsInMonth = (m: string): number => {
    let sec = 0;
    for (const [k, v] of Object.entries(log)) if (k.startsWith(m)) sec += v;
    return sec;
  };

  const values = months.map((m) => {
    switch (insightMetric) {
      case "days":
        return [...days].filter((d) => d.startsWith(m)).length;
      case "books":
        return booksInMonth(m);
      case "hours":
        return secondsInMonth(m) / 3600;
    }
  });

  const decimals = insightMetric === "hours";
  const fmt = (v: number): string => (decimals ? v.toFixed(1) : String(Math.round(v)));
  const max = Math.max(decimals ? 0.1 : 1, ...values);
  const rawStep = max / 5;
  const step = decimals ? Math.max(0.1, Math.round(rawStep * 10) / 10) : Math.max(1, Math.round(rawStep));
  const top = Math.ceil(max / step) * step;

  inChart.replaceChildren();

  const plot = document.createElement("div");
  plot.className = "in-plot";

  const yAxis = document.createElement("div");
  yAxis.className = "in-plot-y";
  const grid = document.createElement("div");
  grid.className = "in-grid";
  for (let t = top; t >= -0.0001; t -= step) {
    const y = document.createElement("span");
    y.textContent = fmt(t);
    yAxis.appendChild(y);
    const line = document.createElement("i");
    line.style.bottom = `${(t / top) * 100}%`;
    grid.appendChild(line);
  }

  const cols = document.createElement("div");
  cols.className = "in-cols";
  values.forEach((v, i) => {
    const col = document.createElement("div");
    col.className = "in-bar-col";
    const val = document.createElement("div");
    val.className = "in-bar-val";
    val.textContent = v ? fmt(v) : "";
    const bar = document.createElement("div");
    bar.className = `in-bar${insightMonth === i + 1 ? " on" : ""}`;
    bar.style.height = `${Math.round((v / top) * 100)}%`;
    bar.title = `${i + 1}月 · ${METRIC_LABEL[insightMetric]} ${fmt(v)}`;
    col.append(val, bar);
    cols.appendChild(col);
  });

  plot.append(grid, yAxis, cols);
  inChart.appendChild(plot);

  const axis = document.createElement("div");
  axis.className = "in-xaxis";
  for (let m = 1; m <= 12; m++) {
    const sp = document.createElement("span");
    sp.textContent = `${m}月`;
    axis.appendChild(sp);
  }
  inChart.appendChild(axis);
}

function renderInsight(): void {
  const all = activityDays();
  const days = new Set([...all].filter(inPeriod));
  const log = loadSeconds();
  let seconds = 0;
  for (const [k, v] of Object.entries(log)) if (inPeriod(k)) seconds += v;

  // 读书 = 这一期里有阅读记录的书（按进度时间落在范围内判断）
  const active = listBooks().filter((b) => {
    const at = progressAt(b.id);
    return at > 0 && inPeriod(dayKey(new Date(at)));
  });

  const hours = (seconds / 3600).toFixed(1);
  const perDay = days.size ? (seconds / 60 / days.size).toFixed(1) : "0";

  inSummary.replaceChildren(
    card("读书", String(active.length)),
    card("几天阅读", String(days.size)),
    card("阅读时间（HRS）", hours),
    card("每日平均阅读时间（分钟）", perDay),
  );

  inStreaks.replaceChildren(card("连续几天", String(streakDays(all))), card("连续几周", String(streakWeeks(all))));

  const dayBest = maxStreakRange(all);
  const weekBest = maxWeekStreakRange(all);
  inRecords.replaceChildren(
    card(
      "每日连胜记录",
      String(dayBest.length),
      fmtRange(dayBest.start, dayBest.end),
    ),
    card(
      "每周连胜记录",
      String(weekBest.length),
      fmtRange(weekBest.start, weekBest.end),
    ),
  );

  renderInsightChart(days);
}

function showInsightView(): void {
  libraryView.hidden = true;
  annView.hidden = true;
  settingsView.hidden = true;
  readerView.hidden = true;
  insightView.hidden = false;
  topline.hidden = false;
  libActions.hidden = true;
  homeActions.hidden = true;
  filterBar.hidden = true;
  viewTitle.hidden = false;
  viewTitle.textContent = "阅读见解";
  void setWindowTitle("TauriView");
  for (const b of Array.from(document.querySelectorAll<HTMLElement>("#rail .rail-btn"))) b.classList.remove("active");
  $<HTMLElement>("#railStats").classList.add("active");
  inYearLabel.textContent = String(insightYear);
  inScopeLabel.textContent = monthLabel(insightMonth);
  inMetricLabel.textContent = METRIC_LABEL[insightMetric];
  renderInsight();
}

/** 年份下拉：数据里出现过的年份 + 今年，倒序 */
function insightYears(): number[] {
  const years = new Set<number>([new Date().getFullYear()]);
  for (const k of activityDays()) years.add(Number(k.slice(0, 4)));
  return [...years].filter((y) => Number.isFinite(y)).sort((a, b) => b - a);
}

inYearBtn.addEventListener("click", () => {
  const years = insightYears();
  openLibMenu(
    inYearBtn,
    years.map((y) => ({
      label: String(y),
      on: insightYear === y,
      run: () => {
        insightYear = y;
        inYearLabel.textContent = String(y);
        renderInsight();
      },
    })),
  );
});

inScopeBtn.addEventListener("click", () => {
  const months: Array<number | null> = [null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  openLibMenu(
    inScopeBtn,
    months.map((m) => ({
      label: monthLabel(m),
      on: insightMonth === m,
      run: () => {
        insightMonth = m;
        inScopeLabel.textContent = monthLabel(m);
        renderInsight();
      },
    })),
  );
});

inMetricBtn.addEventListener("click", () => {
  openLibMenu(
    inMetricBtn,
    (Object.keys(METRIC_LABEL) as InsightMetric[]).map((k) => ({
      label: METRIC_LABEL[k],
      on: insightMetric === k,
      run: () => {
        insightMetric = k;
        inMetricLabel.textContent = METRIC_LABEL[k];
        renderInsight();
      },
    })),
    { wide: true },
  );
});

/* ---------------- 设置页 ---------------- */

interface Prefs {
  transition: "slide" | "fade" | "none";
  spread: "auto" | "single";
  unifiedMargin: boolean;
  startView: "home" | "books";
  confirmRemove: boolean;
  /** 每日阅读目标（分钟），0 = 关闭 */
  dailyGoal: number;
}

const PREFS_KEY = "tauriview.prefs";

function loadPrefs(): Prefs {
  const base: Prefs = {
    transition: "slide",
    spread: "auto",
    unifiedMargin: true,
    startView: "home",
    confirmRemove: false,
    dailyGoal: 0,
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...base, ...(JSON.parse(raw) as Partial<Prefs>) } : base;
  } catch {
    return base;
  }
}

let prefs: Prefs = loadPrefs();

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 存不下就只在本次生效 */
  }
}

function applyPrefsToChrome(): void {
  document.body.classList.toggle("narrow-margin", !prefs.unifiedMargin);
}

const settingsView = $<HTMLElement>("#settingsView");
const setFontSize = $<HTMLSelectElement>("#setFontSize");
const setLineHeight = $<HTMLSelectElement>("#setLineHeight");
const setFont = $<HTMLSelectElement>("#setFont");
const setTheme = $<HTMLSelectElement>("#setTheme");
const setTransition = $<HTMLSelectElement>("#setTransition");
const setSpread = $<HTMLSelectElement>("#setSpread");
const setStartView = $<HTMLSelectElement>("#setStartView");
const setGoal = $<HTMLSelectElement>("#setGoal");

function opt(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

let settingsPageReady = false;

async function buildSettingsPage(): Promise<void> {
  if (settingsPageReady) return;
  settingsPageReady = true;

  for (const v of [80, 90, 100, 110, 120, 130, 140, 160]) setFontSize.appendChild(opt(String(v), `${v}%`));
  for (const v of [1.4, 1.55, 1.7, 1.85, 2]) setLineHeight.appendChild(opt(String(v), v.toFixed(2)));

  const fonts = await ensureFontList();
  setFont.appendChild(opt("", "系统默认"));
  for (const name of fonts) setFont.appendChild(opt(name, name));

  loadAiForm();
  syncSettingsPage();
}

function syncSettingsPage(): void {
  setFontSize.value = String(typo.fontSize);
  setLineHeight.value = String(typo.lineHeight);
  const cur = typo.font || "";
  if (!Array.from(setFont.options).some((o) => o.value === cur)) setFont.appendChild(opt(cur, cur || "系统默认"));
  setFont.value = cur;
  setTheme.value = typo.theme;
  setTransition.value = prefs.transition;
  setSpread.value = prefs.spread;
  setStartView.value = prefs.startView;
  setGoal.value = String(prefs.dailyGoal);
  for (const sw of Array.from(settingsView.querySelectorAll<HTMLElement>(".sp-switch"))) {
    const key = sw.dataset.pref as "unifiedMargin" | "confirmRemove";
    sw.setAttribute("aria-pressed", String(!!prefs[key]));
  }
}

function showSettings(pane = "reading"): void {
  libraryView.hidden = true;
  annView.hidden = true;
  readerView.hidden = true;
  insightView.hidden = true;
  settingsView.hidden = false;
  // 设置页自带「设置」标题，顶栏那条再去显示就重复了
  topline.hidden = true;
  libActions.hidden = true;
  homeActions.hidden = true;
  filterBar.hidden = true;
  viewTitle.textContent = "设置";
  void setWindowTitle("TauriView");
  for (const b of Array.from(document.querySelectorAll<HTMLElement>("#rail .rail-btn"))) b.classList.remove("active");
  railSettings.classList.add("active");
  document.body.classList.remove("reading");
  selectSettingsPane(pane);
  void buildSettingsPage();
}

function selectSettingsPane(pane: string): void {
  if (pane === "dictionary") { initDictionarySettings(); void refreshDictionarySettings(); }
  for (const item of Array.from(settingsView.querySelectorAll<HTMLElement>(".sn-item"))) {
    item.classList.toggle("on", item.dataset.pane === pane);
  }
  for (const p of Array.from(settingsView.querySelectorAll<HTMLElement>(".sp-pane"))) {
    p.hidden = p.dataset.pane !== pane;
  }
  if (pane === "listening") void refreshListeningSettings();
}

for (const item of Array.from(settingsView.querySelectorAll<HTMLElement>(".sn-item"))) {
  item.addEventListener("click", () => selectSettingsPane(item.dataset.pane ?? "reading"));
}

setFontSize.addEventListener("change", () => applyTypo({ ...typo, fontSize: Number(setFontSize.value) }));
setLineHeight.addEventListener("change", () => applyTypo({ ...typo, lineHeight: Number(setLineHeight.value) }));
setFont.addEventListener("change", () => applyTypo({ ...typo, font: setFont.value }));
setTheme.addEventListener("change", () => {
  applyTypo({ ...typo, theme: setTheme.value as Typography["theme"] });
  syncSettingsPage();
});
setTransition.addEventListener("change", () => {
  prefs.transition = setTransition.value as Prefs["transition"];
  savePrefs();
  syncSettingsPage();
});
setSpread.addEventListener("change", () => {
  prefs.spread = setSpread.value as Prefs["spread"];
  savePrefs();
  syncSettingsPage();
});
setStartView.addEventListener("change", () => {
  prefs.startView = setStartView.value as Prefs["startView"];
  savePrefs();
});
setGoal.addEventListener("change", () => {
  prefs.dailyGoal = Number(setGoal.value) || 0;
  savePrefs();
  renderGoal();
});

for (const sw of Array.from(settingsView.querySelectorAll<HTMLElement>(".sp-switch"))) {
  sw.addEventListener("click", () => {
    const key = sw.dataset.pref as "unifiedMargin" | "confirmRemove";
    prefs[key] = !prefs[key];
    savePrefs();
    applyPrefsToChrome();
    syncSettingsPage();
  });
}

function toggleSettings(from?: HTMLElement): void {
  settingsPop.hidden = !settingsPop.hidden;
  if (settingsPop.hidden) return;
  syncSettings();
  void fillFontSelect();
  // 阅读态的齿轮在工具栏上，贴着它弹；书架态仍用 CSS 的左下角定位
  if (document.body.classList.contains("reading")) {
    placeUnder(settingsPop, from ?? $<HTMLElement>("#readerSettings"));
  } else {
    settingsPop.style.top = "";
    settingsPop.style.right = "";
    settingsPop.style.left = "";
    settingsPop.style.bottom = "";
  }
}

railSettings.addEventListener("click", (e) => {
  e.stopPropagation();
  settingsPop.hidden = true;
  if (document.body.classList.contains("reading")) toggleSettings(railSettings);
  else showSettings("reading");
});

$<HTMLElement>("#readerSettings").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings($<HTMLElement>("#readerSettings"));
});

settingsPop.addEventListener("click", (e) => {
  e.stopPropagation();
  const t = e.target as HTMLElement;
  if (t.dataset.act === "fs-") applyTypo({ ...typo, fontSize: Math.max(80, typo.fontSize - 10) });
  else if (t.dataset.act === "fs+") applyTypo({ ...typo, fontSize: Math.min(180, typo.fontSize + 10) });
  else if (t.dataset.lh) applyTypo({ ...typo, lineHeight: Number(t.dataset.lh) });
  else if (t.dataset.theme) applyTypo({ ...typo, theme: t.dataset.theme as Typography["theme"] });
});

document.addEventListener("mousedown", (e) => {
  const t = e.target as Node | null;
  const settingsBtn = t instanceof Element ? t.closest("#railSettings, #readerSettings") : null;
  if (!settingsPop.hidden && t && !settingsPop.contains(t) && !settingsBtn) settingsPop.hidden = true;
});

/* ---------------- 启动 ---------------- */

/** 「下载」= 本机文件还在；文件被外部删掉时这里会标 false */
async function refreshAvailability(): Promise<void> {
  const books = listBooks();
  if (!isTauri) {
    for (const b of books) fileOk.set(b.id, true);
    return;
  }
  try {
    const fs: any = await import("@tauri-apps/plugin-fs");
    const path: any = await import("@tauri-apps/api/path");
    const base: string = await path.appDataDir();
    const dir = `${base.replace(/[\\/]+$/, "")}/books`;
    for (const b of books) {
      try {
        fileOk.set(b.id, await fs.exists(`${dir}/${b.id}.${b.kind}`));
      } catch {
        fileOk.set(b.id, false);
      }
    }
  } catch {
    for (const b of books) fileOk.set(b.id, true);
  }
}

async function boot(): Promise<void> {
  await initStorage();
  await refreshAvailability();
  applyPrefsToChrome();
  renderShelf();
  if (prefs.startView === "books") showShelfView("books");
  void backfillCovers();
  syncSettings();
  applyChrome();
  initAnnotationUI({
    listenFrom: (cfi) => { void listenFrom(cfi); },
    openDictionarySettings: () => { closeReader(); showSettings("dictionary"); },
    openAiSettings: () => { closeReader(); showSettings("ai"); },
    bookId: () => currentId,
    handle: annHandle,
    percent: () => lastPercent,
    chapterPath: (label) => chapterPath(label),
  });
  initListeningUI({
    current: () => {
      const book = listBooks().find(b => b.id === currentId);
      return book && handle ? { book, reader: handle as EpubHandle } : null;
    },
    locate: async (id, cfi) => {
      if (currentId === id && !readerView.hidden && handle && 'display' in handle) handle.display(cfi);
      else await openBook(id, cfi);
    },
    settings: () => { closeReader(); showSettings("listening"); },
  });
  // 标注按钮 = 全部；书签按钮 = 只看书签（Aquile 的两个入口）
  // 标注按钮：面板已开且当前就是标注 → 收起；否则切到标注
  $<HTMLElement>("#annBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (annPanelVisible() && annCurrentFilter() !== "bm") {
      $<HTMLElement>("#annPanel").hidden = true;
    } else {
      annOpen("all");
    }
  });
  // 书签按钮：已开且就是书签 → 收起；否则切到书签（不与标注混排）
  $<HTMLElement>("#bmBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (annPanelVisible() && annCurrentFilter() === "bm") {
      $<HTMLElement>("#annPanel").hidden = true;
    } else {
      annOpen("bm");
    }
  });
  continueHero.addEventListener("click", () => {
    const recent = lastRead();
    if (recent) void openBook(recent.id);
  });
  (window as any).__tauriview = { importBytes, openBook, listBooks, showLibrary, measureEpubPages };
}

void boot();

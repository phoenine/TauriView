import ePub, { Book, Rendition, EpubCFI } from "epubjs";
import type { Highlight } from "../storage";
import { capturePassageContext, type PassageContext } from "../ai/context";
import { speechSegments } from "../listening/segments";
import type { SpeechChapter } from "../listening/types";
import { attachNoteMarker } from "./note-marker";

/** 阅读主题 */
export type ReaderTheme = "light" | "sepia" | "dark";

export type FontKey = "system" | "serif" | "sans" | "kai";

/** 字体族：中英文各给几个能落地的选择，避免依赖没装的花体 */
export const FONT_STACKS: Record<FontKey, string> = {
  system: '"Segoe UI", "Microsoft YaHei", Georgia, serif',
  serif: 'Georgia, "Source Han Serif SC", "Noto Serif SC", SimSun, serif',
  sans: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  kai: 'KaiTi, STKaiti, "Kaiti SC", "Microsoft YaHei", serif',
};

export interface Typography {
  /** 字号百分比，100 = 16px */
  fontSize: number;
  /** 行高倍数 */
  lineHeight: number;
  theme: ReaderTheme;
  /** 字体：具体的 CSS 字体族，或旧版的 system/serif/sans/kai */
  font: string;
}

export const DEFAULT_TYPO: Typography = { fontSize: 100, lineHeight: 1.7, theme: "light", font: FONT_STACKS.system };

/** 把「字体名」或旧 key 解析成可用的 font-family 值 */
export function resolveFont(font?: string): string {
  if (!font) return FONT_STACKS.system;
  if (font in FONT_STACKS) return FONT_STACKS[font as FontKey];
  const name = font.trim();
  if (!name) return FONT_STACKS.system;
  // 已经带引号或含逗号就当现成的字体栈
  if (name.includes(",") || name.startsWith('"') || name.startsWith("'")) return name;
  return `"${name}", ${FONT_STACKS.system}`;
}

export const READER_THEMES: Record<ReaderTheme, { bg: string; fg: string; link: string }> = {
  light: { bg: "#fbf9f4", fg: "#1d1d1f", link: "#2b6cb0" },
  sepia: { bg: "#f4ecd8", fg: "#4a3f2f", link: "#8a5a2b" },
  dark: { bg: "#1b1d22", fg: "#d7dbe3", link: "#6aa9ff" },
};

export interface SearchHit {
  sectionIndex: number;
  href: string;
  label: string;
  snippet: string;
  /** 在该章节文本中第几次出现（用于定位与高亮） */
  ordinal: number;
}

export interface TocEntry {
  label: string;
  href: string;
  level: number;
}

/** 高亮颜色：id → 填充色（与界面色板一致） */
/** 翻页动画类：按设置返回 slide / fade / null（不播） */
export function turnAnimClass(dir: number, mode: "slide" | "fade" | "none" = "slide"): string | null {
  if (mode === "none") return null;
  if (mode === "fade") return "turn-fade";
  return dir > 0 ? "turn-next" : "turn-prev";
}

export const HIGHLIGHT_COLORS: Record<string, string> = {
  "1": "#fdd835", // 黄
  "2": "#7ed957", // 绿
  "3": "#4da3ff", // 蓝
  "4": "#ff8ab4", // 粉
  "5": "#c08bff", // 紫
};

/**
 * 阅读引擎，两条路线：
 *  - 文字书：epub.js 分栏排版，宽窗口双栏跨页；页码靠「签名 → 每章页数」缓存
 *  - 图片书（漫画）：自排单页/双页，按需取图
 *
 * 漫画取图策略（方案 C）：
 *  1. 页数 = spine 长度，打开瞬间就确定，不需要先解析全书
 *  2. 图片路径「章节 → zip 内路径」懒解析：先解析当前跨页，其余后台补
 *  3. blob 只在需要时创建，LRU 保留最近 8 张（约 5 MB），不再为全书建 blob
 *  4. 解析结果（路径表）持久化，二次打开直接命中
 */

export interface EpubPagination {
  signature: string;
  perSpine: number[];
}

export interface EpubPageMap {
  sig: string;
  paths: string[];
  multi?: number[];
}

export interface EpubLocateInfo {
  cfi: string;
  percent: number;
  atStart: boolean;
  atEnd: boolean;
  label?: string;
  sectionIndex: number;
  pageInSection: number;
  pagesInSection: number;
  globalPage: number;
  totalPages: number;
  imageBook: boolean;
  spread: boolean;
}

export interface EpubOptions {
  startCfi?: string;
  cachedPagination?: EpubPagination;
  /** 漫画路径缓存；sig 不匹配时忽略 */
  cachedPageMap?: EpubPageMap;
  /** 本书的缓存签名（通常用文件字节数） */
  pageMapSig?: string;
  /** 已有标注（文字书用于恢复高亮） */
  highlights?: Highlight[];
  /** 字号 / 行距 / 主题 */
  typography?: Typography;
  /** 翻页过渡：slide 位移 / fade 淡入 / none 无动画 */
  transition?: "slide" | "fade" | "none";
  /** true = 永远单栏（关闭双页） */
  singleColumn?: boolean;
  /** 用户选中文本，弹出工具栏；rect 为应用坐标系 */
  onSelect?(sel: { cfi: string; text: string; passage?: PassageContext; rect: { left: number; top: number; width: number; height: number } }): void;
  /** 点击某条已有高亮 */
  onHighlightClick?(id: string): void;
  /** 悬停高亮；坐标统一为应用视口坐标，null 表示移出。 */
  onHighlightHover?(hit: { id: string; rect: { left: number; top: number; width: number; height: number } } | null): void;
  /** 选区被清掉 / 在正文里点了别处：收起浮动色板 */
  onDeselect?(): void;
  onRelocated(info: EpubLocateInfo): void;
  onReady(info: { title: string; author: string }): void;
  onPagination(p: EpubPagination): void;
  onPageMap?(m: EpubPageMap): void;
  /** 首次可见页就绪（用于测首屏耗时） */
  onFirstPaint?(): void;
}

export interface EpubHandle {
  speechChapter?(options?: { cfi?: string; fromStart?: boolean }): Promise<SpeechChapter>;
  next(): void;
  prev(): void;
  destroy(): void;
  percent(): number;
  atStart(): boolean;
  atEnd(): boolean;
  totalPages(): number;
  globalPage(): number;
  pagination(): EpubPagination | null;
  /** 添加/更新一条高亮的渲染 */
  addHighlight(h: Highlight): void;
  removeHighlight(h: Highlight): void;
  /** 跳到某个 CFI（高亮定位） */
  display(cfi: string): void;
  /** 听书：高亮 / 清除当前朗读的段落（follow 时翻到该段所在页）；返回是否已绘制 */
  setListenHighlight(cfi: string | null, follow?: boolean): boolean;
  /** 当前章节标题（用于标注归类） */
  currentLabel(): string;
  /** 目录 */
  toc(): TocEntry[];
  /** 调整字号 / 行距 / 主题（内部会重算分页） */
  setTypography(t: Typography): void;
  /** 某个 CFI 在全书中的百分比（按当前分页计算，用于标注列表） */
  percentFor(cfi: string): number;
  /** 当前阅读位置的 CFI（书签用） */
  cfi(): string;
  /** 全文搜索（首次调用会建索引，onProgress 报进度） */
  search(
    query: string,
    onProgress?: (done: number, total: number) => void,
    opts?: { caseSensitive?: boolean; wholeWord?: boolean; scopeIndex?: number },
  ): Promise<SearchHit[]>;
  /** 跳到某条结果并在页面上标出来 */
  revealHit(hit: SearchHit, query: string): Promise<void>;
}

/** 单次 await 的超时保护：个别章节卡住不能拖死整个索引 */
const withTimeoutMs = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SPREAD_MIN_WIDTH = 1000; // 内缩 5% 后仍能在 1280 宽窗口给出双栏
const MIN_PAGE_WIDTH = 420;
/** blob 缓存上限：当前跨页前后各留几张 */
const BLOB_CACHE_MAX = 8;

const TEXT_CSS = `
  width: 100%;
  box-sizing: border-box;
  font: 16px/1.7 "Segoe UI", "Microsoft YaHei", Georgia, serif;
  color: #1d1d1f;
  background: #fbf9f4;
  padding: 0 8px;
`;

/** 分页签名：窗口尺寸 + 排版参数，任一变化都要重算页数 */
function signatureOf(el: HTMLElement, spread: boolean, typo?: Typography): string {
  const t = typo ? `@${typo.fontSize}/${typo.lineHeight}` : "";
  return `${Math.round(el.clientWidth)}x${Math.round(el.clientHeight)}${spread ? "/spread" : ""}${t}`;
}

/** 判断是不是「一图一页」的漫画/画册 */
async function detectImageBook(book: Book): Promise<boolean> {
  const items: any[] = (book.spine as any).spineItems ?? [];
  let imageChapters = 0;
  let textChapters = 0;
  for (const item of items.slice(0, 6)) {
    try {
      const doc: any = await book.load(item.href);
      const body = doc?.body;
      if (!body) continue;
      const textLen = (body.textContent || "").trim().length;
      const imgCount = body.querySelectorAll("img, svg image, image").length;
      if (imgCount >= 1 && textLen < 200) imageChapters++;
      else textChapters++;
    } catch {
      /* 单章读不出不影响判断 */
    }
  }
  return imageChapters > textChapters;
}

async function measureSpine(book: Book, width: number, height: number, typo?: Typography): Promise<number[]> {
  const css = typo
    ? TEXT_CSS.replace("font: 16px/1.7", `font: ${Math.round(16 * typo.fontSize / 100)}px/${typo.lineHeight}`)
    : TEXT_CSS;
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:${height}px;` +
    "overflow:hidden;visibility:hidden;pointer-events:none;";
  document.body.appendChild(host);

  const items: any[] = (book.spine as any).spineItems ?? [];
  const pages: number[] = [];
  try {
    for (let i = 0; i < items.length; i++) {
      try {
        const doc: any = await book.load(items[i].href);
        const html: string = doc?.body ? doc.body.innerHTML : String(doc ?? "");
        const box = document.createElement("div");
        box.style.cssText = css + `height:${height}px;overflow:hidden;`;
        box.innerHTML = html;
        host.appendChild(box);
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        pages.push(Math.max(1, Math.round(Math.max(box.scrollHeight, 1) / height)));
        host.removeChild(box);
      } catch {
        pages.push(1);
      }
      if (i % 4 === 3) await new Promise<void>((r) => setTimeout(r, 0));
    }
  } finally {
    host.remove();
  }
  return pages;
}

const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const idle = () => new Promise<void>((r) => setTimeout(r, 0));

/** 图片书：自排单页/双页 + 懒取图 + blob LRU */
async function openComic(
  container: HTMLElement,
  book: Book,
  opts: EpubOptions,
): Promise<EpubHandle> {
  const items: any[] = (book.spine as any).spineItems ?? [];
  const total = items.length;

  // 路径表：null 表示还没解析
  const sig = opts.pageMapSig ?? "";
  const cached = opts.cachedPageMap && opts.cachedPageMap.sig === sig ? opts.cachedPageMap : undefined;
  const paths: (string | null)[] =
    cached && cached.paths.length === total ? [...cached.paths] : new Array(total).fill(null);
  const multi = new Set<number>(cached?.multi ?? []);
  let remaining = paths.filter((p) => p === null).length;

  // zip 索引查询（不解压，只查是否存在）；不可用时退回 createUrl 校验
  let canQueryZip = false;
  try {
    const z = (book as any).archive?.zip;
    canQueryZip = !!(z && typeof z.file === "function");
  } catch {
    canQueryZip = false;
  }
  const zipHas = (p: string): boolean => {
    if (!canQueryZip || !p) return false;
    try {
      const f = (book as any).archive.zip.file(p);
      // JSZip 对目录也返回对象，必须排除目录项
      return !!(f && f.dir === false);
    } catch {
      return false;
    }
  };

  /** 规范化路径：消掉 ./ 与 ../，去掉前导斜杠 */
  const normalize = (p: string): string => {
    const out: string[] = [];
    for (const seg of p.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") { out.pop(); continue; }
      out.push(seg);
    }
    return out.join("/");
  };

  /** 单章解析超时保护：某章卡住不能拖死整个枚举 */
  const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

  /** 解析某一章的图片路径（优先用 zip 索引校验，避免为校验而解压图片） */
  const resolvePath = async (i: number): Promise<string | null> => {
    const item = items[i];
    if (!item) return null;
    try {
      const doc: any = await withTimeout(Promise.resolve(book.load(item.href)) as Promise<any>, 4000, null);
      if (!doc) { paths[i] = ""; return ""; }
      const body = doc?.body;
      const els = body ? Array.from(body.querySelectorAll("img, svg image, image")) as Element[] : [];
      if (!els.length) { paths[i] = ""; return ""; }

      // 一章多图：记下来（当前仍按 1 页处理，先暴露事实）
      if (els.length > 1) multi.add(i);

      const el: any = els[0];
      const raw: string =
        el.getAttribute?.("src") || el.getAttribute?.("xlink:href") || el.getAttribute?.("href") || "";
      if (!raw) { paths[i] = ""; return ""; }

      const dir = item.href.includes("/") ? item.href.slice(0, item.href.lastIndexOf("/")) : "";
      const joined = raw.startsWith("/") ? raw.slice(1) : dir ? `${dir}/${raw}` : raw;
      const root: string = (book as any).path?.directory || "";

      // 统一规范化：zip 里的键既不带前导斜杠，也不含 .. 段
      const candidates = Array.from(new Set([
        normalize(root + joined),
        normalize(joined),
        normalize(raw),
        normalize(root + raw),
      ])).filter(Boolean);
      let picked = "";
      if (canQueryZip) {
        for (const cand of candidates) {
          if (cand && zipHas(cand)) { picked = cand; break; }
        }
      }
      // zip 索引不可用（或索引里没命中）时，用 createUrl 试一次；它可能挂起，必须加超时
      if (!picked && !canQueryZip) {
        for (const cand of candidates) {
          if (!cand) continue;
          try {
            const url = await withTimeout(
              (book.archive as any).createUrl(cand, { base64: false }) as Promise<string>,
              1500,
              "",
            );
            if (url && String(url).startsWith("blob:")) {
              picked = cand;
              URL.revokeObjectURL(url);
              break;
            }
          } catch { /* 试下一个候选 */ }
        }
      }
      paths[i] = picked;
      return picked;
    } catch {
      paths[i] = "";
      return "";
    }
  };

  // blob LRU：直接读 zip 条目字节（不经过 epub.js 的 archive，后者在本类 EPUB 上会误报找不到文件）
  const blobs = new Map<number, string>();

  const readAsObjectUrl = async (path: string): Promise<string | undefined> => {
    const zip = (book as any).archive?.zip;
    if (zip && typeof zip.file === "function") {
      try {
        const entry = zip.file(path);
        if (entry && entry.dir === false) {
          const blob: Blob = await entry.async("blob");
          return URL.createObjectURL(blob);
        }
      } catch {
        /* 落到 epub.js 退路 */
      }
    }
    try {
      const url = await withTimeout(
        (book.archive as any).createUrl(path, { base64: false }) as Promise<string>,
        1500,
        "",
      );
      return url ? String(url) : undefined;
    } catch {
      return undefined;
    }
  };

  const getBlob = async (i: number): Promise<string | undefined> => {
    const hit = blobs.get(i);
    if (hit) { blobs.delete(i); blobs.set(i, hit); return hit; }
    if (!paths[i]) await resolvePath(i);
    const p = paths[i];
    if (!p) return undefined;
    const url = await readAsObjectUrl(p);
    if (!url) return undefined;
    blobs.set(i, url);
    while (blobs.size > BLOB_CACHE_MAX) {
      const first = blobs.entries().next().value as [number, string] | undefined;
      if (!first) break;
      blobs.delete(first[0]);
      URL.revokeObjectURL(first[1]);
    }
    return url;
  };

  let index = 0;
  const saved = opts.startCfi?.match(/^page-(\d+)$/);
  if (saved) index = Math.min(Math.max(parseInt(saved[1], 10), 0), Math.max(total - 1, 0));

  const stage = document.createElement("div");
  stage.className = "comic-stage";
  stage.style.cssText =
    "position:absolute;inset:0;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);" +
    "grid-template-rows:minmax(0,1fr);" +
    "gap:6px;background:#12161b;padding:6px;box-sizing:border-box;overflow:hidden;";
  container.innerHTML = "";
  container.appendChild(stage);

  let spread = false;
  let firstPaintDone = false;
  let enumerating = false;
  let paused = false;
  let disposed = false;

  const decideSpread = () => {
    spread = !opts.singleColumn && container.clientWidth >= SPREAD_MIN_WIDTH && container.clientWidth / 2 >= MIN_PAGE_WIDTH;
  };

  const emit = () => {
    const shown = spread ? 2 : 1;
    const info: EpubLocateInfo = {
      cfi: `page-${index}`,
      percent: total ? Math.min(1, (index + shown) / total) : 0,
      atStart: index <= 0,
      atEnd: index + shown >= total,
      label: `第 ${index + 1}${shown > 1 ? `-${Math.min(index + 2, total)}` : ""} 页`,
      sectionIndex: index,
      pageInSection: 1,
      pagesInSection: shown,
      globalPage: index + 1,
      totalPages: total,
      imageBook: true,
      spread,
    };
    opts.onRelocated(info);
  };

  let wheelLock = 0;
  const onWheel = (e: WheelEvent) => {
    if (disposed) return;
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(d) < 8) return;
    e.preventDefault();
    const now = Date.now();
    if (now < wheelLock) return;
    wheelLock = now + 320;
    stage.classList.remove("turn-next", "turn-prev", "turn-fade");
    const comicCls = turnAnimClass(d > 0 ? 1 : -1, opts.transition ?? "slide");
    if (comicCls) {
      void stage.offsetWidth;
      stage.classList.add(comicCls);
      window.setTimeout(() => stage.classList.remove(comicCls), 300);
    }
    index = Math.min(Math.max(index + (d > 0 ? (spread ? 2 : 1) : -(spread ? 2 : 1)), 0), Math.max(total - 1, 0));
    void paint();
  };
  stage.addEventListener("wheel", onWheel, { passive: false });

  const paint = async () => {
    if (disposed) return;
    paused = true;
    decideSpread();
    const shown = spread ? 2 : 1;
    stage.innerHTML = "";
    const cells: { box: HTMLElement; slot: HTMLElement }[] = [];

    for (let k = 0; k < shown; k++) {
      const cell = document.createElement("div");
      cell.style.cssText =
        "min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;";
      const slot = document.createElement("div");
      slot.style.cssText = "color:#7b8698;font-size:12px;";
      slot.textContent = "载入中…";
      cell.appendChild(slot);
      stage.appendChild(cell);
      cells.push({ box: cell, slot });
    }

    emit();

    for (let k = 0; k < shown; k++) {
      const idx = index + k;
      if (idx >= total) break;
      const url = await getBlob(idx);
      if (disposed) return;
      const cell = cells[k];
      if (!cell.box.isConnected) continue;
      if (!url) {
        cell.slot.textContent = "";
        continue;
      }
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.style.cssText = "max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block;";
      cell.box.replaceChildren(img);
      if (!firstPaintDone) {
        firstPaintDone = true;
        opts.onFirstPaint?.();
      }
    }

    paused = false;

    // 空闲预取下一跨页，连翻时几乎零等待
    const ahead = index + (spread ? 2 : 1);
    for (let k = 0; k < (spread ? 2 : 1); k++) {
      const idx = ahead + k;
      if (idx < total) {
        window.setTimeout(() => { if (!disposed) void getBlob(idx); }, 200);
      }
    }
  };

  /** 后台补全路径表（可被翻页暂停） */
  const enumerate = async () => {
    if (enumerating || !remaining) return;
    enumerating = true;
    for (let i = 0; i < total; i++) {
      if (disposed) break;
      if (paths[i] === null) {
        while (paused) await sleep(60); // 用户翻页时让路
        await resolvePath(i);
        remaining--;
      }
      if (i % 8 === 7) await idle();
    }
    enumerating = false;
    // 无论是否有极个别章节解析失败，都把当前结果落盘（失败项记为 ""）
    if (!disposed) {
      opts.onPageMap?.({
        sig,
        paths: paths.map((p) => p ?? ""),
        multi: Array.from(multi).sort((a, b) => a - b),
      });
    }
  };

  void paint();
  // 首屏就绪后再开始后台枚举，避免和首屏抢资源
  window.setTimeout(() => { void enumerate(); }, 600);

  const step = (dir: 1 | -1) => {
    const delta = (spread ? 2 : 1) * dir;
    const next = Math.min(Math.max(index + delta, 0), Math.max(total - 1, 0));
    if (next === index) return;
    index = next;
    void paint();
  };

  let resizeTimer: number | undefined;
  const onResize = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { void paint(); }, 220);
  };
  window.addEventListener("resize", onResize);

  return {
    next: () => step(1),
    prev: () => step(-1),
    percent: () => (total ? Math.min(1, (index + (spread ? 2 : 1)) / total) : 0),
    atStart: () => index <= 0,
    atEnd: () => index + (spread ? 2 : 1) >= total,
    totalPages: () => total,
    globalPage: () => index + 1,
    pagination: () => ({ signature: signatureOf(container, spread), perSpine: paths.map(() => 1) }),
    addHighlight: () => { /* 漫画为整页图，暂不支持文字高亮 */ },
    removeHighlight: () => { /* 同上 */ },
    setListenHighlight: () => false, /* 漫画没有可高亮的正文 */
    display: (cfi: string) => {
      const m = /^page-(\d+)$/.exec(cfi);
      if (!m) return;
      index = Math.min(Math.max(parseInt(m[1], 10), 0), Math.max(total - 1, 0));
      void paint();
    },
    currentLabel: () => `第 ${index + 1} 页`,
    cfi: () => `page-${index}`,
    search: async () => [],
    revealHit: async () => { /* 图片书没有可搜的文本 */ },
    toc: () => [],
    setTypography: () => { /* 漫画整页图，无排版参数 */ },
    percentFor: (cfi: string) => {
      const m = /^page-(\d+)$/.exec(cfi);
      const n = m ? parseInt(m[1], 10) : index;
      return total > 0 ? Math.min(1, (n + 1) / total) : 0;
    },
    destroy: () => {
      disposed = true;
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      for (const url of blobs.values()) URL.revokeObjectURL(url);
      blobs.clear();
      stage.innerHTML = "";
      try { book.destroy(); } catch { /* 已销毁 */ }
    },
  };
}

/** 文字书：epub.js 分栏 + 分页缓存 */
async function openText(
  container: HTMLElement,
  book: Book,
  opts: EpubOptions,
): Promise<EpubHandle> {
  // 正文舞台：四边内缩 5%（Aquile 的 --aq-content-side-margin），页脚就落在底部 5% 的留白里
  const stage = document.createElement("div");
  stage.className = "epub-page";
  container.innerHTML = "";
  container.appendChild(stage);

  const rendition: Rendition = book.renderTo(stage, {
    width: "100%",
    height: "100%",
    flow: "paginated",
    spread: "auto",
    minSpreadWidth: SPREAD_MIN_WIDTH,
    gap: 60, // 双栏间距，对齐 Aquile 的 --aq-column-gap
    allowScriptedContent: false,
  } as any); // gap 是运行时设置，epub.js 的类型定义里没有

  let typo: Typography = { ...DEFAULT_TYPO, ...(opts.typography ?? {}) };
  let gone = false;
  let highlightSyncFrame = 0;
  const syncHighlights = () => {
    if (gone || highlightSyncFrame) return;
    highlightSyncFrame = window.requestAnimationFrame(() => {
      highlightSyncFrame = 0;
      if (gone || stage.getAnimations().some(animation => animation.playState === "running")) return;
      // Annotation injection precedes theme/font injection in epub.js. Re-entry can
      // therefore retain pre-layout rectangles; render the existing ranges again.
      rendition.views().forEach((view: any) => view.pane?.render());
    });
  };
  stage.addEventListener("animationend", syncHighlights);
  stage.addEventListener("animationcancel", syncHighlights);

  /** 滚轮翻页：先占位，等后面再赋值；rendered 回调可能早于它初始化 */
  let onWheel: (e: WheelEvent) => void = () => {};

  /**
   * 主题不通过 themes.register / select 做：
   * epub.js 的命名主题是按 class 累积注入的，来回切换会残留上一个主题的规则，
   * 实测切回浅色后背景仍是深色。这里改成自己维护一张同名样式表，每次整表覆盖。
   */
  const themeCss = (t: Typography): string => {
    const th = READER_THEMES[t.theme];
    return [
      `html, body { background: ${th.bg} !important; color: ${th.fg} !important;` +
        ` font-family: ${resolveFont(t.font)} !important; }`,
      `a { color: ${th.link} !important; }`,
      `p { margin: 0 0 0.85em; }`,
      `img, svg { max-width: 100% !important; }`,
      `::selection { background: #00ada2 !important; color: #04241f !important; }`,
      // 听书：当前朗读的段落
      `.tv-listen { background: ${typo.theme === "dark" ? "rgba(0,173,162,.34)" : "rgba(0,173,162,.22)"} !important;` +
        ` border-radius: 3px; box-decoration-break: clone; -webkit-box-decoration-break: clone;` +
        ` transition: background .25s ease; }`,
    ].join("\n");
  };

  /** 把当前主题写进某个章节（不传则写进所有已渲染章节） */
  const paintTheme = (only?: any) => {
    const css = themeCss(typo);
    const list: any[] = only ? [only] : (rendition.getContents() as unknown as any[]);
    for (const c of list) {
      try {
        c.addStylesheetCss(css, "tv-theme");
      } catch {
        /* 章节还没就绪，等下一次 rendered 再写 */
      }
    }
  };

  // 每次渲染新章节都要补一次主题（新增章节不会继承上一章的 style 标签）
  rendition.on("rendered", (_section: any, view: any) => {
    paintTheme(view?.contents);
    syncHighlights();
    void view?.contents?.document?.fonts?.ready.then(syncHighlights);
    // 翻页/重排后把朗读段落的高亮补回来
    if (listenCfi) { listenEl = null; paintListen(listenCfi, false); }

    // 选区在 iframe 内部，外层收不到事件：在这里挂「选区被清空」和「点了别处」两种收起时机
    const doc: Document | undefined = view?.contents?.document;
    if (doc && !(doc as any).__tvDeselectBound) {
      (doc as any).__tvDeselectBound = true;
      doc.addEventListener("pointerdown", () => opts.onDeselect?.(), true);
      doc.addEventListener("wheel", onWheel, { passive: false });
      // marks-pane 的 SVG 不接收指针事件，从正文命中实际的逐行高亮矩形。
      doc.addEventListener("mousemove", (event) => {
        if (gone || event.buttons || !doc.getSelection()?.isCollapsed) {
          opts.onHighlightHover?.(null);
          return;
        }
        const frame = view.iframe.getBoundingClientRect();
        const x = frame.left + event.clientX;
        const y = frame.top + event.clientY;
        for (const item of Object.values(view.highlights ?? {}) as any[]) {
          for (const rect of item.mark.getClientRects() as DOMRect[]) {
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
              opts.onHighlightHover?.({ id: item.element.dataset.id, rect: {
                left: rect.left, top: rect.top, width: rect.width, height: rect.height,
              } });
              return;
            }
          }
        }
        opts.onHighlightHover?.(null);
      });
      doc.addEventListener("mouseleave", () => opts.onHighlightHover?.(null));
      doc.addEventListener("keydown", (event) => {
        if (event.key === "Escape") opts.onDeselect?.();
      });
      // 松手就出字板：不等 epub.js 的 250ms 防抖
      doc.addEventListener("mouseup", () => reportSelection(view?.contents));
      doc.addEventListener("selectionchange", () => {
        const sel = doc.getSelection?.();
        if (!sel || sel.isCollapsed || !String(sel).trim()) opts.onDeselect?.();
      });
    }
  });

  /* ---------- 滚轮翻页 + 翻页动画 ---------- */

  let wheelLock = 0;
  const playTurn = (dir: number) => {
    if (gone) return;
    const now = Date.now();
    if (now < wheelLock) return;
    wheelLock = now + 320;
    opts.onDeselect?.();
    stage.classList.remove("turn-next", "turn-prev", "turn-fade");
    const cls = turnAnimClass(dir, opts.transition ?? "slide");
    if (cls) {
      void stage.offsetWidth; // 强制重排，动画才能重播
      stage.classList.add(cls);
      window.setTimeout(() => stage.classList.remove(cls), 300);
    }
    if (dir > 0) void rendition.next();
    else void rendition.prev();
  };

  onWheel = (e: WheelEvent) => {
    if (gone) return;
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(d) < 8) return;
    e.preventDefault();
    playTurn(d > 0 ? 1 : -1);
  };
  stage.addEventListener("wheel", onWheel, { passive: false });

  /** 应用排版：主题 + 字号 + 行距 */
  const applyTypography = (t: Typography) => {
    typo = { ...t };
    rendition.themes.fontSize(`${t.fontSize}%`);
    rendition.themes.override("line-height", String(t.lineHeight));
    paintTheme();
    // 外框也跟着换色，避免页面边缘露出旧底色
    container.style.background = READER_THEMES[t.theme].bg;
    syncHighlights();
  };
  applyTypography(typo);

  let spread = !opts.singleColumn && stage.clientWidth >= SPREAD_MIN_WIDTH;
    let signature = signatureOf(stage, spread, typo);
  let pagination: EpubPagination | null =
    opts.cachedPagination?.signature === signature && opts.cachedPagination.perSpine?.length
      ? { ...opts.cachedPagination }
      : null;

  let last: EpubLocateInfo = {
    cfi: opts.startCfi || "", percent: 0, atStart: false, atEnd: false,
    sectionIndex: 0, pageInSection: 1, pagesInSection: 1,
    globalPage: 0, totalPages: pagination ? sum(pagination.perSpine) : 0,
    imageBook: false, spread,
  };

  const percentOf = (i: EpubLocateInfo) => {
    const totalPages = pagination ? sum(pagination.perSpine) : 0;
    return totalPages > 0 && i.globalPage > 0 ? Math.min(1, i.globalPage / totalPages) : 0;
  };

  rendition.on("relocated", (location: any) => {
    syncHighlights();
    opts.onDeselect?.();
    const start = location?.start ?? {};
    const sectionIndex: number = start.index ?? 0;
    const displayed = start.displayed ?? {};
    const pageInSection: number = displayed.page ?? 1;
    const pagesInSection: number = displayed.total ?? 1;

    let refined = false;
    if (pagination && pagesInSection > 0 && pagination.perSpine[sectionIndex] !== pagesInSection) {
      pagination.perSpine[sectionIndex] = pagesInSection;
      refined = true;
    }

    const before = pagination ? sum(pagination.perSpine.slice(0, sectionIndex)) : 0;
    const info: EpubLocateInfo = {
      cfi: start.cfi || "",
      percent: 0,
      atStart: !!location?.atStart,
      atEnd: !!location?.atEnd,
      label: start.href ? decodeURIComponent(start.href).split("/").pop() : undefined,
      sectionIndex, pageInSection, pagesInSection,
      globalPage: pagination ? before + pageInSection : 0,
      totalPages: pagination ? sum(pagination.perSpine) : 0,
      imageBook: false, spread,
    };
    info.percent = percentOf(info);
    last = info;
    opts.onRelocated(info);
    if (refined && pagination) opts.onPagination({ ...pagination, perSpine: [...pagination.perSpine] });
  });

  await rendition.display(opts.startCfi || undefined);
  opts.onFirstPaint?.();

  /* ---------- 高亮 / 笔记 ---------- */

  /** 把 CFI 范围的首端提取出来，用于跳转 */
  const startCfiOf = (cfi: string): string => {
    const m = /^epubcfi\((.+)\)$/.exec(cfi.trim());
    if (!m) return cfi;
    const body = m[1];
    if (body.startsWith("(") && body.endsWith(")")) {
      const first = body.slice(1, -1).split(",")[0];
      return `epubcfi(${first})`;
    }
    return cfi;
  };

  const applied = new Map<string, Highlight>();
  const noteMarkers = new Map<string, () => void>();
  const removeNoteMarker = (cfi: string) => { noteMarkers.get(cfi)?.(); noteMarkers.delete(cfi); };
  /** 听书高亮：直接给段落加 class（epub.js 的 annotations.highlight 只接受范围 CFI，
      我们分段拿到的是点 CFI，传进去会被静默忽略） */
  let listenCfi: string | null = null;
  let listenEl: HTMLElement | null = null;

  const clearListen = () => {
    if (listenEl) { listenEl.classList.remove("tv-listen"); listenEl = null; }
    // 章节重渲染后旧引用失效，兜底清一遍
    for (const c of ((rendition.getContents() as unknown as any[]) ?? [])) {
      try { c.document?.querySelectorAll(".tv-listen").forEach((e: Element) => e.classList.remove("tv-listen")); }
      catch { /* 章节未就绪 */ }
    }
  };

  const followListen = (cfi: string) => {
    void rendition.display(cfi).then(() => {
      if (gone || listenCfi !== cfi) return;
      clearListen();
      paintListen(cfi, false);
    }).catch(() => { /* 章节已关闭或切换 */ });
  };

  /** 在当前渲染的章节里给该 CFI 所在段落打上 class；返回是否找到 */
  const paintListen = (cfi: string, follow: boolean): boolean => {
    const contents = ((rendition.getContents() as unknown as any[]) ?? []);
    for (const c of contents) {
      let range: Range | null = null;
      try { range = c.range?.(cfi) ?? null; } catch { range = null; }
      if (!range) continue;
      const node = range.startContainer;
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      // 只认段落级元素：加 div/td 会把整块容器染色
      const block = (el?.closest("p,li,blockquote,h1,h2,h3,h4,h5,h6,dd") ?? el) as HTMLElement | null;
      if (!block) continue;
      block.classList.add("tv-listen");
      listenEl = block;
      if (!follow) return true;
      // 长段落的边界会横跨多页；只检查当前朗读片段的 CFI 起点。
      // iframe 宽达整章，将局部坐标换算到外层正文舞台后判断是否可见。
      const point = range.cloneRange();
      point.collapse(true);
      const rect = point.getBoundingClientRect();
      const frame = (c.document?.defaultView?.frameElement ?? null) as HTMLElement | null;
      const fr = frame?.getBoundingClientRect();
      const viewport = stage.getBoundingClientRect();
      let offScreen: boolean;
      if (fr) {
        const left = fr.left + rect.left;
        const top = fr.top + rect.top;
        offScreen = left + rect.width < viewport.left - 1 || left > viewport.right + 1 || top + rect.height < viewport.top - 1 || top > viewport.bottom + 1;
      } else {
        const width = c.document?.documentElement?.clientWidth ?? window.innerWidth;
        offScreen = rect.right <= 1 || rect.left >= width - 1;
      }
      if (offScreen) {
        followListen(cfi);
      }
      return true;
    }
    return false;
  };

  const paintHighlight = (h: Highlight) => {
    if (!h.cfi) return;
    const fill = HIGHLIGHT_COLORS[h.color] ?? HIGHLIGHT_COLORS["1"];
    try {
      // 深色主题下 multiply 会把高亮压成黑块，改成 screen 提亮
      const blend = typo.theme === "dark" ? "screen" : "multiply";
      const annotation = rendition.annotations.highlight(
        h.cfi,
        { id: h.id },
        () => opts.onHighlightClick?.(h.id),
        "tv-highlight",
        { fill, "fill-opacity": typo.theme === "dark" ? "0.32" : "0.4", "mix-blend-mode": blend },
      ) as any;
      const attach = (mark: any) => {
        removeNoteMarker(h.cfi);
        if (!h.note?.trim() || !mark?.element) return;
        noteMarkers.set(h.cfi, attachNoteMarker(mark, h.id, {
          click: () => opts.onHighlightClick?.(h.id),
          hover: rect => opts.onHighlightHover?.(rect ? { id: h.id, rect } : null),
        }));
      };
      annotation.on('attach', attach);
      annotation.on('detach', () => removeNoteMarker(h.cfi));
      attach(annotation.mark);
      applied.set(h.cfi, h);
      syncHighlights();
    } catch {
      /* 该 CFI 所在章节尚未渲染，忽略 */
    }
  };

  const unpaintHighlight = (h: Highlight) => {
    removeNoteMarker(h.cfi);
    try { rendition.annotations.remove(h.cfi, "highlight"); } catch { /* 未标注过 */ }
    applied.delete(h.cfi);
  };

  /** 重画所有高亮：尺寸/排版一变，epub.js 覆盖层里的坐标就旧了 */
  const repaintHighlights = () => {
    for (const h of [...applied.values()]) {
      unpaintHighlight(h);
      paintHighlight(h);
    }
  };

  for (const h of opts.highlights ?? []) paintHighlight(h);

  /**
   * 上报当前选区。epub.js 的 selected 事件自带 250ms 防抖（selectionchange 里 setTimeout 250），
   * 划完线要等这么久色板才出来，手感很钝；所以 mouseup 时自己算一次 CFI 立刻上报，
   * epub.js 的慢路径只留作兜底。
   */
  const reportSelection = (contents: any, knownCfi?: string): void => {
    try {
      const sel = contents?.window?.getSelection?.();
      if (!sel || sel.isCollapsed) {
        opts.onDeselect?.();
        return;
      }
      const text = String(sel).trim();
      if (!text) {
        opts.onDeselect?.();
        return;
      }

      const range = sel.getRangeAt(0);
      let cfi = knownCfi ?? "";
      if (!cfi) {
        const base = (contents as any)?.cfiBase ?? (contents as any)?.section?.cfiBase;
        if (!base) return; // 拿不到 cfiBase 就交给 epub.js 的兜底路径
        cfi = new EpubCFI(range, base).toString();
      }

      const r = range.getBoundingClientRect();
      const frame = contents?.document?.defaultView?.frameElement as HTMLElement | null;
      const base0 = frame ? frame.getBoundingClientRect() : ({ left: 0, top: 0 } as DOMRect);
      opts.onSelect?.({
        cfi,
        text,
        passage: capturePassageContext(range),
        rect: { left: base0.left + r.left, top: base0.top + r.top, width: r.width, height: r.height },
      });
    } catch {
      /* 选区读取失败就当作没有选中 */
    }
  };

  rendition.on("selected", (cfiRange: string, contents: any) => reportSelection(contents, cfiRange));

  /* ---------- 全文搜索 ---------- */

  interface IndexedSection {
    i: number;
    href: string;
    label: string;
    text: string;
  }

  let searchIndex: IndexedSection[] | null = null;
  let searchMarks: string[] = [];

  /** 建索引：逐章 load 后取纯文本，比每次搜索都重新解析便宜得多 */
  const buildSearchIndex = async (onProgress?: (done: number, total: number) => void): Promise<IndexedSection[]> => {
    if (searchIndex) return searchIndex;
    const items: any[] = (book.spine as any).spineItems ?? [];
    const out: IndexedSection[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const doc: any = await withTimeoutMs(Promise.resolve(book.load(items[i].href)) as Promise<any>, 4000, null);
        const text = doc?.body ? String(doc.body.textContent ?? "") : "";
        const label = (items[i].href.split("/").pop() ?? "").replace(/\.x?html?$/i, "");
        out.push({ i, href: items[i].href, label, text });
      } catch {
        /* 单章读不出就跳过，不影响其余章节命中 */
      }
      onProgress?.(i + 1, items.length);
      if (i % 6 === 5) await idle();
    }
    searchIndex = out;
    return out;
  };

  const clearSearchMarks = () => {
    for (const cfiStr of searchMarks) {
      try { rendition.annotations.remove(cfiStr, "highlight"); } catch { /* 章节已卸载 */ }
    }
    searchMarks = [];
  };

  /** 把一串文本拼成章节内的「第几次命中」，跳转时据此在 DOM 里定位 */
  const search = async (
    query: string,
    onProgress?: (done: number, total: number) => void,
    opts?: { caseSensitive?: boolean; wholeWord?: boolean; scopeIndex?: number; limit?: number },
  ): Promise<SearchHit[]> => {
    const q = query.trim();
    if (!q) return [];
    const idx = await buildSearchIndex(onProgress);
    const limit = opts?.limit ?? 200;
    const needleRaw = q.replace(/\s+/g, " ");
    const hay = (s: string) => (opts?.caseSensitive ? s : s.toLowerCase()).replace(/\s+/g, " ");
    const needle = opts?.caseSensitive ? needleRaw : needleRaw.toLowerCase();
    const hits: SearchHit[] = [];

    for (const sec of idx) {
      if (typeof opts?.scopeIndex === "number" && sec.i !== opts.scopeIndex) continue;
      const text = hay(sec.text);
      let from = 0;
      let ordinal = 0;
      while (hits.length < limit) {
        const at = text.indexOf(needle, from);
        if (at < 0) break;
        const before = at > 0 ? text[at - 1] : " ";
        const after = at + needle.length < text.length ? text[at + needle.length] : " ";
        const wordy = opts?.wholeWord ? !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after) : true;
        if (wordy) {
          const start = Math.max(0, at - 34);
          const end = Math.min(text.length, at + needle.length + 46);
          hits.push({
            sectionIndex: sec.i,
            href: sec.href,
            label: sec.label,
            snippet: `${start > 0 ? "…" : ""}${text.slice(start, at)}【${text.slice(at, at + needle.length)}】${text.slice(at + needle.length, end)}${end < text.length ? "…" : ""}`,
            ordinal: ordinal,
          });
          ordinal++;
        }
        from = at + Math.max(1, needle.length);
      }
      if (hits.length >= limit) break;
    }
    return hits;
  };

  /** 跳到某条结果，并把命中处标出来 */
  const revealHit = async (hit: SearchHit, query: string): Promise<void> => {
    clearSearchMarks();
    await rendition.display(hit.href);
    await new Promise<void>((r) => window.setTimeout(r, 150));

    const contents = (rendition.getContents() as unknown as any[])?.[0];
    const doc: Document | undefined = contents?.document;
    if (!doc?.body) return;

    // 拼接文本节点 → 与索引同样的空白归一化 → 找第 ordinal 次出现
    const nodes: Text[] = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      if (t.data) nodes.push(t);
    }
    const spans: { node: Text; start: number; end: number }[] = [];
    let concat = "";
    for (const n of nodes) {
      spans.push({ node: n, start: concat.length, end: concat.length + n.data.length });
      concat += n.data;
    }
    const pattern = query.trim().split(/\s+/).map(escapeRe).join("\\s+");
    let re: RegExp;
    try {
      re = new RegExp(pattern, "gi");
    } catch {
      return;
    }
    let m: RegExpExecArray | null = null;
    let seen = -1;
    for (let guard = 0; guard < 5000; guard++) {
      const next = re.exec(concat);
      if (!next) break;
      if (++seen === hit.ordinal) {
        m = next;
        break;
      }
      if (next.index === re.lastIndex) re.lastIndex++;
    }
    if (!m) return;

    const at = m.index;
    const posOf = (idx: number) => {
      const span = spans.find((s) => idx >= s.start && idx < s.end) ?? spans[spans.length - 1];
      return { node: span.node, offset: Math.max(0, Math.min(span.node.data.length, idx - span.start)) };
    };
    const startPos = posOf(at);
    const endPos = posOf(at + Math.max(0, m[0].length - 1));
    const range = doc.createRange();
    try {
      range.setStart(startPos.node, startPos.offset);
      range.setEnd(endPos.node, Math.min(endPos.node.data.length, endPos.offset + 1));
      const cfiRange = contents.cfiFromRange(range);
      rendition.annotations.highlight(cfiRange, { search: true }, () => {}, "tv-search-hit", {
        fill: "#ffb300",
        "fill-opacity": typo.theme === "dark" ? "0.34" : "0.45",
        "mix-blend-mode": typo.theme === "dark" ? "screen" : "multiply",
      });
      searchMarks.push(cfiRange);
    } catch {
      /* 标不出来也至少跳到了这一章 */
    }
    try {
      (startPos.node.parentElement ?? doc.body).scrollIntoView({ block: "center" });
    } catch {
      /* 个别视口不支持 */
    }
  };

  /**
   * 进/出全屏、拖窗口后要重画高亮：epub.js 只重排正文，
   * 覆盖层（SVG）里的坐标还是旧的。
   * 但重排是异步的 —— 立刻重画会被随后一次 re-render 打回旧位置，
   * 所以标记一个待重画标志，等布局稳定后再画。
   */
  let needRepaint = false;
  rendition.on("resized", () => {
    needRepaint = true;
    clearSearchMarks();
    window.setTimeout(() => {
      if (!needRepaint) return;
      repaintHighlights();
      needRepaint = false;
    }, 320);
  });

  // 重新分页/翻页结束后再兜一次，此时坐标才是最终的
  rendition.on("relocated", () => {
    if (!needRepaint) return;
    repaintHighlights();
    needRepaint = false;
  });

  const buildPagination = async () => {
    const perSpine = await measureSpine(book, stage.clientWidth, stage.clientHeight, typo);
    if (!perSpine.length) return;
    pagination = { signature: signatureOf(stage, spread, typo), perSpine };
    opts.onPagination({ ...pagination });
    if (needRepaint) {
      repaintHighlights();
      needRepaint = false;
    }
    const before = sum(perSpine.slice(0, last.sectionIndex));
    last = { ...last, globalPage: before + last.pageInSection, totalPages: sum(perSpine) };
    last.percent = percentOf(last);
    opts.onRelocated(last);
  };

  if (!pagination) void buildPagination().catch(() => { /* 失败就退回章节名进度 */ });

  let resizeTimer: number | undefined;
  const onResize = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      rendition.resize(stage.clientWidth, stage.clientHeight);
      const nextSpread = !opts.singleColumn && stage.clientWidth >= SPREAD_MIN_WIDTH;
      if (nextSpread !== spread) {
        spread = nextSpread;
        try { rendition.spread(spread ? "auto" : "none", SPREAD_MIN_WIDTH); } catch { /* 旧版忽略 */ }
        signature = signatureOf(stage, spread, typo);
        pagination = null;
        void buildPagination().catch(() => {});
      }
    }, 320);
  };
  window.addEventListener("resize", onResize);

  return {
    next: () => { void rendition.next(); },
    prev: () => { void rendition.prev(); },
    percent: () => last.percent || 0,
    atStart: () => last.atStart,
    atEnd: () => last.atEnd,
    totalPages: () => (pagination ? sum(pagination.perSpine) : 0),
    globalPage: () => last.globalPage,
    pagination: () => pagination,
    addHighlight: (h: Highlight) => { unpaintHighlight(h); paintHighlight(h); },
    removeHighlight: (h: Highlight) => { unpaintHighlight(h); },
    setListenHighlight: (cfi: string | null, follow = false) => {
      clearListen();
      listenCfi = cfi;
      if (!cfi) return true;
      if (paintListen(cfi, follow)) return true;
      // 不在当前章节：翻过去，等渲染完成后再画。
      if (follow) followListen(cfi);
      return false;
    },
    display: (cfi: string) => { void rendition.display(startCfiOf(cfi)); },
    currentLabel: () => last.label ?? "",
    speechChapter: async (options = {}) => {
      const anchor = options.cfi || last.cfi;
      const section = book.spine.get(anchor || last.sectionIndex);
      if (!section || gone) throw new Error("无法读取当前章节");
      // Read the unpaginated source, without highlight wrappers or layout-generated nodes.
      const doc = await book.load(section.href) as Document;
      if (gone) throw new Error("阅读位置已关闭，请重新选择");
      const compare = new EpubCFI().compare.bind(new EpubCFI());
      const segments = speechSegments(doc, range => new EpubCFI(range, section.cfiBase).toString(),
        anchor && !options.fromStart ? point => compare(point, anchor) : undefined);
      if (!segments.length) throw new Error("这一章没有可朗读的文字。");
      let startIndex = 0;
      if (anchor && !options.fromStart) {
        for (let i = 0; i < segments.length; i++) {
          if (compare(segments[i].cfi, anchor) <= 0) startIndex = i; else break;
        }
      }
      const label = (book.navigation as any)?.get(section.href)?.label?.trim() || doc.querySelector('h1,h2,h3')?.textContent?.trim() || last.label || "正文";
      return { href: section.href, label, segments, startIndex };
    },
    toc: () => {
      const out: TocEntry[] = [];
      const walk = (items: any[], level: number) => {
        for (const it of items ?? []) {
          if (it?.href) out.push({ label: String(it.label ?? "").trim(), href: it.href, level });
          if (it?.subitems?.length) walk(it.subitems, level + 1);
        }
      };
      walk((book.navigation as any)?.toc ?? [], 0);
      return out;
    },
    setTypography: (t: Typography) => {
      applyTypography(t);
      repaintHighlights();
      signature = signatureOf(stage, spread, typo);
      pagination = null;
      void buildPagination().catch(() => { /* 量不出来就退回章节名进度 */ });
      if (last.cfi) void rendition.display(last.cfi);
    },
    cfi: () => last.cfi,
    search: (q, onProgress, opts) => search(q, onProgress, opts),
    revealHit: (hit, q) => revealHit(hit, q),
    percentFor: (cfi: string) => {
      const m = /^epubcfi\(\/(\d+)\/(\d+)/.exec(cfi);
      if (!m) return 0;
      const spinePos = Math.max(0, parseInt(m[2], 10) / 2 - 1);
      if (!pagination) return spinePos / Math.max(1, (book.spine as any)?.length ?? 1);
      const total = sum(pagination.perSpine);
      if (!total) return 0;
      return Math.min(1, sum(pagination.perSpine.slice(0, spinePos)) / total);
    },
    destroy: () => {
      gone = true;
      window.cancelAnimationFrame(highlightSyncFrame);
      stage.removeEventListener("animationend", syncHighlights);
      stage.removeEventListener("animationcancel", syncHighlights);
      for (const cleanup of noteMarkers.values()) cleanup();
      noteMarkers.clear();
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      try { rendition.destroy(); } catch { /* 已销毁 */ }
      try { book.destroy(); } catch { /* 已销毁 */ }
    },
  };
}

/** 打开 EPUB：自动判断文字书 / 图片书 */
export async function openEpub(
  container: HTMLElement,
  bytes: ArrayBuffer,
  opts: EpubOptions,
): Promise<EpubHandle> {
  container.innerHTML = "";
  const book: Book = ePub(bytes);
  await book.ready;

  const meta: any = await book.loaded.metadata;
  opts.onReady({
    title: (meta?.title || "").trim(),
    author: (meta?.creator || "").trim() || "未知作者",
  });

  const imageBook = await detectImageBook(book);
  return imageBook ? openComic(container, book, opts) : openText(container, book, opts);
}

/** 只做分页测量（性能验证用） */
export async function measureEpubPages(
  bytes: ArrayBuffer,
  width: number,
  height: number,
): Promise<{ signature: string; perSpine: number[] }> {
  const book: Book = ePub(bytes);
  await book.ready;
  try {
    const imageBook = await detectImageBook(book);
    const items: any[] = (book.spine as any).spineItems ?? [];
    const perSpine = imageBook ? items.map(() => 1) : await measureSpine(book, width, height);
    return { signature: `${Math.round(width)}x${Math.round(height)}`, perSpine };
  } finally {
    try { book.destroy(); } catch { /* 已销毁 */ }
  }
}

/**
 * 从 EPUB 内取封面图字节。
 *
 * 不用 epub.js 的 coverUrl()：它要靠 archive.createUrl 建 blob URL，
 * 遇到部分书（例如这本漫画）会报 File not found，封面就空了。
 * 这里直接读 zip：container.xml → OPF → 按 5 条规则挑封面 →
 * 取该条目字节，全程不解压整包。
 */
export async function extractEpubCover(bytes: ArrayBuffer): Promise<Uint8Array | undefined> {
  let book: Book | undefined;
  try {
    book = ePub(bytes);
    await book.ready;
    const zip: any = (book as any).archive?.zip;
    if (!zip || typeof zip.file !== "function") return undefined;

    /** 规范化路径：消掉 ./ 与 ../，去掉前导斜杠 */
    const norm = (p: string): string => {
      const out: string[] = [];
      for (const seg of p.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") { out.pop(); continue; }
        out.push(seg);
      }
      return out.join("/");
    };
    const join = (base: string, href: string): string => {
      let h = href.trim();
      try { h = decodeURIComponent(h); } catch { /* 原样用 */ }
      return norm(h.startsWith("/") ? h.slice(1) : base + h);
    };
    const readText = async (p: string): Promise<string> => {
      const f = zip.file(p);
      return f && f.dir === false ? ((await f.async("string")) as string) : "";
    };
    /** 封面页（xhtml）里的第一张图 */
    const imagesInPage = async (pagePath: string): Promise<string[]> => {
      const html = await readText(pagePath);
      if (!html) return [];
      const dir = pagePath.includes("/") ? pagePath.slice(0, pagePath.lastIndexOf("/") + 1) : "";
      const out: string[] = [];
      for (const m of html.matchAll(/<img[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) out.push(join(dir, m[1]));
      for (const m of html.matchAll(/<image[^>]*\bxlink:href\s*=\s*["']([^"']+)["']/gi)) out.push(join(dir, m[1]));
      return out;
    };

    const container = await readText("META-INF/container.xml");
    const opfPathMatch = /<rootfile[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(container);
    if (!opfPathMatch) return undefined;
    const opfPath = norm(opfPathMatch[1]);
    const opf = await readText(opfPath);
    if (!opf) return undefined;
    const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

    const doc = new DOMParser().parseFromString(opf, "application/xml");
    const items = Array.from(doc.getElementsByTagName("item")).map((el) => {
      const href = el.getAttribute("href") ?? "";
      return {
        id: el.getAttribute("id") ?? "",
        type: el.getAttribute("media-type") ?? "",
        props: el.getAttribute("properties") ?? "",
        path: join(baseDir, href),
      };
    });
    const isImg = (t: string): boolean => /^image\//i.test(t);
    const coverId = Array.from(doc.getElementsByTagName("meta"))
      .find((m) => (m.getAttribute("name") ?? "").toLowerCase() === "cover")
      ?.getAttribute("content") ?? "";

    const candidates: string[] = [];

    // ① manifest 里 properties="cover-image"（EPUB3 标准写法）
    for (const it of items) if (isImg(it.type) && /\bcover-image\b/.test(it.props)) candidates.push(it.path);

    // ② <meta name="cover" content="id">（EPUB2 老写法，国内书最常见）
    if (coverId) {
      const it = items.find((x) => x.id === coverId);
      if (it && isImg(it.type)) candidates.push(it.path);
    }

    // ③ guide 的 type="cover"，href 可能是图片，也可能是封面页
    const guide = Array.from(doc.getElementsByTagName("reference"))
      .find((r) => (r.getAttribute("type") ?? "").toLowerCase() === "cover");
    if (guide) {
      const p = join(baseDir, guide.getAttribute("href") ?? "");
      const it = items.find((x) => x.path === p);
      if (it && isImg(it.type)) candidates.push(p);
      else if (/\.x?html?$/i.test(p)) candidates.push(...(await imagesInPage(p)));
    }

    // ④ 文件名里带 cover / front 的图片
    for (const it of items) if (isImg(it.type) && /(^|\/)(cover|front)/i.test(it.path)) candidates.push(it.path);

    // ⑤ spine 第一页里的第一张图（漫画常把封面做成纯图片页）
    const firstRef = doc.getElementsByTagName("itemref")[0]?.getAttribute("idref") ?? "";
    const firstItem = items.find((x) => x.id === firstRef);
    if (firstItem && /\.x?html?$/i.test(firstItem.path)) candidates.push(...(await imagesInPage(firstItem.path)));

    for (const p of candidates) {
      const f = zip.file(p);
      if (!f || f.dir !== false) continue;
      const buf: Uint8Array = await f.async("uint8array");
      // 太小的多半是分隔符/透明占位图
      if (buf && buf.length > 1024) return buf;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    try { book?.destroy(); } catch { /* 已销毁 */ }
  }
}

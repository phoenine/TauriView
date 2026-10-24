/**
 * 存储层：整个应用只有这一个模块碰持久化。
 *
 * 两套后端，同一套 API：
 *  - Tauri 运行时：书文件写到 %APPDATA%\TauriView\books\<id>.<ext>，
 *    元数据与进度写到同目录 library.json（人类可读、可备份、不受浏览器配额限制）
 *  - 浏览器（npm run dev）：书文件走 IndexedDB，元数据走 localStorage
 *
 * 上层 UI 只调 listBooks / upsertBook / putBytes / getBytes / setProgress，换后端不用改 UI。
 */

import { isTauri } from "./platform";

export type BookKind = "epub" | "pdf";

export interface BookMeta {
  id: string;
  title: string;
  author: string;
  kind: BookKind;
  size: number;
  addedAt: number;
  /** 文件修改时间（毫秒）。和 size 一起构成缓存签名，文件被换掉时缓存自动失效 */
  mtime?: number;
  /** Tauri 后端里是该书的绝对路径；浏览器后端里为空 */
  filePath?: string;
  /** EPUB 分页缓存：视口签名 → 每个 spine 文件的页数 */
  pagination?: { signature: string; perSpine: number[] };
  /** 漫画「章节 → 图片路径」缓存：sig 用文件字节数，书被替换时自动失效 */
  pageMap?: { sig: string; paths: string[]; multi?: number[] };
  /** 收藏（对应 Aquile 的 FavoriteBookList，按 id 记） */
  fav?: boolean;
  /** 分组名（对应 Aquile 的 FolderList，先按名字平铺） */
  folder?: string;
  /** 章节 href → 目录路径，让批注列表在不打开书时也能显示章节名 */
  tocMap?: Record<string, string>;
  /** 书名被用户手改过：再打开书时不要用 EPUB 里的元数据盖掉 */
  titleEdited?: boolean;
  /** 第一次改书名前的原标题，「恢复原标题」用 */
  originalTitle?: string;
}

interface ProgressEntry {
  loc?: string;
  percent?: number;
  at: number;
}

interface LibraryFile {
  version: 1;
  books: BookMeta[];
  progress: Record<string, ProgressEntry>;
}

const LIB_KEY = "tauriview.library.v1";
const PROGRESS_KEY = "tauriview.progress.v1";
const DB_NAME = "tauriview";
const STORE = "files";
const META_FILE = "library.json";

/* ================= Tauri 后端 ================= */

let nativeReady: Promise<{ fs: any; dir: string }> | null = null;

async function native() {
  if (!nativeReady) {
    nativeReady = (async () => {
      const fs: any = await import("@tauri-apps/plugin-fs");
      const path: any = await import("@tauri-apps/api/path");
      const base: string = await path.appDataDir();
      const dir = `${base.replace(/[\\/]+$/, "")}/books`;
      await fs.mkdir(dir, { recursive: true });
      return { fs, dir };
    })();
  }
  return nativeReady;
}

async function readLibraryFile(): Promise<LibraryFile> {
  const { fs, dir } = await native();
  const file = `${dir}/${META_FILE}`;
  try {
    if (!(await fs.exists(file))) return { version: 1, books: [], progress: {} };
    const parsed = JSON.parse(await fs.readTextFile(file)) as LibraryFile;
    return {
      version: 1,
      books: Array.isArray(parsed.books) ? parsed.books : [],
      progress: parsed.progress ?? {},
    };
  } catch {
    return { version: 1, books: [], progress: {} };
  }
}

let libraryWrites: Promise<void> = Promise.resolve();

function writeLibraryFile(data: LibraryFile): Promise<void> {
  // 在入队时取快照，防止排队期间内存里的对象继续发生变化。
  const snapshot = JSON.stringify(data, null, 2);
  const write = libraryWrites.then(async () => {
    const { fs, dir } = await native();
    const temp = `${dir}/${META_FILE}.tmp`;
    await fs.writeTextFile(temp, snapshot);
    await fs.rename(temp, `${dir}/${META_FILE}`);
  });
  // 单次失败仍交给调用方处理，但不能阻塞后续保存。
  libraryWrites = write.catch(() => {});
  return write;
}

/* ================= 浏览器后端 ================= */

async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains("covers")) db.createObjectStore("covers");
      if (!db.objectStoreNames.contains("annotations")) db.createObjectStore("annotations");
      if (!db.objectStoreNames.contains("bookmarks")) db.createObjectStore("bookmarks");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

function webLibrary(): BookMeta[] {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    return raw ? (JSON.parse(raw) as BookMeta[]) : [];
  } catch {
    return [];
  }
}

function webProgress(): Record<string, ProgressEntry> {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
  } catch {
    return {};
  }
}

/* ================= 对外 API ================= */

let books: BookMeta[] = [];
let progress: Record<string, ProgressEntry> = {};

/** 启动时调用一次：把书架与进度读进内存 */
export async function initStorage(): Promise<void> {
  if (isTauri) {
    const lib = await readLibraryFile();
    books = lib.books;
    progress = lib.progress;
  } else {
    books = webLibrary();
    progress = webProgress();
  }
}

export function listBooks(): BookMeta[] {
  return [...books].sort((a, b) => b.addedAt - a.addedAt);
}

export async function upsertBook(meta: BookMeta): Promise<void> {
  books = books.filter((b) => b.id !== meta.id);
  books.push(meta);
  if (isTauri) {
    await writeLibraryFile({ version: 1, books, progress });
  } else {
    localStorage.setItem(LIB_KEY, JSON.stringify(books));
  }
}

export async function removeBook(id: string): Promise<void> {
  const target = books.find((b) => b.id === id);
  books = books.filter((b) => b.id !== id);
  delete progress[id];

  if (isTauri) {
    if (target?.filePath) {
      try {
        const { fs } = await native();
        if (await fs.exists(target.filePath)) await fs.remove(target.filePath);
      } catch {
        /* 文件可能已被手动删除 */
      }
    }
    await writeLibraryFile({ version: 1, books, progress });
  } else {
    localStorage.setItem(LIB_KEY, JSON.stringify(books));
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    await idb("readwrite", (s) => s.delete(id)).catch(() => {});
  }
}

/** 写入书文件本体；Tauri 后端返回落盘绝对路径 */
export async function putBytes(id: string, bytes: ArrayBuffer, kind: BookKind): Promise<string | undefined> {
  if (isTauri) {
    const { fs, dir } = await native();
    const file = `${dir}/${id}.${kind}`;
    await fs.writeFile(file, new Uint8Array(bytes));
    return file;
  }
  await idb("readwrite", (s) => s.put(bytes, id));
  return undefined;
}

/* ================= 封面 ================= */

const COVER_STORE = "covers";

async function idbCover(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<any>): Promise<any> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(COVER_STORE, mode);
    const req = fn(t.objectStore(COVER_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export async function putCover(id: string, bytes: Uint8Array): Promise<void> {
  if (isTauri) {
    const { fs, dir } = await native();
    await fs.writeFile(`${dir}/${id}.cover`, bytes);
    return;
  }
  try {
    await idbCover("readwrite", (s) => s.put(new Blob([bytes as unknown as BlobPart]), id));
  } catch {
    /* 索引库没建 cover store 时忽略，卡片退回占位样式 */
  }
}

export async function getCoverUrl(id: string): Promise<string | undefined> {
  if (isTauri) {
    const { fs, dir } = await native();
    const file = `${dir}/${id}.cover`;
    if (!(await fs.exists(file))) return undefined;
    const bytes: Uint8Array = await fs.readFile(file);
    return URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
  }
  try {
    const blob = await idbCover("readonly", (s) => s.get(id));
    return blob ? URL.createObjectURL(blob as Blob) : undefined;
  } catch {
    return undefined;
  }
}

export async function getBytes(meta: BookMeta): Promise<ArrayBuffer | undefined> {
  if (isTauri) {
    const { fs, dir } = await native();
    // 先认记录里的路径，再退回书库规范路径：
    // scope 收紧到 $APPDATA 后，指向外部目录的老记录会读不到，规范路径还能兜住
    const candidates = [meta.filePath, `${dir}/${meta.id}.${meta.kind}`].filter(Boolean) as string[];
    for (const p of candidates) {
      try {
        if (!(await fs.exists(p))) continue;
        const bytes: Uint8Array = await fs.readFile(p);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      } catch {
        /* 越权或文件损坏，试下一个候选 */
      }
    }
    return undefined;
  }
  return idb<ArrayBuffer | undefined>("readonly", (s) => s.get(meta.id) as IDBRequest<ArrayBuffer | undefined>);
}

export async function setProgress(id: string, loc: string | undefined, percent: number | undefined): Promise<void> {
  progress[id] = { loc, percent, at: Date.now() };
  if (isTauri) {
    await writeLibraryFile({ version: 1, books, progress });
  } else {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  }
}

/**
 * 书文件的内容签名：大小 + 修改时间。
 * 只用大小的话，同尺寸的另一个文件会误命中旧的图片路径缓存。
 */
export async function fileSignature(meta: BookMeta): Promise<string> {
  if (isTauri) {
    const { fs, dir } = await native();
    const ext = meta.kind;
    try {
      const st = await fs.stat(`${dir}/${meta.id}.${ext}`);
      if (st?.mtime) {
        const t = new Date(st.mtime).getTime();
        return `${st.size ?? meta.size}:${Number.isFinite(t) ? t : 0}`;
      }
    } catch {
      /* 拿不到 stat 就退回记录里的值 */
    }
  }
  return `${meta.size}:${meta.mtime ?? meta.addedAt ?? 0}`;
}

export function getProgress(id: string): { loc?: string; percent?: number } {
  return progress[id] ?? {};
}

/** 单本最近阅读时间（「最近阅读」排序用，对应 Aquile 的 RecentBookList2） */
export function progressAt(id: string): number {
  return progress[id]?.at ?? 0;
}

/** 最近一次阅读记录：主页「继续阅读」用 */
export function lastRead(): { id: string; percent: number; at: number } | null {
  let best: { id: string; percent: number; at: number } | null = null;
  for (const [id, p] of Object.entries(progress)) {
    if (!p || !p.at) continue;
    if (!best || p.at > best.at) best = { id, percent: p.percent ?? 0, at: p.at };
  }
  return best;
}

export function newId(): string {
  return crypto.randomUUID();
}

/* ================= 标注（高亮 / 笔记） ================= */

export interface Highlight {
  dictionary?: import("./dictionary/stardict").DictionarySnapshot;
  id: string;
  /** EPUB CFI 范围字符串，例如 epubcfi(/6/6!/4/2/1:0,/6/6!/4/2/1:12) */
  cfi: string;
  /** 选中文本，用于列表展示与搜索 */
  text: string;
  /** 颜色 id：1 黄 2 绿 3 蓝 4 粉 5 紫 */
  color: string;
  note?: string;
  chapter?: string;
  percent?: number;
  /** 收藏这条高亮/批注（批注页「只显示收藏夹」用） */
  fav?: boolean;
  createdAt: number;
  updatedAt?: number;
}

export interface Bookmark {
  id: string;
  /** 书签位置（EPUB 为点 CFI，漫画为 page-N） */
  cfi: string;
  chapter?: string;
  percent: number;
  createdAt: number;
}

const ANN_STORE = "annotations";
const BM_STORE = "bookmarks";

async function idbAnnotations(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<any>): Promise<any> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(ANN_STORE, mode);
    const req = fn(t.objectStore(ANN_STORE));
    // put 成功不等于事务已提交；配额等错误可能在请求成功后才使事务中止。
    t.oncomplete = () => { db.close(); resolve(req.result); };
    t.onabort = () => { db.close(); reject(t.error ?? req.error ?? new Error("批注存储事务已中止")); };
    t.onerror = () => reject(t.error ?? req.error ?? new Error("批注存储失败"));
  });
}

function annotationsPath(id: string): string {
  return `${id}.annotations.json`;
}

export async function loadAnnotations(bookId: string): Promise<Highlight[]> {
  if (isTauri) {
    const { fs, dir } = await native();
    const file = `${dir}/${annotationsPath(bookId)}`;
    try {
      if (!(await fs.exists(file))) return [];
      const list = JSON.parse(await fs.readTextFile(file));
      return Array.isArray(list) ? (list as Highlight[]) : [];
    } catch {
      return [];
    }
  }
  try {
    const v = await idbAnnotations("readonly", (s) => s.get(bookId));
    return Array.isArray(v) ? (v as Highlight[]) : [];
  } catch {
    return [];
  }
}

function bookmarksPath(id: string): string {
  return `${id}.bookmarks.json`;
}

async function idbBookmarks(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<any>): Promise<any> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(BM_STORE, mode);
    const req = fn(t.objectStore(BM_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export async function loadBookmarks(bookId: string): Promise<Bookmark[]> {
  if (isTauri) {
    const { fs, dir } = await native();
    try {
      const file = `${dir}/${bookmarksPath(bookId)}`;
      if (!(await fs.exists(file))) return [];
      const list = JSON.parse(await fs.readTextFile(file));
      return Array.isArray(list) ? (list as Bookmark[]) : [];
    } catch {
      return [];
    }
  }
  try {
    const v = await idbBookmarks("readonly", (s) => s.get(bookId));
    return Array.isArray(v) ? (v as Bookmark[]) : [];
  } catch {
    return [];
  }
}

export async function saveBookmarks(bookId: string, list: Bookmark[]): Promise<void> {
  if (isTauri) {
    const { fs, dir } = await native();
    await fs.writeTextFile(`${dir}/${bookmarksPath(bookId)}`, JSON.stringify(list, null, 2));
    return;
  }
  try {
    await idbBookmarks("readwrite", (s) => s.put(list, bookId));
  } catch {
    /* 索引库写入失败不致命 */
  }
}

export async function saveAnnotations(bookId: string, list: Highlight[]): Promise<void> {
  if (isTauri) {
    const { fs, dir } = await native();
    await fs.writeTextFile(`${dir}/${annotationsPath(bookId)}`, JSON.stringify(list, null, 2));
    return;
  }
  await idbAnnotations("readwrite", (s) => s.put(list, bookId));
}

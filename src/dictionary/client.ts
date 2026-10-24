import { isTauri } from "../platform";
import { StarDictionary, normalizeQuery, type DictionaryEntry, type DictionaryInfo, type DictionaryKind } from "./stardict";
export type { DictionaryEntry, DictionaryInfo, DictionaryKind } from "./stardict";
const loaded = new Map<string, Promise<StarDictionary>>();
let manifest: Promise<DictionaryInfo[]> | undefined;
type Files = Record<string, Uint8Array>;
interface Stored { id: string; kind: DictionaryKind; files: Files }
async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core"); return invoke<T>(command, args);
}
async function dbAction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tauriview-dictionaries", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("packs", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("packs", mode), request = run(transaction.objectStore("packs"));
    transaction.oncomplete = () => { db.close(); resolve(request.result); };
    transaction.onabort = () => { db.close(); reject(transaction.error ?? request.error ?? new Error("词典存储失败")); };
    transaction.onerror = () => reject(transaction.error ?? request.error);
  });
}
async function expand(bytes: Uint8Array, compressed: boolean, max: number): Promise<Uint8Array> {
  if (!compressed) { if (bytes.length > max) throw new Error("词典文件过大"); return bytes; }
  const reader = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > max) { await reader.cancel(); throw new Error("解压后的词典文件过大"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; }
  return output;
}
async function parse(files: Files, info: Pick<DictionaryInfo, "id" | "kind" | "enabled" | "builtin">): Promise<StarDictionary> {
  if (!files.ifo || !(files.idx || files["idx.gz"]) || !(files.dict || files["dict.dz"])) throw new Error("缺少 .ifo、.idx 或 .dict 配套文件");
  const [index, data] = await Promise.all([
    expand(files.idx ?? files["idx.gz"], !files.idx, 128 * 1024 * 1024),
    expand(files.dict ?? files["dict.dz"], !files.dict, 1024 * 1024 * 1024),
  ]);
  return new StarDictionary(new TextDecoder("utf-8", { fatal: true }).decode(files.ifo), index, data, files.syn, info);
}
function preferences(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem("tauriview.dictionaries.enabled") ?? "{}"); } catch { return {}; }
}
async function builtinManifest(): Promise<DictionaryInfo[]> {
  if (!manifest) {
    manifest = (async () => {
      const response = await fetch("/dictionaries/manifest.json");
      if (!response.ok) throw new Error("无法读取内置词典清单");
      return response.json();
    })();
    void manifest.catch(() => { manifest = undefined; });
  }
  return manifest;
}
async function load(info: DictionaryInfo): Promise<StarDictionary> {
  let promise = loaded.get(info.id);
  if (!promise) {
    promise = (async () => {
      if (!info.builtin) {
        const stored = await dbAction<Stored>("readonly", (store) => store.get(info.id));
        if (!stored) throw new Error("本地词典已丢失，请重新导入");
        return parse(stored.files, info);
      }
      const files: Files = {};
      await Promise.all(["ifo", "idx.gz", "dict.dz", "syn"].map(async (extension) => {
        const response = await fetch(`/dictionaries/${info.id}/${info.id}.${extension}`);
        if (response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          // 部分静态服务器对 .gz 设置 Content-Encoding；fetch 已替我们解压了这一层。
          const decoded = response.headers.get("content-encoding")?.includes("gzip") && !(bytes[0] === 0x1f && bytes[1] === 0x8b);
          const name = decoded && extension === "idx.gz" ? "idx" : decoded && extension === "dict.dz" ? "dict" : extension;
          files[name] = bytes;
        }
      }));
      return parse(files, info);
    })();
    loaded.set(info.id, promise);
    void promise.catch(() => loaded.delete(info.id));
  }
  return promise;
}
export async function listDictionaries(): Promise<DictionaryInfo[]> {
  if (isTauri) return native("list_dictionaries");
  const [builtin, stored] = await Promise.all([builtinManifest(), dbAction<Stored[]>("readonly", (store) => store.getAll())]);
  const custom = await Promise.all(stored.map(async (pack) => (await load({ id: pack.id, kind: pack.kind, builtin: false, enabled: true } as DictionaryInfo)).info));
  const prefs = preferences();
  return [...builtin, ...custom].map((info) => ({ ...info, enabled: prefs[info.id] ?? true }));
}
export async function lookupDictionary(text: string): Promise<DictionaryEntry[]> {
  const query = normalizeQuery(text);
  if (!query || [...query].length > 80) throw new Error("请选择一个词或短语查询");
  if (isTauri) return native("lookup_dictionary", { query });
  const info = (await listDictionaries()).filter((pack) => pack.enabled).sort((a, b) => Number(b.kind === "idiom") - Number(a.kind === "idiom"));
  if (!info.length) throw new Error("没有启用的本地词典，请在设置中启用或导入词典");
  const result = await Promise.all(info.map(async (pack) => (await load(pack)).lookup(query)));
  return result.flat();
}
export async function setDictionaryEnabled(id: string, enabled: boolean): Promise<void> {
  if (isTauri) return native("set_dictionary_enabled", { id, enabled });
  localStorage.setItem("tauriview.dictionaries.enabled", JSON.stringify({ ...preferences(), [id]: enabled }));
}
export async function importNativeDictionary(path: string, kind: DictionaryKind): Promise<DictionaryInfo> {
  return native("import_dictionary", { path, kind });
}
export async function importBrowserDictionary(selected: FileList | File[], kind: DictionaryKind): Promise<DictionaryInfo> {
  const files = Array.from(selected);
  const ifos = files.filter((file) => /\.ifo$/i.test(file.name));
  if (ifos.length !== 1) throw new Error("每次请选择一套词典的 .ifo、.idx、.dict 等配套文件");
  const base = ifos[0].name.slice(0, -4).toLowerCase(), parts: Files = {};
  for (const file of files) {
    if (file.size > 1024 * 1024 * 1024) throw new Error("词典文件超过 1 GiB");
    if (!file.name.toLowerCase().startsWith(base + ".")) continue;
    const extension = file.name.slice(base.length + 1).toLowerCase();
    if (["ifo", "idx", "idx.gz", "dict", "dict.dz", "syn"].includes(extension)) parts[extension] = new Uint8Array(await file.arrayBuffer());
  }
  const id = "custom-" + crypto.randomUUID();
  const dictionary = await parse(parts, { id, kind, builtin: false, enabled: true });
  await dbAction("readwrite", (store) => store.put({ id, kind, files: parts }));
  loaded.set(id, Promise.resolve(dictionary)); return dictionary.info;
}

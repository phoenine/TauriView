export type DictionaryKind = "english" | "chinese" | "idiom";
export interface DictionaryInfo {
  id: string; name: string; kind: DictionaryKind; count: number; version: string; source: string; enabled: boolean; builtin: boolean;
}
export interface DictionarySection { format: "text" | "phonetic" | "html" | "xdxf"; text: string }
export interface DictionaryEntry {
  word: string; dictionary: string; dictionaryId: string; kind: DictionaryKind; source: string; version: string; sections: DictionarySection[];
}
export interface DictionarySnapshot {
  word: string; name: string; version: string; source: string; pronunciation: string; definition: string;
  pronunciationSource?: string;
}
const decoder = new TextDecoder("utf-8", { fatal: true });
export function normalizeQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "").replace(/\s+/g, " ");
}
export function wordCandidates(value: string): string[] {
  const word = normalizeQuery(value).toLowerCase();
  const words = [word];
  if (/^[a-z'-]+$/.test(word) && word.length > 3) {
    for (const suffix of ["s", "es", "ed", "ing"]) {
      if (!word.endsWith(suffix)) continue;
      const stem = word.slice(0, -suffix.length);
      if (stem.length < 2) continue;
      words.push(stem);
      if (suffix === "ed" || suffix === "ing") {
        words.push(stem + "e");
        if (stem.at(-1) === stem.at(-2)) words.push(stem.slice(0, -1));
      }
    }
    for (const suffix of ["ies", "ied"]) if (word.endsWith(suffix)) words.push(word.slice(0, -3) + "y");
  }
  return [...new Set(words)];
}
class Cursor {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.at + length > this.bytes.length) throw new Error("词典数据被截断或长度越界");
    const value = this.bytes.subarray(this.at, this.at + length); this.at += length; return value;
  }
  zero(): Uint8Array {
    const end = this.bytes.indexOf(0, this.at);
    if (end < 0) throw new Error("词典文本缺少结束符");
    const value = this.take(end - this.at); this.at++; return value;
  }
  number(length: number): number {
    const result = this.take(length).reduce((n, byte) => n * 256 + byte, 0);
    if (!Number.isSafeInteger(result)) throw new Error("词典偏移超过支持范围");
    return result;
  }
}
export function parseSections(bytes: Uint8Array, sequence: string): DictionarySection[] {
  const cursor = new Cursor(bytes), sections: DictionarySection[] = [];
  let index = 0;
  while (cursor.at < bytes.length || (!!sequence && index < sequence.length)) {
    const type = sequence ? sequence[index] : String.fromCharCode(cursor.number(1));
    if (!type || !/^[a-z]$/i.test(type)) throw new Error("词条类型无效");
    const last = !!sequence && index === sequence.length - 1;
    const data = last ? cursor.take(bytes.length - cursor.at)
      : type === type.toUpperCase() ? cursor.take(cursor.number(4)) : cursor.zero();
    if (type === type.toLowerCase()) sections.push({
      format: type === "t" ? "phonetic" : type === "h" || type === "g" ? "html" : type === "x" ? "xdxf" : "text",
      text: decoder.decode(data),
    });
    index++;
  }
  if (sequence && index !== sequence.length) throw new Error("词条类型数量不匹配");
  return sections;
}
export class StarDictionary {
  readonly info: DictionaryInfo;
  readonly keys = new Map<string, number[]>();
  private entries: { word: string; offset: number; size: number }[] = [];
  private sequence: string;
  constructor(ifo: string, index: Uint8Array, private data: Uint8Array, synonyms: Uint8Array | undefined, info: Pick<DictionaryInfo, "id" | "kind" | "builtin" | "enabled">) {
    const [magic, ...lines] = ifo.replace(/^\uFEFF/, "").split(/\r?\n/);
    if (magic !== "StarDict's dict ifo file") throw new Error("不是 StarDict 词典");
    const meta = Object.fromEntries(lines.filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    if (!["2.4.2", "3.0.0"].includes(meta.version)) throw new Error("仅支持 StarDict 2.4.2 / 3.0.0");
    const bits = meta.idxoffsetbits ?? "32";
    if (!["32", "64"].includes(bits) || Number(meta.idxfilesize) !== index.length) throw new Error("词典索引信息不匹配");
    if (!meta.bookname) throw new Error("缺少词典名称");
    this.sequence = meta.sametypesequence ?? "";
    const add = (word: string, id: number) => {
      const key = normalizeQuery(word).toLowerCase();
      this.keys.set(key, [...(this.keys.get(key) ?? []), id]);
    };
    const cursor = new Cursor(index);
    while (cursor.at < index.length) {
      const word = decoder.decode(cursor.zero()), offset = cursor.number(Number(bits) / 8), size = cursor.number(4);
      if (!word || size > 2 * 1024 * 1024 || offset + size > data.length) throw new Error("词条偏移或长度越界");
      add(word, this.entries.length); this.entries.push({ word, offset, size });
    }
    if (Number(meta.wordcount) !== this.entries.length) throw new Error("词条数量与索引不符");
    if (synonyms) {
      const cursor = new Cursor(synonyms); let count = 0;
      while (cursor.at < synonyms.length) {
        const word = decoder.decode(cursor.zero()), target = cursor.number(4);
        if (target >= this.entries.length) throw new Error("别名索引越界");
        add(word, target); count++;
      }
      if (Number(meta.synwordcount) !== count) throw new Error("别名数量与索引不符");
    }
    this.info = { ...info, name: meta.bookname, count: this.entries.length, version: meta.date ?? "", source: meta.website ?? "" };
  }
  lookup(query: string): DictionaryEntry[] {
    const forms = wordCandidates(query);
    const candidates = this.keys.has(forms[0]) ? [forms[0]] : forms;
    const matches = [...new Set(candidates.flatMap((word) => this.keys.get(word) ?? []))].slice(0, 8);
    return matches.map((id) => {
      const entry = this.entries[id];
      return { word: entry.word, dictionary: this.info.name, dictionaryId: this.info.id, kind: this.info.kind,
        source: this.info.source, version: this.info.version,
        sections: parseSections(this.data.subarray(entry.offset, entry.offset + entry.size), this.sequence) };
    });
  }
}

/** 词典原文只转为安全文本，绝不挂载其中的脚本、样式、链接或图片。 */
export function sectionText(section: DictionarySection): string {
  if (section.format === "text" || (section.format === "phonetic" && !section.text.includes("<"))) return section.text;
  const template = document.createElement("template");
  template.innerHTML = section.text;
  template.content.querySelectorAll("script,style,iframe,object,embed,link,img,audio,video,source").forEach((node) => node.remove());
  template.content.querySelectorAll("br,p,div,li,def,ex,tr").forEach((node) => node.append("\n"));
  return (template.content.textContent ?? "").replace(/\n\s*\n+/g, "\n\n").trim();
}

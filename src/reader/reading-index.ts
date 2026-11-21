import { CHAPTER_FOLLOWING_LIMIT, type ContextExcerpt } from "../ai/context";
import { loadReadingIndex, saveReadingIndexSection, type ReadingIndexEntry } from "../storage";
import type { ReadingChapterEnd } from "./reading-chapter";

export interface ReadingBlock {
  text: string;
  heading: string;
  kind: "heading" | "paragraph" | "list";
  items?: number;
}

const OMIT = 'script, style, noscript, nav, rt, rp, [hidden], [aria-hidden="true"], [style*="display:none"], [style*="display: none"]';
const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, blockquote, div, td, pre";
const LIST_NUMBER = /^(?:第[一二三四五六七八九十\d]+[条项点]|[一二三四五六七八九十\d]+[、.．）)]|[（(][一二三四五六七八九十\d]+[）)])/u;
const NEAR_LIMIT = 2100;
const MATERIAL_LIMIT = 6000;
const FILTER_WORDS = 256;
const CACHE_SECTIONS = 6;
const PREFETCH_SECTIONS = 4;
const PREVIOUS_SECTIONS = 24;
const FOLLOWING_SECTIONS = 4;
const SOURCE_TIMEOUT = 1500;
const LOOKUP_TIMEOUT = 2500;
const words = new Intl.Segmenter("zh", { granularity: "word" });
const yieldWork = () => new Promise<void>(resolve => window.setTimeout(resolve, 0));

function clean(value: string): string {
  return value.replace(/[\u00ad\u200b]/g, "").replace(/\s+/gu, " ").trim();
}

function searchable(value: string): string {
  return clean(value).normalize("NFKC").toLowerCase();
}

/** Read original text blocks, keeping a list and its enclosing heading together for retrieval. */
export async function readingBlocks(root: DocumentFragment | Element, active = () => true): Promise<ReadingBlock[]> {
  if (!active()) return [];
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.nodeType === Node.TEXT_NODE || (node as Element).localName === "br"
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  const result: ReadingBlock[] = [];
  let owner: Element | null = null;
  let list: Element | null = null;
  let fragments: string[] = [];
  let entries: string[] = [];
  let heading = "";
  let visited = 0;
  const flush = () => {
    const text = fragments.join("").split("\n").map(clean).filter(Boolean).join("\n");
    fragments = [];
    if (!text) return;
    if (list) entries.push(text);
    else if (/^h[1-6]$/u.test(owner?.localName ?? "")) {
      heading = text.slice(0, 160);
      result.push({ kind: "heading", heading, text });
    } else result.push({ kind: "paragraph", heading, text });
  };
  const flushList = () => {
    if (entries.length) result.push({ kind: "list", heading, text: entries.join("\n"), items: entries.length });
    entries = [];
  };
  for (let item = walker.nextNode(); item; item = walker.nextNode()) {
    if (++visited % 128 === 0) await yieldWork();
    if (!active()) return [];
    const parent = item.parentElement;
    if (parent?.closest(OMIT)) continue;
    const nextList = parent?.closest("ol, ul") ?? null;
    const nextOwner = (nextList && parent?.closest("li")) || parent?.closest(BLOCK) || null;
    if (nextOwner !== owner || nextList !== list) flush();
    if (nextList !== list) flushList();
    owner = nextOwner;
    list = nextList;
    if (item.nodeType === Node.TEXT_NODE) fragments.push((item.nodeValue ?? "").replace(/\r?\n/g, " "));
    else if (list) fragments.push("\n");
    else flush();
  }
  flush();
  flushList();

  // Some books use numbered paragraphs in place of HTML lists.
  const blocks: ReadingBlock[] = [];
  for (let i = 0; i < result.length; i++) {
    if (!active()) return [];
    const block = result[i];
    if (block.kind !== "paragraph" || !LIST_NUMBER.test(block.text)) {
      blocks.push(block);
      continue;
    }
    const lines = [block.text];
    while (result[i + 1]?.kind === "paragraph" && LIST_NUMBER.test(result[i + 1].text)) lines.push(result[++i].text);
    blocks.push(lines.length > 1 ? { ...block, kind: "list", items: lines.length, text: lines.join("\n") } : block);
  }
  return blocks;
}

/** A compact chapter-level bigram filter saves disk reads. Exact matching happens on the source. */
function bigramHash(first: number, second: number): number {
  return Math.imul(first + 1, 0x1e35a7bd) ^ Math.imul(second + 1, 0x9e3779b1);
}

function visitBigrams(text: string, visit: (firstBit: number, secondBit: number) => boolean): boolean {
  const mask = FILTER_WORDS * 32 - 1;
  for (let i = 1; i < text.length; i++) {
    const hash = bigramHash(text.charCodeAt(i - 1), text.charCodeAt(i));
    if (!visit(hash & mask, (hash >>> 13) & mask)) return false;
  }
  return true;
}

export function readingSectionFilter(blocks: ReadingBlock[]): Uint32Array {
  const filter = new Uint32Array(FILTER_WORDS);
  for (const block of blocks) {
    visitBigrams(searchable(block.text), (a, b) => {
      filter[a >>> 5] |= 1 << (a & 31);
      filter[b >>> 5] |= 1 << (b & 31);
      return true;
    });
  }
  return filter;
}

const STOP_WORDS = new Set(["上述", "前文", "上文", "前面", "上面", "下文", "下面", "这些", "那些", "本章", "此处", "我们", "他们", "如果", "能够", "可以", "这个", "那个", "这里", "这样", "已经", "一个", "进行", "展开", "开展", "遵照", "根据", "按照"]);
const COUNTS = "一二三四五六七八九十";
const INTRO = /是指|指的是|定义为|称为|所谓|也就是|名叫|叫做|原名|外号|人称|出身|家住|来自|住在|弟子|师父|儿子|女儿|邻居|同伴|朋友|哥哥|妹妹|位于|坐落|地处|旧称|隶属|^.{0,18}是[\p{L}]{2}/u;

function keyWords(text: string, limit: number): string[] {
  const result = new Set<string>();
  for (const part of words.segment(searchable(text))) {
    const word = part.segment;
    if (part.isWordLike && word.length > 1 && /\p{L}/u.test(word) && !STOP_WORDS.has(word)
      && !/^[一二两三四五六七八九十\d]+[条项点种个]?$/u.test(word)) result.add(word);
    if (result.size >= limit) break;
  }
  return [...result];
}

export function readingQuery(selection: string, nearby: string) {
  const text = searchable(selection);
  const quantity = /([一二两三四五六七八九十\d]+)\s*[条项点种个]/u;
  const match = text.match(quantity)?.[1]?.replaceAll("两", "二");
  const digit = (value: string) => value ? COUNTS.indexOf(value) + 1 : 0;
  let count = 0;
  if (match && /^\d+$/u.test(match)) count = Number(match);
  else if (match?.length === 1) count = digit(match);
  else if (match && /^[一二三四五六七八九]?十[一二三四五六七八九]?$/u.test(match)) {
    const [tens, units] = match.split("十");
    count = (digit(tens) || 1) * 10 + digit(units);
  }
  if (!Number.isSafeInteger(count)) count = 0;
  const reference = count > 0 || /上述|上面的|前面|前文|上文|这些|那些/u.test(text);
  const literal = !reference && text.length <= 36 && /^[\p{L}\p{N}· -]+$/u.test(text) ? text : "";
  const terms = literal ? [literal] : keyWords(count ? text.replace(quantity, " ") : text, 8);
  return { terms, literal, count, nearby: keyWords(nearby.slice(-360), 16).filter(word => !terms.includes(word)) };
}

type Query = ReturnType<typeof readingQuery>;
type Hit = { block: ReadingBlock; section: number; position: number; score: number };

function mayMatch(filter: Uint32Array, terms: string[]): boolean {
  return terms.some(term => visitBigrams(term, (a, b) =>
    !!(filter[a >>> 5] & (1 << (a & 31))) && !!(filter[b >>> 5] & (1 << (b & 31)))));
}

function isRequestedList(block: ReadingBlock, query: Query): boolean {
  return query.count > 0 && block.kind === "list" && block.items === query.count;
}

function rankBlock(block: ReadingBlock, query: Query): number {
  const matchingList = isRequestedList(block, query);
  if (!query.terms.length) return matchingList ? 34 : 0;
  const text = searchable(block.text);
  const heading = searchable(block.heading);
  const bodyHits = query.terms.filter(term => text.includes(term)).length;
  const headingHits = query.terms.filter(term => heading.includes(term)).length;
  if ((!bodyHits && !headingHits) || (query.literal && !bodyHits)) return 0;
  const definitions = INTRO.test(text);
  const topical = query.nearby.reduce((score, word) => score + Number(text.includes(word)), 0);
  return 8 * bodyHits + 13 * headingHits + (matchingList ? 34 : 0) + (definitions ? 17 : 0)
    + Math.min(topical, 8) + (block.kind === "paragraph" ? 4 : 0) - (block.kind === "heading" ? 12 : 0);
}

function nearText(chapters: ReadingBlock[][]): string {
  const ordered: string[] = [];
  let size = 0;
  for (const chapter of chapters) {
    for (let i = chapter.length - 1; i >= 0 && size < NEAR_LIMIT; i--) {
      const block = chapter[i];
      if (size && block.text.length + size > NEAR_LIMIT) return ordered.reverse().join("\n\n");
      ordered.push(block.text.slice(-NEAR_LIMIT));
      size += block.text.length + 2;
    }
  }
  return ordered.reverse().join("\n\n");
}

/** Index one open book. Only a handful of source chapters and compact filters stay in memory. */
export class EarlierReadingIndex {
  private entries = new Map<number, ReadingIndexEntry>();
  private hot = new Map<number, ReadingBlock[]>();
  private unreadable = new Set<number>();
  private prefetched = new Set<number>();
  private prefetch: AbortController | undefined;
  private timer = 0;
  private visible = 0;
  private started = false;
  private readonly lifetime = new AbortController();
  private querying = 0;

  constructor(
    private length: number,
    private load: (section: number) => Promise<Document | null>,
    private bookId?: string,
    private signature = "",
  ) {
    this.signature = `2/${signature}`;
  }

  private get stopped(): boolean { return this.lifetime.signal.aborted; }

  follow(section: number): void {
    if (this.visible === section) return;
    this.visible = section;
    this.prefetched.clear();
    this.prefetch?.abort();
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.schedule();
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (this.bookId) void loadReadingIndex(this.bookId, this.signature).then(entries => {
      if (this.stopped) return;
      for (const entry of entries) {
        if (entry.section < this.length && !this.entries.has(entry.section)) this.entries.set(entry.section, entry);
      }
    }).catch(() => {});
    this.schedule();
  }

  stop(): void {
    this.lifetime.abort();
    window.clearTimeout(this.timer);
    this.prefetch?.abort();
    this.hot.clear();
  }

  private schedule(): void {
    if (!this.started || this.stopped || this.timer || this.prefetch || this.querying) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      if (this.stopped || this.querying) return;
      const next = this.nextSection();
      if (next === undefined) return;
      const controller = new AbortController();
      this.prefetch = controller;
      this.prefetched.add(next);
      void this.section(next, controller.signal).finally(() => {
        this.prefetch = undefined;
        this.schedule();
      });
    }, 40);
  }

  private nextSection(): number | undefined {
    for (let section = this.visible; section >= 0 && section > this.visible - PREFETCH_SECTIONS; section--) {
      if (section < this.length && !this.hot.has(section) && !this.prefetched.has(section) && !this.unreadable.has(section)) return section;
    }
  }

  private remember(section: number, blocks: ReadingBlock[]): ReadingBlock[] {
    this.hot.delete(section);
    this.hot.set(section, blocks);
    if (this.hot.size > CACHE_SECTIONS) this.hot.delete(this.hot.keys().next().value);
    return blocks;
  }

  private async section(section: number, signal: AbortSignal): Promise<ReadingBlock[]> {
    const active = () => !this.stopped && !signal.aborted;
    if (!active() || this.unreadable.has(section)) return [];
    const cached = this.hot.get(section);
    if (cached) return this.remember(section, cached);

    try {
      const reading = AbortSignal.any([signal, AbortSignal.timeout(SOURCE_TIMEOUT)]);
      const doc = await new Promise<Document | null>((resolve, reject) => {
        const abort = () => resolve(null);
        reading.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => reading.aborted ? null : this.load(section))
          .then(resolve, reject).finally(() => reading.removeEventListener("abort", abort));
      });
      if (!doc || !active()) return [];
      const root = doc.body ?? doc.querySelector("body");
      if (!root) {
        this.unreadable.add(section);
        return [];
      }
      const blocks = await readingBlocks(root, active);
      if (!active()) return [];
      if (!this.entries.has(section)) {
        const listCounts = [...new Set(blocks.flatMap(block => block.kind === "list" && block.items ? [block.items] : []))];
        const entry = { section, signature: this.signature, filter: readingSectionFilter(blocks), listCounts };
        this.entries.set(section, entry);
        if (this.bookId) void saveReadingIndexSection(this.bookId, entry).catch(() => {});
      }
      return this.remember(section, blocks);
    } catch {
      // A failed load can succeed the next time the reader requests this section.
      return [];
    }
  }

  async lookup(section: number, selection: string, preceding: ReadingBlock[], signal: AbortSignal): Promise<ContextExcerpt[]> {
    const active = () => !this.stopped && !signal.aborted;
    const scan = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(LOOKUP_TIMEOUT)]);
    this.querying++;
    this.prefetch?.abort();
    try {
      if (!active()) return [];
      const local: ReadingBlock[][] = [preceding];
      for (let n = section - 1; n >= Math.max(0, section - 3) && nearText(local).length < NEAR_LIMIT / 2 && !scan.aborted && active(); n--) {
        local.push(await this.section(n, scan));
      }
      const nearby = nearText(local);
      const query = readingQuery(selection, nearby);
      const selected: ContextExcerpt[] = nearby ? [{ label: "紧邻前文", text: nearby }] : [];
      if (!active()) return [];
      if (!query.terms.length && !query.count) return selected;

      const best: Hit[] = [];
      let firstMention: Hit | undefined;
      const countOnly = query.count > 0 && !query.terms.length;
      const collect = (blocks: ReadingBlock[], number: number) => {
        const chapterHits: Hit[] = [];
        for (const [position, block] of blocks.entries()) {
          const score = rankBlock(block, query);
          // Keep a relevant numbered group visible even when it is embedded in the nearby prose.
          if (score <= 0 || block.text.length > MATERIAL_LIMIT - nearby.length
            || (!isRequestedList(block, query) && (block.text.length < 10 || nearby.includes(block.text)))) continue;
          const hit = { block, section: number, position, score };
          if (query.literal && block.kind !== "heading" && (!firstMention || number < firstMention.section)) firstMention = hit;
          if (chapterHits.some(candidate => candidate.block.text === block.text)) continue;
          chapterHits.push(hit);
          chapterHits.sort((a, b) => b.score - a.score || (countOnly ? b.position - a.position : a.position - b.position));
          if (chapterHits.length > 4) chapterHits.pop();
        }
        best.push(...chapterHits);
        best.sort((a, b) => b.score - a.score || b.section - a.section);
        if (best.length > 12) best.length = 12;
      };
      collect(preceding, section);
      const enough = () => countOnly ? best.length > 0
        : best.length >= 4 && new Set(best.map(hit => hit.block.text)).size >= 4
          && (!query.literal || best.some(hit => INTRO.test(hit.block.text)));
      for (let n = section - 1; n >= Math.max(0, section - PREVIOUS_SECTIONS) && !scan.aborted && active() && !enough(); n--) {
        const entry = this.entries.get(n);
        if (entry && !(countOnly ? entry.listCounts?.includes(query.count) : mayMatch(entry.filter, query.terms))) continue;
        const blocks = local[section - n] ?? await this.section(n, scan);
        if (active()) collect(blocks, n);
      }
      if (!active()) return [];
      let remaining = MATERIAL_LIMIT - nearby.length;
      const matches: Hit[] = [];
      const seen = new Set<string>();
      const perChapter = new Map<number, number>();
      for (const hit of firstMention ? [best[0], firstMention, ...best] : best) {
        const key = searchable(hit.block.text);
        const chapterCount = perChapter.get(hit.section) ?? 0;
        if (seen.has(key) || hit.block.text.length > remaining || chapterCount >= 2) continue;
        seen.add(key);
        perChapter.set(hit.section, chapterCount + 1);
        matches.push(hit);
        remaining -= hit.block.text.length;
        if (matches.length === (countOnly ? 1 : 4)) break;
      }
      matches.sort((a, b) => a.section - b.section || a.position - b.position);
      return [
        ...selected,
        ...matches.map(({ block }) => {
          const label = isRequestedList(block, query) ? `前文列举（${block.items}项）` : "相关前文";
          return { label: block.heading ? label + " · " + block.heading : label, text: block.text };
        }),
      ];
    } finally {
      this.querying--;
      this.schedule();
    }
  }

  async lookupFollowing(
    section: number, selection: string, preceding: ReadingBlock[], following: ReadingBlock[],
    end: ReadingChapterEnd, signal: AbortSignal,
  ): Promise<ContextExcerpt[]> {
    const active = () => !this.stopped && !signal.aborted;
    const scan = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(LOOKUP_TIMEOUT)]);
    const query = readingQuery(selection, preceding.at(-1)?.text ?? "");
    const adjacent: string[] = [];
    const hits: Hit[] = [];
    let adjacentSize = 0;
    const collect = (blocks: ReadingBlock[], number: number) => {
      for (const [position, block] of blocks.entries()) {
        const space = 1100 - adjacentSize;
        if (space > 0) {
          adjacent.push(block.text.slice(0, space));
          adjacentSize += Math.min(space, block.text.length) + 2;
        }
        const score = query.terms.length ? rankBlock(block, query) : 0;
        if (score <= 0 || block.kind === "heading" || block.text.length < 10 || block.text.length > CHAPTER_FOLLOWING_LIMIT
          || hits.some(hit => hit.block.text === block.text)) continue;
        hits.push({ block, section: number, position, score });
        hits.sort((a, b) => b.score - a.score || a.section - b.section);
        if (hits.length > 6) hits.pop();
      }
    };

    this.querying++;
    this.prefetch?.abort();
    try {
      if (!active()) return [];
      collect(following, section);
      const last = Math.min(end.section, this.length, section + FOLLOWING_SECTIONS + 1);
      for (let n = section + 1; n < last && !scan.aborted && active(); n++) {
        if (adjacentSize >= 1100) {
          const nearby = adjacent.join("\n\n");
          const remaining = CHAPTER_FOLLOWING_LIMIT - nearby.length;
          const relevant = hits.filter(hit => !nearby.includes(hit.block.text));
          if (!query.terms.length || (relevant.length >= 2
            && relevant[0].block.text.length + relevant[1].block.text.length <= remaining)) break;
        }
        const entry = this.entries.get(n);
        if (entry && adjacentSize >= 1100 && !mayMatch(entry.filter, query.terms)) continue;
        const blocks = await this.section(n, scan);
        if (active()) collect(blocks, n);
      }
      if (!active()) return [];
      const nearby = adjacent.join("\n\n");
      let remaining = CHAPTER_FOLLOWING_LIMIT - nearby.length;
      const matches: Hit[] = [];
      for (const hit of hits) {
        if (nearby.includes(hit.block.text) || hit.block.text.length > remaining) continue;
        matches.push(hit);
        remaining -= hit.block.text.length;
        if (matches.length === 2) break;
      }
      matches.sort((a, b) => a.section - b.section || a.position - b.position);
      return [
        ...(nearby ? [{ label: "紧邻后文", text: nearby }] : []),
        ...matches.map(hit => ({ label: hit.block.heading ? "本章相关后文 · " + hit.block.heading : "本章相关后文", text: hit.block.text })),
      ];
    } finally {
      this.querying--;
      this.schedule();
    }
  }
}

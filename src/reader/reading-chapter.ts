import type { TocEntry } from "./epub";

const CHAPTER = /^(?:第[0-9零〇一二三四五六七八九十百千两]+章|chapter\b)/iu;
const EPUB_ORIGIN = "https://epub.invalid";

export function readingTocTarget(href: string, navigationPath: string): { path: string; fragment?: string } | undefined {
  if (!href?.trim() || (href.trim().startsWith("#") && !navigationPath)) return;
  try {
    const url = new URL(href, new URL(navigationPath, EPUB_ORIGIN));
    if (url.origin !== EPUB_ORIGIN || url.search) return;
    const hash = url.hash.slice(1);
    let fragment = hash || undefined;
    try { fragment = hash ? decodeURIComponent(hash) : undefined; } catch { /* IDs can contain a literal percent sign. */ }
    return { path: decodeURIComponent(url.pathname), fragment };
  } catch {
    return;
  }
}

export interface ReadingChapterEnd {
  /** First spine section that cannot be read in full. */
  section: number;
  marker?: Element;
}

export function readingChapterEnd(
  section: number, selection: Range, doc: Document, toc: TocEntry[],
  resolve: (href: string) => { section: number; fragment?: string } | undefined,
): ReadingChapterEnd {
  const caret = selection.cloneRange();
  caret.collapse(true);
  const owners: Array<number | undefined> = [];
  const points = toc.flatMap((entry, i) => {
    owners.length = entry.level;
    const chapter = CHAPTER.test(entry.label);
    const owner = chapter ? i : owners.at(-1);
    owners.push(owner);
    const target = resolve(entry.href);
    if (!target) return [];
    const { fragment } = target;
    const marker = target.section === section && fragment
      ? doc.getElementById(fragment) ?? Array.from(doc.querySelectorAll("a[name]")).find(el => el.getAttribute("name") === fragment)
      : undefined;
    if (target.section === section && fragment && (!marker?.parentNode || marker === doc.body || !doc.body.contains(marker))) return [];
    const before = target.section < section || (target.section === section && (!marker || caret.comparePoint(marker, 0) <= 0));
    return [{ ...target, owner, chapter, marker, before }];
  });

  const current = points.filter(point => point.before).at(-1);
  let marker: Element | undefined;
  const consider = (candidate: Element) => {
    if (!marker || marker.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_PRECEDING) marker = candidate;
  };
  for (const point of points) {
    if (point.marker && !point.before && (current?.owner === undefined || point.owner !== current.owner)) consider(point.marker);
  }
  // A heading in the text can mark a chapter missing from the TOC.
  for (const heading of doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6, [epub\\:type~='chapter']")) {
    if (caret.comparePoint(heading, 0) <= 0) continue;
    if (heading.localName === "h1" || CHAPTER.test(heading.textContent?.trim() ?? "")
      || heading.getAttribute("epub:type")?.split(/\s+/).includes("chapter")) consider(heading);
  }
  if (marker) return { section, marker };

  let end = section + 1;
  if (current?.section !== section || current.owner === undefined) return { section: end };
  const next = points.find(point => point.section > section && point.chapter && point.owner !== current.owner);
  if (!next) return { section: end };
  // A later chapter marker does not establish ownership of unlisted files.
  const confirmed = new Set<number>();
  const disputed = new Set<number>();
  for (const point of points) {
    if (point.owner !== current.owner) disputed.add(point.section);
    else if (!point.fragment) confirmed.add(point.section);
  }
  while (end < next.section && confirmed.has(end) && !disputed.has(end)) end++;
  return { section: end };
}

import type { SpeechSegment } from './types';

/** Keep source offsets, so repeated passages and typography changes retain distinct CFIs. */
export function speechSegments(doc: Document, cfi: (range: Range) => string, compareToAnchor?: (cfi: string) => number): SpeechSegment[] {
  const body = doc.body || doc.documentElement;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, { acceptNode(node) {
    const parent = node.parentElement;
    return parent?.closest('script,style,noscript,nav,rt,rp,[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"]')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
  } });
  const groups: { block: Element; spans: { node: Text; start: number }[]; text: string }[] = [];
  let node: Node;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    const block = text.parentElement?.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,div,td,pre') || body;
    let group = groups.at(-1);
    if (!group || group.block !== block) { group = { block, spans: [], text: '' }; groups.push(group); }
    group.spans.push({ node: text, start: group.text.length }); group.text += text.data;
  }
  const result: SpeechSegment[] = [];
  for (const group of groups) {
    const point = (offset: number) => {
      const span = [...group.spans].reverse().find(s => s.start <= offset);
      const range = doc.createRange(); range.setStart(span.node, offset - span.start); range.collapse(true);
      return cfi(range);
    };
    let start = 0;
    while (start < group.text.length) {
      while (/\s/u.test(group.text[start] || '') && start < group.text.length) start++;
      if (start >= group.text.length) break;
      const chinese = /[\u3400-\u9fff]/u.test(group.text.slice(start, start + 80));
      const target = chinese ? 65 : 160, maximum = chinese ? 115 : 230;
      const rest = group.text.slice(start, start + maximum);
      const ends = Array.from(rest.matchAll(/[。！？!?；;][”’"」』]?|\.(?=\s|$)/gu), m => m.index + m[0].length);
      let length = ends.find(n => n >= target) ?? ends.at(-1);
      if (start + maximum >= group.text.length) length = rest.length;
      if (!length) {
        length = rest.lastIndexOf(' ');
        if (length < target / 2) length = rest.length;
      }
      // Never split a surrogate pair at a hard limit.
      if (start + length < group.text.length && /[\uD800-\uDBFF]/.test(rest[length - 1])) length--;
      // Only split the requested starting clip at its sentence boundary. The normal path
      // keeps enough text together for phrasing and GPU throughput.
      if (compareToAnchor && compareToAnchor(point(start)) <= 0 && compareToAnchor(point(start + length)) > 0) {
        let cut = start;
        for (const end of ends) {
          let candidate = start + end;
          while (/\s/u.test(group.text[candidate] || '')) candidate++;
          if (candidate >= start + length || compareToAnchor(point(candidate)) > 0) break;
          cut = candidate;
        }
        if (cut > start) length = cut - start;
      }
      const raw = group.text.slice(start, start + length);
      const normalized = raw.normalize('NFC').replace(/[\u00ad\u200b]/g, '').replace(/\s+/gu, ' ').trim();
      if (/[\p{L}\p{N}]/u.test(normalized)) {
        result.push({ text: normalized, cfi: point(start) });
      }
      start += length;
    }
  }
  return result;
}

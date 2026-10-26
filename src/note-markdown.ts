/** 基础笔记 Markdown。只创建文本与固定标签，不解析 HTML、链接或图片。 */
function appendInline(parent: Node, text: string): void {
  const tokens = /\\([\\`*_])|`([^`\n]+)`|\*\*(\S(?:[^\n]*?\S)?)\*\*|__(\S(?:[^\n]*?\S)?)__|\*([^*\n]+)\*/g;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    parent.appendChild(document.createTextNode(text.slice(offset, match.index)));
    if (match[1]) {
      parent.appendChild(document.createTextNode(match[1]));
    } else {
      const tag = match[2] !== undefined ? "code" : match[3] !== undefined || match[4] !== undefined ? "strong" : "em";
      const el = document.createElement(tag);
      el.textContent = match[2] ?? match[3] ?? match[4] ?? match[5];
      parent.appendChild(el);
    }
    offset = match.index! + match[0].length;
  }
  parent.appendChild(document.createTextNode(text.slice(offset)));
}

/** 支持加粗、斜体、行内代码、段落换行及简单的有序 / 无序列表。 */
export function renderNoteMarkdown(target: HTMLElement, source: string): void {
  const fragment = document.createDocumentFragment();
  let paragraph: HTMLParagraphElement | null = null;
  let list: HTMLOListElement | HTMLUListElement | null = null;
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) {
      paragraph = null;
      list = null;
      continue;
    }
    const item = /^ {0,3}(?:([-+*])|([0-9]{1,9})[.)])\s+(.*)$/.exec(line);
    if (item) {
      paragraph = null;
      const tag = item[2] ? "ol" : "ul";
      if (!list || list.localName !== tag) {
        list = document.createElement(tag);
        if (tag === "ol") (list as HTMLOListElement).start = Number(item[2]);
        fragment.appendChild(list);
      }
      const li = document.createElement("li");
      appendInline(li, item[3]);
      list.appendChild(li);
    } else {
      list = null;
      if (!paragraph) {
        paragraph = document.createElement("p");
        fragment.appendChild(paragraph);
      } else paragraph.appendChild(document.createElement("br"));
      appendInline(paragraph, line);
    }
  }
  target.classList.add("note-markdown");
  target.replaceChildren(fragment);
}

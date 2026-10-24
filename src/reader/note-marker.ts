interface HighlightMark {
  element: SVGGElement;
  container: HTMLElement;
  getClientRects(): DOMRect[];
}
interface MarkerCallbacks {
  click(): void;
  hover(rect: { left: number; top: number; width: number; height: number } | null): void;
}

/** An overlay beside the range end; never insert nodes into EPUB text or alter its CFIs. */
export function attachNoteMarker(mark: HighlightMark, id: string, callbacks: MarkerCallbacks): () => void {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'tv-note-marker'; button.dataset.id = id;
  button.title = '查看批注'; button.setAttribute('aria-label', '查看批注');
  button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-6l-4.5 3v-3H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"/><path d="M6 7h8M6 10h5"/></svg>';
  mark.container.appendChild(button);
  let frame = 0;
  const position = () => {
    frame = 0;
    const end = mark.getClientRects().filter(rect => rect.width > 0 && rect.height > 0).at(-1);
    button.hidden = !end;
    if (!end) return;
    const container = mark.container.getBoundingClientRect();
    button.style.left = `${Math.max(0, Math.min(end.right - container.left + 1, container.width - 17))}px`;
    button.style.top = `${Math.max(0, end.top - container.top - 12)}px`;
  };
  const schedule = () => { if (!frame) frame = window.requestAnimationFrame(position); };
  const preview = () => {
    const rect = button.getBoundingClientRect();
    callbacks.hover({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  };
  button.addEventListener('click', event => { event.stopPropagation(); callbacks.click(); });
  button.addEventListener('mouseenter', preview);
  button.addEventListener('focus', preview);
  button.addEventListener('mouseleave', () => callbacks.hover(null));
  button.addEventListener('blur', () => callbacks.hover(null));
  // The highlight library replaces its rectangles on reflow, even without a page turn.
  const observer = new MutationObserver(schedule);
  observer.observe(mark.element, { childList: true, subtree: true, attributes: true, attributeFilter: ['x', 'y', 'width', 'height'] });
  position();
  return () => { observer.disconnect(); window.cancelAnimationFrame(frame); button.remove(); };
}

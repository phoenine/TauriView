import * as pdfjsLib from "pdfjs-dist";
import type { RenderTask } from "pdfjs-dist";
// @ts-ignore —— vite 会把 worker 打成独立资源并返回 URL
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfHandle {
  next(): void;
  /** 脚注跳转（PDF 暂无，保持可选以便与 EPUB 句柄共用入口） */
  canGoBack?(): boolean;
  goBack?(): boolean;
  prev(): void;
  goTo(page: number): void;
  page(): number;
  pageCount(): number;
  percent(): number;
  destroy(): void;
}

export interface PdfOptions {
  /** 起始页码，1 起 */
  startPage?: number;
  onRendered(info: { page: number; pageCount: number; percent: number }): void;
}

/** 打开 PDF，一页一页渲染到 canvas；容器滚动 */
export async function openPdf(container: HTMLElement, bytes: ArrayBuffer, opts: PdfOptions): Promise<PdfHandle> {
  container.innerHTML = "";
  const scroller = document.createElement("div");
  scroller.className = "pdf-scroll";
  container.appendChild(scroller);

  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false } as any).promise;
  const total = doc.numPages;
  let current = Math.min(Math.max(opts.startPage || 1, 1), total);
  let destroyed = false;
  let renderVersion = 0;
  let renderTask: RenderTask | undefined;

  async function render(pageNo: number): Promise<void> {
    if (destroyed) return;
    const version = ++renderVersion;
    current = Math.min(Math.max(pageNo, 1), total);
    const requestedPage = current;
    renderTask?.cancel();
    const page = await doc.getPage(requestedPage);
    if (destroyed || version !== renderVersion) return;
    const viewport = page.getViewport({ scale: 1 });

    // 以容器宽度为基准缩放，最宽 1100px，避免漫画页无限拉伸
    const targetWidth = Math.min(scroller.clientWidth - 36, 1100);
    const scale = targetWidth > 0 ? targetWidth / viewport.width : 1.2;
    const scaled = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(scaled.width);
    canvas.height = Math.floor(scaled.height);

    const ctx = canvas.getContext("2d", { alpha: false })!;
    const task = page.render({ canvasContext: ctx, viewport: scaled, canvas });
    renderTask = task;
    try {
      await task.promise;
    } catch (error) {
      if (destroyed || version !== renderVersion) return;
      throw error;
    } finally {
      if (renderTask === task) renderTask = undefined;
    }

    if (destroyed || version !== renderVersion) return;
    scroller.replaceChildren(canvas);
    const percent = total > 1 ? (requestedPage - 1) / (total - 1) : 1;
    opts.onRendered({ page: requestedPage, pageCount: total, percent });
    scroller.scrollTop = 0;
  }

  await render(current);

  const onResize = () => { void render(current); };
  window.addEventListener("resize", onResize);

  return {
    next: () => void render(current + 1),
    prev: () => void render(current - 1),
    goTo: (page: number) => void render(page),
    page: () => current,
    pageCount: () => total,
    percent: () => (total > 1 ? (current - 1) / (total - 1) : 1),
    destroy: () => {
      destroyed = true;
      ++renderVersion;
      renderTask?.cancel();
      window.removeEventListener("resize", onResize);
      try { void doc.destroy(); } catch { /* 已销毁 */ }
    },
  };
}

/** 渲染 PDF 第一页当封面 */
export async function extractPdfCover(bytes: ArrayBuffer): Promise<Uint8Array | undefined> {
  let doc: any;
  try {
    doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false } as any).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scaled = page.getViewport({ scale: 320 / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(scaled.width);
    canvas.height = Math.floor(scaled.height);
    await page.render({ canvasContext: canvas.getContext("2d", { alpha: false })!, viewport: scaled, canvas }).promise;
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) return undefined;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return undefined;
  } finally {
    try { await doc?.destroy(); } catch { /* 已销毁 */ }
  }
}

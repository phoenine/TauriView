import { listeningRequest as rpc } from './client';
import type { ListeningConfig, ListeningSnapshot } from './types';
import type { EpubHandle } from '../reader/epub';
import type { BookMeta } from '../storage';
import { getBytes } from '../storage';

interface Context {
  current(): { book: BookMeta; reader: EpubHandle } | null;
  locate(bookId: string, cfi: string): Promise<void>;
  settings(): void;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const playIcon = '<path d="m8 5 11 7-11 7z"/>';
const pauseIcon = '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>';
const bytes = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
let ctx: Context;
let state: ListeningSnapshot | null = null;
let config: ListeningConfig | null = null;
let audio: HTMLAudioElement;
let wantsPlay = false, loading = false, version = 0, epoch = 0, polling = false, preparing = false;
let loaded: { task: string; index: number; key: string; url: string } | null = null;
let lastSaved = 0, settingError = '', playerError = '', initialized = false;
let prepareRequested = false;
let prepareVersion = 0, finished = false;
let queue: Promise<unknown> = Promise.resolve();
const fingerprints = new Map<string, Promise<string>>();

function stopped(): void {
  epoch++; audio.pause(); loading = false;
  if (loaded) URL.revokeObjectURL(loaded.url);
  loaded = null; audio.removeAttribute('src'); audio.load();
}
function showPlayer(): void { $('listenPlayer').hidden = false; }
function report(error: unknown): void {
  playerError = String((error as Error)?.message || error);
  showPlayer(); render();
}
function command(request: Record<string, unknown>): Promise<ListeningSnapshot> {
  const run = async () => {
    version++;
    const value = await rpc<ListeningSnapshot>(request);
    state = value; playerError = ''; render(); return value;
  };
  const result = queue.then(run, run); queue = result.catch(() => {}); return result;
}
async function persist(playing = wantsPlay): Promise<void> {
  const task = state?.task;
  if (!task) return;
  const offset = loaded?.task === task.id && loaded.index === task.listenIndex ? audio.currentTime : task.offset;
  await command({ action: 'position', id: task.id, index: task.listenIndex, offset: Number.isFinite(offset) ? offset : 0, playing });
}
async function playReady(): Promise<void> {
  const task = state?.task, segment = task?.segments?.[task.listenIndex];
  if (!wantsPlay || !task || !segment?.ready || loading) { render(); return; }
  if (loaded?.task === task.id && loaded.index === task.listenIndex && loaded.key === segment.key) {
    if (audio.paused) {
      try { await audio.play(); }
      catch { wantsPlay = false; playerError = '音频已就绪，点击播放继续。'; }
    }
    render(); return;
  }
  stopped(); const token = ++epoch; loading = true;
  try {
    const reply = await rpc<{ data: string }>({ action: 'audio', key: segment.key });
    if (token !== epoch || !wantsPlay || state?.task?.id !== task.id || state.task.listenIndex !== task.listenIndex) return;
    const data = Uint8Array.from(atob(reply.data), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
    loaded = { task: task.id, index: task.listenIndex, key: segment.key, url };
    audio.src = url;
    audio.playbackRate = Number($<HTMLSelectElement>('listenSpeed').value);
    audio.currentTime = Math.min(task.offset, Math.max(0, segment.duration - .05));
    await audio.play();
    if (token === epoch) void persist(true).catch(report);
  } catch (error) {
    if (token === epoch) { wantsPlay = false; report(error); }
  } finally {
    if (token === epoch) { loading = false; render(); }
  }
}
async function toggle(): Promise<void> {
  if (!state?.task) { await listenFrom(); return; }
  wantsPlay = !wantsPlay;
  finished = false;
  if (!wantsPlay) { audio.pause(); await persist(false); }
  else { await command({ action: 'resume', id: state.task.id }); await playReady(); }
  render();
}
async function seek(index: number): Promise<void> {
  const task = state?.task;
  if (!task || index < 0 || index >= task.total) return;
  stopped(); wantsPlay = true;
  finished = false;
  await command({ action: 'seek', id: task.id, index, offset: 0, playing: true });
  await playReady();
}

/** Capture the book/CFI before any await: later page turns must never change this task. */
export async function listenFrom(cfi?: string, fromStart = false, prepareOnly = false): Promise<void> {
  const current = ctx?.current();
  showPlayer();
  if (!current?.reader?.speechChapter) { report(new Error('目前支持文字 EPUB；这一页没有可朗读的正文。')); return; }
  const attempt = ++prepareVersion;
  const { book, reader } = current, anchor = cfi || reader.cfi();
  preparing = true; wantsPlay = false; finished = false; audio.pause();
  const saved = persist(false).catch(() => {});
  stopped(); playerError = ''; render();
  await saved;
  try {
    const chapter = await reader.speechChapter({ cfi: anchor, fromStart });
    const signature = `${book.id}:${book.size}:${book.mtime}`;
    let hash = fingerprints.get(signature);
    if (!hash) {
      hash = getBytes(book).then(async data => {
        if (!data) throw Error('无法读取图书文件');
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), n => n.toString(16).padStart(2, '0')).join('');
      });
      fingerprints.set(signature, hash);
      hash.catch(() => fingerprints.delete(signature));
    }
    const bookHash = await hash;
    if (attempt !== prepareVersion) return;
    await command({ action: 'submit', bookId: book.id, bookHash, title: book.title,
      chapter: chapter.label, chapterHref: chapter.href, segments: chapter.segments, startIndex: chapter.startIndex, ...(state ? { voice: state.voice } : {}) });
    if (attempt !== prepareVersion) return;
    wantsPlay = !prepareOnly;
    if (wantsPlay) { await persist(true); await playReady(); }
  } catch (error) { if (attempt === prepareVersion) report(error); }
  finally { if (attempt === prepareVersion) { preparing = false; render(); } }
}

/** 朗读时在原文上高亮当前段落；换段/停播时自动更新或清除 */
let highlightKey = '';
function syncHighlight(): void {
  const handle = ctx.current()?.reader;
  if (!handle || typeof handle.setListenHighlight !== 'function') return;
  const task = state?.task, segment = task?.segments?.[task.listenIndex];
  if (!segment || !wantsPlay || $('listenPlayer').hidden && !wantsPlay) {
    if (highlightKey) { handle.setListenHighlight(null); highlightKey = ''; }
    return;
  }
  if (segment.key === highlightKey) return;
  highlightKey = segment.key;
  paintSegment(segment.cfi, segment.key, 0);
}
/** 章节还没渲染完时会画不上，短间隔重试几次（换段后旧的重试自行失效） */
function paintSegment(cfi: string, key: string, attempt: number): void {
  const handle = ctx.current()?.reader;
  if (!handle || typeof handle.setListenHighlight !== 'function') return;
  if (key !== highlightKey) return;
  // 只有第一次尝试允许翻页，重试只补画，避免反复触发渲染
  const painted = handle.setListenHighlight(cfi, attempt === 0);
  if (painted || attempt >= 4) return;
  window.setTimeout(() => paintSegment(cfi, key, attempt + 1), 400 + attempt * 300);
}
/** 退出书籍 / 关闭听书：停播、记住位置、清高亮、收起弹窗，并结束 python 进程（停掉后台生成、释放显存） */
let stopping = false;
export async function stopListening(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    wantsPlay = false;
    try { audio.pause(); } catch { /* 还没初始化 */ }
    await persist(false).catch(() => {});
    stopped();
    clearHighlight();
    $('listenMenu').hidden = true;
    $('listenPlayer').hidden = true;
    state = null;
    await rpc({ action: 'shutdown' }).catch(() => {});
    if (initialized) render();
  } finally {
    stopping = false;
  }
}

function clearHighlight(): void {
  if (!highlightKey) return;
  ctx.current()?.reader?.setListenHighlight?.(null);
  highlightKey = '';
}

function render(): void {
  if (!initialized) return;
  const task = state?.task, segment = task?.segments?.[task.listenIndex];
  // 弹窗标题只显示当前章节名，书名在阅读页/窗口标题里已经有了
  $('listenTitle').textContent = task ? (task.chapter || task.title) : '听书';
  $('listenPlayer').title = task ? `${task.title} · ${task.chapter}` : '听书';
  const waiting = wantsPlay && !segment?.ready;
  const progress = task ? `第 ${task.listenIndex + 1} / ${task.total} 段 · 已准备 ${task.completed} 段` : '';
  const status = playerError || (preparing ? '正在读取正文…' : finished ? '本章已听完' : task?.error ||
    (waiting ? (state.engine.message || '正在准备这一段…') : progress || '选择正文，点击「从这里听」开始。'));
  $('listenStatus').textContent = status;
  $('listenStatus').classList.toggle('error', !!playerError || !!task?.error);
  $('listenPlay').innerHTML = `<svg viewBox="0 0 24 24">${wantsPlay ? pauseIcon : playIcon}</svg>`;
  $('listenPlay').setAttribute('aria-label', wantsPlay ? '暂停朗读' : '播放朗读');
  $('listenPlay').title = wantsPlay ? '暂停朗读' : '播放朗读';
  $<HTMLButtonElement>('listenPlay').disabled = preparing;
  $<HTMLButtonElement>('listenPrev').disabled = !task || task.listenIndex === 0;
  $<HTMLButtonElement>('listenNext').disabled = !task || task.listenIndex >= task.total - 1;
  $('listenQuote').textContent = segment?.text || '';
  const range = $<HTMLInputElement>('listenSeek');
  range.disabled = !segment?.ready; range.max = String(segment?.duration || 0);
  if (document.activeElement !== range) range.value = String(loaded?.task === task?.id && loaded?.index === task?.listenIndex ? audio.currentTime : task?.offset || 0);
  $('listenTime').textContent = `${clock(Number(range.value))} / ${clock(segment?.duration || 0)}`;
  const generating = task?.status === 'preparing' || task?.status === 'queued';
  $('listenPrepare').textContent = generating ? '暂停准备' : task?.status === 'ready' ? '本章已准备' : '继续准备';
  $<HTMLButtonElement>('listenPrepare').disabled = !task || task.status === 'ready';
  $('listenBtn').classList.toggle('on', wantsPlay);
  syncHighlight();
  renderSettings();
}

async function poll(): Promise<void> {
  if (polling) return;
  const paneVisible = !document.querySelector<HTMLElement>('.sp-pane[data-pane="listening"]')?.hidden && !$('settingsView').hidden;
  if (!state && $('listenPlayer').hidden && !paneVisible && !prepareRequested) return;
  polling = true; const startVersion = version;
  try {
    if (!config?.available) {
      config = await rpc<ListeningConfig>({ action: 'config' });
      if (!config.available) { renderSettings(); return; }
    }
    if (prepareRequested && config.available) {
      prepareRequested = false;
      state = await command({ action: 'download_model' });
    }
    const value = await rpc<ListeningSnapshot>({ action: 'snapshot' });
    if (startVersion === version) { state = value; render(); await playReady(); }
  } catch (error) {
    settingError = String((error as Error)?.message || error);
    if (wantsPlay) { wantsPlay = false; audio.pause(); report(error); }
    renderSettings();
  } finally { polling = false; }
}

async function open(): Promise<void> {
  showPlayer();
  try {
    state = await rpc<ListeningSnapshot>({ action: 'snapshot' });
    const book = ctx.current()?.book;
    const previous = state.tasks.find(t => t.bookId === book?.id);
    if (previous) {
      if (previous.id !== state.task?.id) {
        wantsPlay = false; audio.pause(); await persist(false); stopped();
        await command({ action: 'select', id: previous.id });
      }
      if (!wantsPlay) await toggle(); else render();
    } else await listenFrom();
  } catch (error) { report(error); }
}

export function initListeningUI(context: Context): void {
  ctx = context;
  if (initialized) return;
  initialized = true; audio = new Audio(); audio.preload = 'auto';
  const safe = (fn: () => Promise<unknown>) => () => { void fn().catch(report); };
  $('listenBtn').addEventListener('click', safe(open));
  $('listenPlay').addEventListener('click', safe(toggle));
  $('listenPrev').addEventListener('click', safe(() => seek((state?.task?.listenIndex || 0) - 1)));
  $('listenNext').addEventListener('click', safe(() => seek((state?.task?.listenIndex || 0) + 1)));
  $('listenHide').addEventListener('click', () => { $('listenPlayer').hidden = true; });
  $('listenMore').addEventListener('click', () => { $('listenMenu').hidden = !$('listenMenu').hidden; });
  $('listenHere').addEventListener('click', safe(async () => { $('listenMenu').hidden = true; await listenFrom(); }));
  $('listenChapter').addEventListener('click', safe(async () => { $('listenMenu').hidden = true; await listenFrom(undefined, true, true); }));
  $('listenPrepare').addEventListener('click', safe(async () => {
    if (state?.task) await command({ action: ['queued', 'preparing'].includes(state.task.status) ? 'pause_generation' : 'resume', id: state.task.id });
  }));
  $('listenClose').addEventListener('click', () => { void stopListening().catch(report); });
  $('listenSettings').addEventListener('click', () => {
    $('listenMenu').hidden = true;
    $('listenPlayer').hidden = true;
    ctx.settings();
  });
  $('listenSpeed').addEventListener('change', () => { audio.playbackRate = Number($<HTMLSelectElement>('listenSpeed').value); });
  $('listenSeek').addEventListener('change', safe(async () => {
    if (loaded) { audio.currentTime = Number($<HTMLInputElement>('listenSeek').value); await persist(); }
  }));
  audio.addEventListener('timeupdate', () => {
    render();
    if (wantsPlay && Date.now() - lastSaved > 5000) { lastSaved = Date.now(); void persist().catch(report); }
  });
  audio.addEventListener('ended', safe(async () => {
    const task = state?.task;
    if (!task) return;
    if (task.listenIndex + 1 < task.total) await seek(task.listenIndex + 1);
    else { wantsPlay = false; await persist(false); finished = true; render(); }
  }));
  audio.addEventListener('error', () => { if (loaded) { wantsPlay = false; report(new Error('音频播放失败，请重试这一段。')); } });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') $('listenMenu').hidden = true; });
  window.addEventListener('pagehide', () => {
    audio.pause();
    void persist(false).catch(() => {});
    // 关窗时顺手结束 python，别留孤儿进程占显存
    void rpc({ action: 'shutdown' }).catch(() => {});
  });
  wireSettings();
  setInterval(() => { void poll(); }, 1000);
  // 退出书籍后自动收手：不再朗读，也不再继续合成/占用显存
  const readerView = document.getElementById('readerView');
  if (readerView) {
    new MutationObserver(() => {
      if (!readerView.hidden) return;
      if ($('listenPlayer').hidden && !state) return;
      void stopListening().catch(() => {});
    }).observe(readerView, { attributes: true, attributeFilter: ['hidden'] });
  }
  // Restore metadata without loading the GPU model. Playback remains an explicit user action.
  const initialVersion = version;
  void rpc<ListeningConfig>({ action: 'config' }).then(value => {
    config = value;
    if (value.available) return rpc<ListeningSnapshot>({ action: 'snapshot' }).then(snapshot => { if (initialVersion === version) { state = snapshot; render(); } });
  }).catch(() => {});
  render();
}

export async function refreshListeningSettings(): Promise<void> {
  try {
    config = await rpc<ListeningConfig>({ action: 'config' });
    if (config.available) state = await rpc<ListeningSnapshot>({ action: 'snapshot' });
    settingError = config.available ? '' : '首次使用需要下载本地语音组件。';
  } catch (error) { settingError = String((error as Error)?.message || error); }
  renderSettings();
}
function renderSettings(): void {
  if (!initialized || $('settingsView').hidden || document.querySelector<HTMLElement>('.sp-pane[data-pane="listening"]')?.hidden) return;
  if (state) $<HTMLSelectElement>('setTtsVoice').value = state.voice;
  const model = state?.model;
  $('setTtsStatus').textContent = !config?.available ? config?.installMessage || settingError || '首次使用需要准备本地语音组件。' : settingError || (model?.status === 'downloading' ? `正在下载 ${bytes(model.done)} / ${bytes(model.total)}` : model?.error ||
    (model?.installed ? '模型已就绪 · 本地运行 · CUDA Graph 加速' : '模型未下载 · 约 2.5 GB'));
  const downloading = model?.status === 'downloading';
  const installing = config?.installStatus === 'installing';
  $('setTtsDownload').textContent = installing ? '正在准备…' : !config?.available ? '下载并准备' : downloading ? '取消下载' : model?.installed ? '已下载' : model?.status === 'paused' ? '继续下载' : '下载模型';
  $<HTMLButtonElement>('setTtsDownload').disabled = installing || !!config?.available && !!model?.installed && !downloading;
  $('setTtsCache').textContent = state ? `已使用 ${bytes(state.cacheBytes)} / ${bytes(state.quotaBytes)}，闲置音频会自动回收。` : '音频缓存在本机。';
}
function wireSettings(): void {
  const action = (id: string, fn: () => Promise<unknown>) => $(id).addEventListener('click', () => {
    settingError = '';
    $<HTMLButtonElement>(id).disabled = true;
    void fn().catch(error => { settingError = String((error as Error)?.message || error); $('setTtsStatus').textContent = settingError; })
      .finally(() => { $<HTMLButtonElement>(id).disabled = false; renderSettings(); });
  });
  $('setTtsVoice').addEventListener('change', () => {
    void command({ action: 'voice', voice: $<HTMLSelectElement>('setTtsVoice').value }).catch(error => { settingError = String(error); renderSettings(); });
  });
  action('setTtsDownload', async () => {
    if (!config?.available) {
      prepareRequested = true;
      config = await rpc<ListeningConfig>({ action: 'install_runtime' }); settingError = '';
    } else await command({ action: state?.model.status === 'downloading' ? 'cancel_download' : 'download_model' });
  });
  action('setTtsClear', async () => { await command({ action: 'clear_cache' }); });
}

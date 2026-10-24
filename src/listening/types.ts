export interface SpeechSegment { text: string; cfi: string }
export interface SpeechChapter { href: string; label: string; segments: SpeechSegment[]; startIndex: number }
export interface ListeningSegment extends SpeechSegment { key: string; language: string; ready: boolean; duration: number }
export interface ListeningTask {
  id: string; bookId: string; bookHash: string; title: string; chapter: string; chapterHref: string;
  voice: string; status: 'queued' | 'preparing' | 'paused' | 'ready' | 'error'; error: string;
  completed: number; total: number; listenIndex: number; offset: number; playing: boolean;
  segments?: ListeningSegment[];
}
export interface ListeningSnapshot {
  voice: string; selected: string | null; task: ListeningTask | null; tasks: ListeningTask[];
  engine: { phase: string; message: string }; cacheBytes: number; quotaBytes: number;
  model: { id: string; installed: boolean; status: string; done: number; total: number; error: string };
}
export interface ListeningConfig { available: boolean; installStatus: 'ready' | 'missing' | 'installing' | 'error'; installMessage: string }

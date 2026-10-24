"""Local JSON-lines service: persistent listening tasks, content cache, lazy CUDA graphs."""
import argparse
import base64
import hashlib
import importlib.metadata
import json
import os
import pathlib
import re
import sys
import threading
import time
import unicodedata
import wave
import urllib.request

MODEL = json.loads(pathlib.Path(__file__).with_name('model.json').read_text(encoding='utf-8'))


class Download:
    """Only the pinned, validated model is downloadable; partial files survive cancellation."""
    def __init__(self, target):
        self.target = target
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.state = {'status': 'idle', 'done': 0, 'total': sum(f['size'] for f in MODEL['files']), 'error': ''}

    def complete(self):
        return all((self.target / f['path']).is_file() and (self.target / f['path']).stat().st_size == f['size'] for f in MODEL['files'])

    def snapshot(self):
        with self.lock: return {**self.state, 'installed': self.complete(), 'id': MODEL['id']}

    def start(self):
        with self.lock:
            if self.state['status'] == 'downloading': return
            self.cancel.clear()
            self.state.update(status='downloading', done=0, error='')
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        done = 0
        try:
            for item in MODEL['files']:
                if self.cancel.is_set(): raise InterruptedError()
                path = self.target / item['path']
                path.parent.mkdir(parents=True, exist_ok=True)
                if path.is_file() and path.stat().st_size == item['size']:
                    with path.open('rb') as file: valid = hashlib.file_digest(file, 'sha256').hexdigest() == item['sha256']
                    if valid:
                        done += item['size']
                        with self.lock: self.state['done'] = done
                        continue
                partial = path.with_name(path.name + '.download')
                offset = partial.stat().st_size if partial.exists() else 0
                if offset > item['size']: partial.unlink(); offset = 0
                if offset < item['size']:
                    url = 'https://modelscope.cn/models/' + MODEL['id'] + '/resolve/master/' + item['path']
                    headers = {'User-Agent': 'TauriView/0.1', **({'Range': f'bytes={offset}-'} if offset else {})}
                    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
                        if offset and (response.status != 206 or not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-')):
                            offset = 0
                        with partial.open('ab' if offset else 'wb') as file:
                            while True:
                                if self.cancel.is_set(): raise InterruptedError()
                                block = response.read(1024 * 1024)
                                if not block: break
                                file.write(block); offset += len(block)
                                if offset > item['size']: raise RuntimeError('模型文件大小与已验证版本不符')
                                with self.lock: self.state['done'] = done + offset
                with partial.open('rb') as file: checksum = hashlib.file_digest(file, 'sha256').hexdigest()
                if partial.stat().st_size != item['size'] or checksum != item['sha256']:
                    partial.unlink(missing_ok=True)
                    raise RuntimeError('模型校验失败，请重新下载。')
                partial.replace(path); done += item['size']
            with self.lock: self.state.update(status='ready', done=done)
        except InterruptedError:
            with self.lock: self.state['status'] = 'paused'
        except Exception as error:
            with self.lock: self.state.update(status='error', error=str(error))

VOICES = ('Serena', 'Uncle_Fu')
RECIPE = {'version': 1, 'dtype': 'bfloat16', 'attention': 'sdpa', 'seed': 42,
          'max_new_tokens': 768, 'min_new_tokens': 2, 'temperature': .9,
          'top_k': 50, 'top_p': 1., 'repetition_penalty': 1.05, 'non_streaming_mode': True}
LEVEL = {'version': 1, 'rms': .06, 'max_gain_db': 6., 'peak_db': -1.}


def level_audio(samples):
    """One bounded gain per clip: no time compression, per-frame pumping, or hard clipping."""
    import numpy as np
    rms, peak = float(np.sqrt(np.mean(samples ** 2))), float(np.abs(samples).max())
    limit = 10 ** (LEVEL['max_gain_db'] / 20)
    gain = min(max(LEVEL['rms'] / max(rms, 1e-8), 1 / limit), limit)
    gain = min(gain, 10 ** (LEVEL['peak_db'] / 20) / max(peak, 1e-8))
    return samples * gain


def normalize(text):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFC', text).replace('\u00ad', '').replace('\u200b', '')).strip()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as file:
        json.dump(value, file, ensure_ascii=False)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(path)


class FastVoice:
    def __init__(self, model, root, status):
        self.path, self.root, self.status = model, root, status
        self.model = self.torch = None

    def __call__(self, text, voice, language, target):
        if self.model is None:
            self.status('loading', '正在加载本地语音模型…')
            os.environ['HF_HUB_OFFLINE'] = '1'
            os.environ['TRANSFORMERS_OFFLINE'] = '1'
            os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
            os.environ['GRADIO_ANALYTICS_ENABLED'] = 'False'
            os.environ.setdefault('HF_HOME', str(self.root / 'hf-cache'))
            os.environ.setdefault('CUDA_CACHE_PATH', str(self.root / 'cuda-cache'))
            import torch
            from faster_qwen3_tts import FasterQwen3TTS
            if not torch.cuda.is_available():
                raise RuntimeError('未检测到可用 CUDA，请检查本地语音环境。')
            torch.set_num_threads(4)
            self.torch = torch
            self.model = FasterQwen3TTS.from_pretrained(str(self.path), device='cuda:0', backend='torch',
                dtype=torch.bfloat16, attn_implementation='sdpa', max_seq_len=1024, local_files_only=True)
        import numpy as np
        import soundfile as sf
        self.status('generating', '正在准备音频…')
        self.torch.manual_seed(RECIPE['seed'])
        with self.torch.inference_mode():
            audio, rate = self.model.generate_custom_voice(text=text, speaker=voice.lower(), language=language,
                **{k: v for k, v in RECIPE.items() if k not in ('version', 'dtype', 'attention', 'seed')})
        samples = np.asarray(audio[0]).reshape(-1)
        if rate != 24000 or not np.isfinite(samples).all() or len(samples) < rate / 4 or np.sqrt(np.mean(samples**2)) < .001:
            raise RuntimeError('生成的音频无效，请重试此段。')
        # 768 codec frames approach 61 seconds; reaching the cap must not publish a truncated clip.
        if len(samples) / rate > 59:
            raise RuntimeError('本段生成达到时长上限，请缩短原文后重新准备。')
        sf.write(str(target), level_audio(samples), rate, format='WAV', subtype='PCM_16')

    def unload(self):
        if self.model is not None:
            self.model = None
            import gc
            gc.collect()
            self.torch.cuda.empty_cache()


class Listening:
    def __init__(self, root, model, synth=None, quota=2 * 1024**3, idle=300):
        self.root, self.model_path = pathlib.Path(root), pathlib.Path(model)
        self.root.mkdir(parents=True, exist_ok=True)
        self.audio_dir = self.root / 'audio'
        self.audio_dir.mkdir(exist_ok=True)
        self.file = self.root / 'listening.json'
        self.lock = threading.RLock()
        self.fingerprint_lock = threading.Lock()
        self.download = Download(self.model_path)
        self.wake, self.stop = threading.Event(), threading.Event()
        self.phase, self.message, self.busy = 'idle', '', None
        self.quota, self.idle, self.test_synth = quota, idle, synth is not None
        self.synth = synth or FastVoice(self.model_path, self.root, self.engine_status)
        self.fingerprint_cache = None
        if self.file.exists():
            self.data = json.loads(self.file.read_text(encoding='utf-8'))
            if self.data.get('version') != 1:
                raise RuntimeError('听书记录版本不受支持，请保留记录并更新应用。')
        else:
            self.data = {'version': 1, 'voice': 'Serena', 'selected': None, 'tasks': {}, 'cache': {}}
        for task in self.data['tasks'].values():
            if task['status'] == 'preparing': task['status'] = 'queued'
            task['playing'] = False
        # A crash may leave metadata for an already-evicted file, never treat it as playable.
        self.data['cache'] = {key: item for key, item in self.data['cache'].items() if self.path(key).is_file()}
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self):
        self.thread.start()

    def close(self):
        self.download.cancel.set()
        self.stop.set(); self.wake.set()
        if self.thread.is_alive(): self.thread.join(timeout=2)

    def path(self, key):
        if not isinstance(key, str) or not re.fullmatch('[a-f0-9]{64}', key):
            raise ValueError('无效的音频标识')
        return self.audio_dir / (key + '.wav')

    def save(self):
        atomic_json(self.file, self.data)

    def engine_status(self, phase, message):
        with self.lock:
            self.phase, self.message = phase, message

    def fingerprint(self):
        with self.fingerprint_lock: return self._fingerprint()

    def _fingerprint(self):
        if self.test_synth: return 'test-engine-v1'
        files = [self.model_path / item['path'] for item in MODEL['files']]
        if not all(p.is_file() for p in files):
            raise ValueError('本地模型文件不完整，请在朗读设置中选择模型目录。')
        signature = [(str(p), p.stat().st_size, p.stat().st_mtime_ns) for p in files]
        if self.fingerprint_cache and self.fingerprint_cache[0] == signature:
            return self.fingerprint_cache[1]
        receipt = self.root / 'model-fingerprint.json'
        known = json.loads(receipt.read_text(encoding='utf-8')) if receipt.exists() else {}
        if known.get('signature') != [list(s) for s in signature]:
            hashes = []
            for path in files:
                h = hashlib.sha256()
                with path.open('rb') as file:
                    for block in iter(lambda: file.read(1024 * 1024), b''): h.update(block)
                hashes.append(h.hexdigest())
            known = {'signature': signature, 'hashes': hashes}
            atomic_json(receipt, known)
        packages = {name: importlib.metadata.version(name) for name in ('faster-qwen3-tts', 'qwen-tts-hf', 'transformers', 'torch')}
        value = digest({'weights': known['hashes'], 'packages': packages, 'recipe': RECIPE, 'level': LEVEL})
        self.fingerprint_cache = (signature, value)
        return value

    def summary(self, task, full=False):
        result = {k: v for k, v in task.items() if k != 'segments'}
        result['completed'] = sum(segment['key'] in self.data['cache'] for segment in task['segments'])
        result['total'] = len(task['segments'])
        if full:
            result['segments'] = [{**s, 'ready': s['key'] in self.data['cache'],
                'duration': self.data['cache'].get(s['key'], {}).get('duration', 0)} for s in task['segments']]
        return result

    def snapshot(self):
        with self.lock:
            selected = self.data['tasks'].get(self.data['selected'])
            return {'voice': self.data['voice'], 'selected': self.data['selected'],
                'task': self.summary(selected, True) if selected else None,
                'tasks': [self.summary(t) for t in reversed(list(self.data['tasks'].values()))],
                'engine': {'phase': self.phase, 'message': self.message},
                'model': self.download.snapshot(),
                'cacheBytes': sum(v['size'] for v in self.data['cache'].values()), 'quotaBytes': self.quota}

    def submit(self, request):
        segments = request.get('segments', [])
        voice = request.get('voice', self.data['voice'])
        if voice not in VOICES: raise ValueError('请选择有效音色')
        if not isinstance(segments, list) or not 0 < len(segments) <= 2000:
            raise ValueError('本章没有可朗读的正文，或段落数量过多。')
        for s in segments:
            if not isinstance(s, dict) or not isinstance(s.get('text'), str) or not 0 < len(normalize(s['text'])) <= 240:
                raise ValueError('朗读段落长度无效')
            if not isinstance(s.get('cfi'), str) or not s['cfi'].startswith('epubcfi('):
                raise ValueError('缺少原文位置')
        book_id, book_hash = request.get('bookId'), request.get('bookHash')
        if not isinstance(book_id, str) or not isinstance(book_hash, str) or not re.fullmatch('[a-f0-9]{64}', book_hash):
            raise ValueError('图书标识无效')
        engine = self.fingerprint()
        if self.download.snapshot()['status'] == 'downloading': raise ValueError('模型正在下载，请等待下载完成。')
        prepared = []
        for s in segments:
            text = normalize(s['text'])
            language = 'Chinese' if re.search('[\u3400-\u9fff]', text) else 'English'
            key = digest({'engine': engine, 'voice': voice, 'language': language, 'text': text})
            prepared.append({'text': text, 'cfi': s['cfi'], 'key': key, 'language': language})
        identifier = digest({'book': book_hash, 'bookId': book_id, 'chapter': request.get('chapterHref'),
            'anchors': [s['cfi'] for s in prepared], 'keys': [s['key'] for s in prepared]})
        with self.lock:
            index = request.get('startIndex', 0)
            if not isinstance(index, int) or not 0 <= index < len(prepared): raise ValueError('起点无效')
            for other in self.data['tasks'].values():
                if other['status'] in ('preparing', 'queued'): other['status'] = 'paused'
                other['playing'] = False
            if identifier not in self.data['tasks']:
                self.data['tasks'][identifier] = {'id': identifier, 'bookId': book_id, 'bookHash': book_hash,
                    'title': str(request.get('title', '听书'))[:300], 'chapter': str(request.get('chapter', '正文'))[:300],
                    'chapterHref': str(request.get('chapterHref', '')), 'voice': voice, 'engine': engine,
                    'created': time.time(), 'status': 'queued', 'error': '', 'listenIndex': 0, 'offset': 0.,
                    'playing': False, 'segments': prepared}
            task = self.data['tasks'][identifier]
            task['status'], task['error'] = 'queued', ''
            task['listenIndex'], task['offset'], task['playing'] = index, 0., False
            self.data['selected'] = identifier
            self.save(); self.wake.set()
        return self.snapshot()

    def request(self, request):
        action = request.get('action')
        if action == 'submit': return self.submit(request)
        if action == 'snapshot': return self.snapshot()
        if action == 'download_model':
            with self.lock:
                if self.busy: raise ValueError('请先暂停音频准备，再下载模型。')
                self.download.start()
            return self.snapshot()
        if action == 'cancel_download':
            self.download.cancel.set()
            return self.snapshot()
        with self.lock:
            if action == 'voice':
                if request.get('voice') not in VOICES: raise ValueError('无效音色')
                self.data['voice'] = request['voice']; self.save()
            elif action == 'select':
                if request.get('id') not in self.data['tasks']: raise ValueError('听书任务不存在')
                self.data['selected'] = request['id']; self.save()
            elif action in ('pause_generation', 'resume', 'position', 'seek'):
                task = self.data['tasks'].get(request.get('id'))
                if not task: raise ValueError('听书任务不存在')
                if action == 'pause_generation': task['status'] = 'paused'
                if action == 'resume':
                    for other in self.data['tasks'].values():
                        if other['id'] != task['id'] and other['status'] in ('queued', 'preparing'): other['status'] = 'paused'
                    task['status'], task['error'] = 'queued', ''
                    self.data['selected'] = task['id']
                if action in ('position', 'seek'):
                    index = request.get('index', 0)
                    offset = request.get('offset', 0)
                    if not isinstance(index, int) or not 0 <= index < len(task['segments']): raise ValueError('听书位置无效')
                    if not isinstance(offset, (int, float)) or not 0 <= offset <= 3600: raise ValueError('播放时间无效')
                    task['listenIndex'], task['offset'], task['playing'] = index, offset, bool(request.get('playing'))
                    if action == 'seek': task['status'], task['error'] = 'queued', ''
                self.save(); self.wake.set()
            elif action == 'audio':
                key = request.get('key')
                path = self.path(key)
                if key not in self.data['cache'] or not path.is_file(): raise ValueError('音频尚未准备好')
                if path.stat().st_size > 8 * 1024**2: raise ValueError('音频片段过大')
                payload = path.read_bytes()
                if self.data['cache'][key].get('sha256') and hashlib.sha256(payload).hexdigest() != self.data['cache'][key]['sha256']:
                    path.unlink(missing_ok=True); del self.data['cache'][key]; self.save()
                    raise ValueError('音频缓存损坏，已移除；重试将重新准备这一段。')
                self.data['cache'][key]['used'] = time.time()
                return {'data': base64.b64encode(payload).decode('ascii')}
            elif action == 'clear_cache':
                if self.busy or any(t.get('playing') for t in self.data['tasks'].values()):
                    raise ValueError('请先暂停播放和音频准备，再清理缓存。')
                for key in list(self.data['cache']): self.path(key).unlink(missing_ok=True)
                self.data['cache'] = {}
                for task in self.data['tasks'].values(): task['status'] = 'paused'
                self.save()
            else: raise ValueError('未知的听书操作')
        return self.snapshot()

    def make_room(self, size):
        protected = set()
        for task in self.data['tasks'].values():
            if task['id'] == self.data['selected'] or task['status'] in ('queued', 'preparing') or task.get('playing'):
                protected.update(s['key'] for s in task['segments'])
        used = sum(v['size'] for v in self.data['cache'].values())
        for key, entry in sorted(list(self.data['cache'].items()), key=lambda pair: pair[1].get('used', 0)):
            if used + size <= self.quota: break
            if key in protected: continue
            self.path(key).unlink(missing_ok=True)
            used -= entry['size']; del self.data['cache'][key]
        if used + size > self.quota:
            raise RuntimeError('听书缓存已满，请暂停准备并在设置中清理缓存。')

    def run(self):
        last_work = time.monotonic()
        while not self.stop.is_set():
            with self.lock:
                candidates = [t for t in self.data['tasks'].values() if t['status'] == 'queued']
                candidates.sort(key=lambda t: t['id'] != self.data['selected'])
                task = candidates[0] if candidates else None
                if task:
                    task['status'] = 'preparing'; self.busy = task['id']; self.save()
            if not task:
                if time.monotonic() - last_work > self.idle and hasattr(self.synth, 'unload'):
                    self.synth.unload(); self.engine_status('idle', '')
                self.wake.wait(timeout=1); self.wake.clear(); continue
            try:
                if task['engine'] != self.fingerprint(): raise RuntimeError('模型版本已变化，请从原文重新准备此章。')
                with self.lock:
                    segment = next((s for s in task['segments'][task['listenIndex']:] if s['key'] not in self.data['cache']), None)
                if segment:
                    path = self.path(segment['key']); temporary = path.with_suffix('.partial')
                    self.synth(segment['text'], task['voice'], segment['language'], temporary)
                    with wave.open(str(temporary), 'rb') as file:
                        if file.getnchannels() != 1 or file.getsampwidth() != 2 or file.getframerate() != 24000:
                            raise RuntimeError('音频格式无效')
                        duration = file.getnframes() / file.getframerate()
                        if duration <= 0: raise RuntimeError('生成了空音频')
                    with self.lock:
                        self.make_room(temporary.stat().st_size)
                        temporary.replace(path)
                        self.data['cache'][segment['key']] = {'duration': duration, 'size': path.stat().st_size, 'used': time.time(),
                            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                        self.save()
                with self.lock:
                    if task['status'] in ('preparing', 'queued'):
                        task['status'] = 'queued' if any(s['key'] not in self.data['cache'] for s in task['segments'][task['listenIndex']:]) else 'ready'
                        task['error'] = ''
                    self.save()
            except Exception as error:
                with self.lock:
                    task['status'], task['error'] = 'error', str(error)
                    self.phase, self.message = 'error', str(error)
                    self.save()
            finally:
                with self.lock:
                    self.busy = None
                    if self.phase != 'error': self.phase, self.message = 'ready', ''
                last_work = time.monotonic()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--model', required=True)
    args = parser.parse_args()
    # A single writer owns each cache root, including across app instances.
    pathlib.Path(args.root).mkdir(parents=True, exist_ok=True)
    owner = (pathlib.Path(args.root) / 'worker.lock').open('a+b')
    if owner.tell() == 0: owner.write(b'0'); owner.flush()
    owner.seek(0)
    if os.name == 'nt':
        import msvcrt
        msvcrt.locking(owner.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    protocol = sys.stdout
    # Third-party libraries print progress and warnings; the protocol owns the original stdout.
    sys.stdout = sys.stderr
    controller = Listening(args.root, args.model)
    controller.start()
    for line in sys.stdin:
        identifier = None
        try:
            if len(line) > 4 * 1024**2: raise ValueError('听书请求过大')
            request = json.loads(line); identifier = request.get('id')
            result = controller.request(request['request'])
            reply = {'id': identifier, 'result': result}
        except Exception as error:
            reply = {'id': identifier, 'error': str(error)}
        protocol.write(json.dumps(reply, ensure_ascii=False, allow_nan=False) + '\n'); protocol.flush()
    controller.stop.set()
    # Avoid interpreter shutdown while a daemon is inside CUDA. The OS releases its context.
    os._exit(0)


if __name__ == '__main__':
    main()

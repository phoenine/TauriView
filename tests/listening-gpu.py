"""Opt-in real GPU smoke test. Never downloads or replaces the installed runtime/model."""
import base64
import io
import os
import json
import pathlib
import queue
import subprocess
import threading
import time
import wave

ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON = ROOT / '.local-tts/fast-venv/Scripts/python.exe'
MODEL = ROOT / '.local-tts/models/Qwen3-TTS-12Hz-0.6B-CustomVoice'
OUTPUT = ROOT / '.local-tts' / ('listening-smoke-' + time.strftime('%Y%m%d-%H%M%S'))
OUTPUT.mkdir()


class Worker:
    def __init__(self):
        self.log = (OUTPUT / 'worker.log').open('ab')
        self.child = subprocess.Popen([str(PYTHON), '-u', str(ROOT / 'resources/tts/worker.py'), '--root', str(OUTPUT), '--model', str(MODEL)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True, encoding='utf-8', creationflags=0x08000000,
            env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONNOUSERSITE': '1'})
        self.replies = queue.Queue(); self.sequence = 0
        threading.Thread(target=lambda: [self.replies.put(json.loads(line)) for line in self.child.stdout], daemon=True).start()

    def request(self, action, **kwargs):
        self.sequence += 1
        self.child.stdin.write(json.dumps({'id': self.sequence, 'request': {'action': action, **kwargs}}, ensure_ascii=False) + '\n')
        self.child.stdin.flush()
        value = self.replies.get(timeout=30)
        assert value['id'] == self.sequence, value
        if 'error' in value: raise RuntimeError(value['error'])
        return value['result']

    def close(self):
        self.child.stdin.close()
        try: self.child.wait(5)
        except subprocess.TimeoutExpired: self.child.kill(); self.child.wait()
        self.log.close()


worker = Worker()
try:
    start = time.monotonic()
    state = worker.request('snapshot')
    assert state['model']['installed']
    state = worker.request('submit', bookId='gpu-smoke', bookHash='a' * 64, title='听书验证', chapter='第一章', chapterHref='chapter.xhtml', startIndex=0,
        segments=[{'text': '清晨的阳光洒进窗户，今天是个好天气。', 'cfi': 'epubcfi(/6/2!/4/2/1:0)'},
                  {'text': '翻过这一页，我们继续从新的位置开始阅读。', 'cfi': 'epubcfi(/6/2!/4/4/1:0)'}])
    identifier = state['selected']; previous = ''
    while not state['task']['segments'][0]['ready']:
        assert time.monotonic() - start < 180, 'GPU generation timed out'
        if state['task']['error']: raise RuntimeError(state['task']['error'])
        phase = state['engine']['phase']
        if phase != previous: print(phase, flush=True); previous = phase
        time.sleep(.5); state = worker.request('snapshot')
    first_ready = round(time.monotonic() - start, 2)
    clip = worker.request('audio', key=state['task']['segments'][0]['key'])
    payload = base64.b64decode(clip['data'])
    (OUTPUT / 'first.wav').write_bytes(payload)
    with wave.open(io.BytesIO(payload)) as file: duration = file.getnframes() / file.getframerate()
    worker.request('position', id=identifier, index=0, offset=.5, playing=False)
    worker.request('pause_generation', id=identifier)
    worker.close(); worker = Worker()
    restored = worker.request('snapshot')
    assert restored['task']['offset'] == .5 and not restored['task']['playing']
    assert restored['task']['segments'][0]['ready'] and restored['engine']['phase'] == 'idle'
    hit_start = time.monotonic()
    cached = worker.request('audio', key=restored['task']['segments'][0]['key'])
    assert cached['data'] == clip['data']
    result = {'firstReadySecondsIncludingLoad': first_ready, 'audioSeconds': duration,
        'cacheHitSeconds': round(time.monotonic() - hit_start, 3), 'restoredOffset': .5, 'output': str(OUTPUT)}
    (OUTPUT / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False), flush=True)
finally:
    worker.close()

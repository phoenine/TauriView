import importlib.util
import pathlib
import tempfile
import threading
import time
import unittest
import wave
import io
import hashlib
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('worker', pathlib.Path(__file__).parents[1] / 'resources/tts/worker.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)


def wait_for(predicate):
    deadline = time.monotonic() + 5
    while not predicate():
        if time.monotonic() > deadline: raise AssertionError('worker did not reach expected state')
        time.sleep(.01)


class ListeningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.calls = []
        self.service = worker.Listening(self.temp.name, pathlib.Path(self.temp.name) / 'model', self.synth)

    def tearDown(self):
        self.service.close(); self.temp.cleanup()

    def synth(self, text, voice, language, path):
        self.calls.append((text, voice))
        with wave.open(str(path), 'wb') as audio:
            audio.setparams((1, 2, 24000, 0, 'NONE', ''))
            audio.writeframes(b'\x01\x01' * 24000)

    def submit(self, texts=('第一段。', '第二段。', '第三段。'), **kwargs):
        return self.service.request({'action': 'submit', 'bookId': 'book-a', 'bookHash': 'a' * 64,
            'chapterHref': 'chapter.xhtml', 'segments': [{'text': t, 'cfi': f'epubcfi(/6/2!/4/{2*(i+1)}/1:0)'} for i, t in enumerate(texts)], **kwargs})

    def test_start_position_generates_only_requested_suffix_and_cache_hit_seeks(self):
        state = self.submit(startIndex=1)
        self.service.start()
        wait_for(lambda: self.service.snapshot()['task']['status'] == 'ready')
        self.assertEqual([c[0] for c in self.calls], ['第二段。', '第三段。'])
        identifier = state['selected']
        self.service.request({'action': 'seek', 'id': identifier, 'index': 2, 'offset': 0, 'playing': True})
        wait_for(lambda: self.service.snapshot()['task']['status'] == 'ready')
        self.assertEqual(len(self.calls), 2)
        self.service.request({'action': 'seek', 'id': identifier, 'index': 0, 'offset': 0})
        wait_for(lambda: self.service.snapshot()['task']['completed'] == 3)
        self.assertEqual(len(self.calls), 3)

    def test_new_start_preempts_old_queue_at_segment_boundary(self):
        entered, release = threading.Event(), threading.Event()
        def blocking(*args):
            if not entered.is_set(): entered.set(); release.wait(3)
            self.synth(*args)
        self.service.synth = blocking
        old = self.submit()['selected']; self.service.start(); self.assertTrue(entered.wait(2))
        new = self.submit(texts=('新位置。',), bookId='book-b', bookHash='b' * 64)['selected']
        release.set()
        wait_for(lambda: self.service.snapshot()['task']['status'] == 'ready')
        self.assertEqual([c[0] for c in self.calls], ['第一段。', '新位置。'])
        self.assertEqual(self.service.data['tasks'][old]['status'], 'paused')
        self.assertEqual(self.service.data['selected'], new)

    def test_restart_retains_independent_listening_progress_and_cached_audio(self):
        identifier = self.submit(texts=('同一句话。',))['selected']; self.service.start()
        wait_for(lambda: self.service.snapshot()['task']['status'] == 'ready')
        self.service.request({'action': 'position', 'id': identifier, 'index': 0, 'offset': .4, 'playing': True})
        self.service.close()
        self.service = worker.Listening(self.temp.name, 'unused', self.synth)
        task = self.service.snapshot()['task']
        self.assertEqual(task['offset'], .4); self.assertFalse(task['playing'])
        self.assertTrue(task['segments'][0]['ready'])
        audio = self.service.request({'action': 'audio', 'key': task['segments'][0]['key']})
        self.assertTrue(audio['data'].startswith('UklGR'))
        self.assertEqual(set(p.name for p in pathlib.Path(self.temp.name).iterdir()), {'audio', 'listening.json'})

    def test_voice_changes_invalidate_audio_but_book_identity_does_not_duplicate_it(self):
        self.submit(texts=('共用原文。',)); self.service.start()
        wait_for(lambda: self.service.snapshot()['task']['status'] == 'ready')
        self.submit(texts=('共用原文。',), bookId='another')
        wait_for(lambda: self.service.snapshot()['task']['status'] == 'ready')
        self.assertEqual(len(self.calls), 1)
        self.submit(texts=('共用原文。',), voice='Uncle_Fu')
        wait_for(lambda: self.service.snapshot()['task']['status'] == 'ready')
        self.assertEqual(len(self.calls), 2)

    def test_clear_cache_blocks_during_playback_then_preserves_tasks(self):
        identifier = self.submit(texts=('缓存。',))['selected']; self.service.start()
        wait_for(lambda: self.service.snapshot()['task']['status'] == 'ready')
        self.service.request({'action': 'position', 'id': identifier, 'index': 0, 'playing': True})
        with self.assertRaises(ValueError): self.service.request({'action': 'clear_cache'})
        self.service.request({'action': 'position', 'id': identifier, 'index': 0, 'playing': False})
        self.service.request({'action': 'clear_cache'})
        self.assertEqual(self.service.snapshot()['cacheBytes'], 0)
        self.assertEqual(self.service.snapshot()['task']['status'], 'paused')

    def test_bad_audio_never_becomes_playable(self):
        self.service.synth = lambda *args: pathlib.Path(args[-1]).write_bytes(b'broken')
        self.submit(texts=('错误音频。',)); self.service.start()
        wait_for(lambda: self.service.snapshot()['task']['status'] == 'error')
        self.assertEqual(self.service.snapshot()['task']['completed'], 0)

    def test_modified_cache_is_invalidated_instead_of_played(self):
        self.submit(texts=('完整的原文。',)); self.service.start()
        wait_for(lambda: self.service.snapshot()['task']['status'] == 'ready')
        key = self.service.snapshot()['task']['segments'][0]['key']
        self.service.path(key).write_bytes(b'corrupted')
        with self.assertRaisesRegex(ValueError, '缓存损坏'):
            self.service.request({'action': 'audio', 'key': key})
        self.assertFalse(self.service.snapshot()['task']['segments'][0]['ready'])


class DownloadTests(unittest.TestCase):
    def test_resumes_pinned_file_and_checks_hash_before_publish(self):
        payload = b'validated-model'
        manifest = {'id': 'Qwen/test', 'files': [{'path': 'model.safetensors', 'size': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}]}
        with tempfile.TemporaryDirectory() as directory, patch.object(worker, 'MODEL', manifest):
            target = pathlib.Path(directory)
            (target / 'model.safetensors.download').write_bytes(payload[:4])
            response = io.BytesIO(payload[4:]); response.status = 206; response.headers = {'Content-Range': f'bytes 4-{len(payload)-1}/{len(payload)}'}
            with patch.object(worker.urllib.request, 'urlopen', return_value=response) as fetch:
                download = worker.Download(target); download.run()
                self.assertEqual(fetch.call_args.args[0].get_header('Range'), 'bytes=4-')
            self.assertEqual((target / 'model.safetensors').read_bytes(), payload)
            self.assertTrue(download.snapshot()['installed'])
            self.assertEqual(download.snapshot()['status'], 'ready')

    def test_invalid_download_is_not_published(self):
        manifest = {'id': 'Qwen/test', 'files': [{'path': 'config.json', 'size': 3, 'sha256': '0' * 64}]}
        with tempfile.TemporaryDirectory() as directory, patch.object(worker, 'MODEL', manifest):
            response = io.BytesIO(b'bad'); response.status = 200; response.headers = {}
            with patch.object(worker.urllib.request, 'urlopen', return_value=response):
                download = worker.Download(pathlib.Path(directory)); download.run()
            self.assertFalse((pathlib.Path(directory) / 'config.json').exists())
            self.assertEqual(download.snapshot()['status'], 'error')


class LevelTests(unittest.TestCase):
    def test_gain_is_bounded_and_does_not_change_waveform_shape(self):
        import numpy as np
        samples = np.array([-.1, -.05, 0., .05, .1], dtype=np.float32)
        output = worker.level_audio(samples)
        gain = output[0] / samples[0]
        self.assertLessEqual(gain, 10 ** (.3))
        np.testing.assert_allclose(output, samples * gain, rtol=1e-6)

    def test_transient_peak_cannot_clip_after_level_matching(self):
        import numpy as np
        samples = np.zeros(24000, dtype=np.float32); samples[0] = .95; samples[1:] = .005
        output = worker.level_audio(samples)
        self.assertLessEqual(float(np.abs(output).max()), 10 ** (-1 / 20) + 1e-6)


if __name__ == '__main__': unittest.main()

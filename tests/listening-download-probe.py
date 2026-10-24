"""Opt-in small network probe: verify pinned config bytes and the model host's range support."""
import hashlib
import json
import pathlib
import urllib.request

manifest = json.loads((pathlib.Path(__file__).parents[1] / 'resources/tts/model.json').read_text(encoding='utf-8'))
for name in ('config.json', 'model.safetensors'):
    item = next(f for f in manifest['files'] if f['path'] == name)
    url = 'https://modelscope.cn/models/' + manifest['id'] + '/resolve/master/' + name
    headers = {'User-Agent': 'TauriView/0.1', **({'Range': 'bytes=0-15'} if name.endswith('safetensors') else {})}
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
        data = response.read(16 if name.endswith('safetensors') else item['size'] + 1)
        if name.endswith('safetensors'):
            assert response.status == 206, (response.status, dict(response.headers))
            assert response.headers['Content-Range'] == f"bytes 0-15/{item['size']}"
        else:
            assert hashlib.sha256(data).hexdigest() == item['sha256'], 'hosted config differs from validated model'
        print(name, response.status, len(data), response.headers.get('Content-Range', ''), flush=True)

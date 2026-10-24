"""Build interoperable StarDict packs from cached upstream data; no runtime downloads."""
import csv
import gzip
import hashlib
import json
import pathlib
import re
import shutil
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / '.dictionary-sources'
OUTPUT = ROOT / 'resources' / 'dictionaries'


def simplified_converter():
    mapping = {}
    for name in ['TSCharacters.txt', 'TSPhrases.txt']:
        for line in (SOURCE / name).read_text(encoding='utf-8').splitlines():
            if not line or line.startswith('#') or '\t' not in line:
                continue
            old, choices = line.split('\t', 1)
            mapping[old] = choices.split(' ')[0]
    longest = max(map(len, mapping))
    def convert(value):
        out, at = [], 0
        while at < len(value):
            for length in range(min(longest, len(value) - at), 0, -1):
                piece = value[at:at+length]
                if piece in mapping:
                    out.append(mapping[piece]); at += length; break
            else:
                out.append(value[at]); at += 1
        return ''.join(out)
    return convert


def dictzip(data):
    """RFC 1952 gzip with the DICT RA extra field (real dictzip, not renamed gzip)."""
    length, chunks = 58315, []
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    for at in range(0, len(data), length):
        chunks.append(compressor.compress(data[at:at+length]) + compressor.flush(zlib.Z_FULL_FLUSH))
    tail = compressor.flush(zlib.Z_FINISH)
    ra = struct.pack('<HHH', 1, length, len(chunks)) + b''.join(struct.pack('<H', len(c)) for c in chunks)
    extra = b'RA' + struct.pack('<H', len(ra)) + ra
    header = b'\x1f\x8b\x08\x04' + struct.pack('<I', 0) + b'\x02\xff' + struct.pack('<H', len(extra)) + extra
    packed = header + b''.join(chunks) + tail + struct.pack('<II', zlib.crc32(data), len(data) & 0xffffffff)
    assert gzip.decompress(packed) == data
    return packed


def emit(identifier, name, kind, entries, source, checksum, licenses):
    version = "2026-10-24"
    folder = OUTPUT / identifier
    folder.mkdir(parents=True, exist_ok=True)
    entries.sort(key=lambda e: (e[0].lower().encode(), e[0].encode()))
    data, index, aliases = bytearray(), bytearray(), set()
    for position, (word, reading, definition, synonyms) in enumerate(entries):
        record = reading.encode('utf-8') + b'\0' + definition.encode('utf-8')
        index += word.encode('utf-8') + b'\0' + struct.pack('>II', len(data), len(record))
        data += record
        aliases.update((alias, position) for alias in synonyms if alias and alias != word and '\0' not in alias)
    syn = b''.join(word.encode('utf-8') + b'\0' + struct.pack('>I', position)
                   for word, position in sorted(aliases, key=lambda pair: (pair[0].lower().encode(), pair[0].encode(), pair[1])))
    metadata = ["StarDict's dict ifo file", 'version=2.4.2', f'bookname={name}', f'wordcount={len(entries)}',
                f'idxfilesize={len(index)}', f'synwordcount={len(aliases)}', 'sametypesequence=tm',
                f'date={version}', f'website={source}', f'description=Offline text dictionary; source SHA256: {checksum}; see NOTICE.txt and license files.']
    (folder / f'{identifier}.ifo').write_text('\n'.join(metadata) + '\n', encoding='utf-8')
    (folder / f'{identifier}.idx.gz').write_bytes(gzip.compress(bytes(index), mtime=0))
    (folder / f'{identifier}.dict.dz').write_bytes(dictzip(bytes(data)))
    (folder / f'{identifier}.syn').write_bytes(syn)
    for license in licenses:
        shutil.copyfile(SOURCE / license, folder / license)
    (folder / 'NOTICE.txt').write_text(
        f'{name}\nSource: {source}\nSnapshot: {version}\nSource checksum: {checksum}\n'
        'Offline StarDict format conversion; definitions and readings come from the upstream dataset.\n'
        'OpenCC is used to normalize displayed Hanzi to Simplified Chinese and add search aliases.\n'
        'OpenCC mappings: https://github.com/BYVoid/OpenCC (Apache-2.0; see OpenCC.LICENSE).\n'
        + ('Source: mapull/chinese-dictionary, declared MIT by upstream. See mapull.README for its complete data provenance statement.\n'
           if kind != 'english' else 'ECDICT by skywind3000; MIT. Core selection: BNC/FRQ <= 30000, exam tags, Collins or Oxford core.\n'), encoding='utf-8')
    print(identifier, len(entries), 'entries,', len(aliases), 'aliases,', len(data), 'text bytes', flush=True)
    return dict(id=identifier, name=name, kind=kind, count=len(entries), version=version, source=source, enabled=True, builtin=True)


def version(path):
    return 'sha256-' + hashlib.sha256((SOURCE / path).read_bytes()).hexdigest()[:12]


def main():
    OUTPUT.mkdir(exist_ok=True, parents=True)
    convert = simplified_converter()
    english = []
    with (SOURCE / 'ecdict.csv').open(encoding='utf-8-sig', newline='') as file:
        for row in csv.DictReader(file):
            rank = lambda key: 0 < int(row.get(key) or 0) <= 30000
            if not (rank('bnc') or rank('frq') or row.get('tag') or int(row.get('collins') or 0) > 0 or row.get('oxford') == '1'):
                continue
            aliases = []
            for item in row.get('exchange', '').split('/'):
                if ':' in item:
                    prefix, form = item.split(':', 1)
                    # 0 is a lemma pointer, not a surface form of the current word.
                    if prefix not in ['0', '1'] and form:
                        aliases.append(form)
            meaning = row.get('translation', '').replace('\\n', '\n')
            english_meaning = row.get('definition', '').replace('\\n', '\n')
            if english_meaning:
                meaning += '\n\n' + english_meaning
            if meaning.strip():
                english.append((row['word'], row.get('phonetic', ''), meaning.strip(), aliases))
    manifest = [emit('ecdict-core', 'ECDICT 常用英汉词典', 'english', english,
                     'https://github.com/skywind3000/ECDICT', version('ecdict.csv'), ['ecdict.LICENSE', 'OpenCC.LICENSE'])]
    def read_records(name):
        text = (SOURCE / name).read_text(encoding='utf-8-sig')
        decoder, at, records = json.JSONDecoder(), 0, []
        while at < len(text):
            while at < len(text) and (text[at].isspace() or text[at] == ','): at += 1
            if at == len(text): break
            value, at = decoder.raw_decode(text, at)
            records.extend(value if isinstance(value, list) else [value])
        return records
    def flatten(value):
        if isinstance(value, str): return value
        if isinstance(value, list): return '\n'.join(filter(None, (flatten(v) for v in value)))
        if isinstance(value, dict): return ' '.join(str(value[k]) for k in ['book', 'text', 'content'] if value.get(k))
        return ''
    def word_entry(entry, extra=False):
        word, pinyin, definition = entry.get('word', ''), entry.get('pinyin', ''), entry.get('explanation', '')
        if not word or not pinyin or not definition: return None
        if extra:
            details = []
            for title, field in [('出处','source'), ('例句','example'), ('引用','quote'), ('典故','story'), ('用法','usage')]:
                text = flatten(entry.get(field))
                if text: details.append(title + '\n' + text)
            if details: definition += '\n\n【扩展资料】\n' + '\n\n'.join(details)
        return (convert(word), pinyin, convert(definition), [word])
    chinese = []
    for entry in read_records('mapull-word.json'):
        converted = word_entry(entry)
        if converted: chinese.append(converted)
    for entry in read_records('mapull-char.json'):
        word = entry.get('char', '')
        for pronunciation in entry.get('pronunciations', []):
            definitions = []
            for definition in pronunciation.get('explanations', []):
                meaning = definition.get('content', '')
                if not meaning: continue
                extra = flatten(definition.get('example'))
                definitions.append(meaning + ('\n' + extra if extra else ''))
            if word and pronunciation.get('pinyin') and definitions:
                chinese.append((convert(word), pronunciation['pinyin'], convert('\n\n'.join(definitions)), [word]))
    manifest.append(emit('mapull-chinese', '汉语词典', 'chinese', chinese,
                         'https://github.com/mapull/chinese-dictionary', version('mapull-word.json'), ['mapull.LICENSE', 'mapull.README', 'OpenCC.LICENSE']))
    idioms = [word_entry(entry, extra=True) for entry in read_records('mapull-idiom.json')]
    manifest.append(emit('mapull-idioms', '成语词典', 'idiom', [entry for entry in idioms if entry],
                         'https://github.com/mapull/chinese-dictionary', version('mapull-idiom.json'),
                         ['mapull.LICENSE', 'mapull.README', 'OpenCC.LICENSE']))
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Built', len(manifest), 'StarDict packs', flush=True)


if __name__ == '__main__':
    main()

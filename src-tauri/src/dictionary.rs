use flate2::read::MultiGzDecoder;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs::{self, File}, io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}, sync::Mutex};
use tauri::Manager;

const MAX_INDEX: u64 = 128 * 1024 * 1024;
const MAX_DICT: u64 = 1024 * 1024 * 1024;
const MAX_ENTRY: usize = 2 * 1024 * 1024;
pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub count: usize,
    pub version: String,
    pub source: String,
    pub enabled: bool,
    pub builtin: bool,
}
#[derive(Clone)]
struct Entry { word: String, offset: u64, size: usize }
struct Dictionary {
    info: PackInfo,
    entries: Vec<Entry>,
    keys: HashMap<String, Vec<usize>>,
    sequence: String,
    data: PathBuf,
}
#[derive(Default)]
pub struct DictionaryState(Mutex<HashMap<String, Dictionary>>);

#[derive(Clone, Serialize)]
pub struct Section { pub format: String, pub text: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupEntry {
    pub word: String, pub dictionary: String, pub dictionary_id: String,
    pub kind: String, pub source: String, pub version: String, pub sections: Vec<Section>,
}

fn read_bounded(path: &Path, max: u64) -> Result<Vec<u8>> {
    let file = File::open(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
    let compressed = matches!(path.extension().and_then(|x| x.to_str()), Some("gz" | "dz"));
    let reader: Box<dyn Read> = if compressed { Box::new(MultiGzDecoder::new(file)) } else { Box::new(file) };
    let mut data = Vec::new();
    reader.take(max + 1).read_to_end(&mut data).map_err(|e| format!("解码失败：{e}"))?;
    if data.len() as u64 > max { return Err("词典文件超过支持的大小".into()); }
    Ok(data)
}
fn field<'a>(bytes: &'a [u8], at: &mut usize, length: usize) -> Result<&'a [u8]> {
    let end = at.checked_add(length).filter(|end| *end <= bytes.len()).ok_or("词典数据被截断")?;
    let value = &bytes[*at..end]; *at = end; Ok(value)
}
fn terminated<'a>(bytes: &'a [u8], at: &mut usize) -> Result<&'a [u8]> {
    let length = bytes.get(*at..).and_then(|tail| tail.iter().position(|x| *x == 0)).ok_or("词典文本缺少结束符")?;
    let value = field(bytes, at, length)?; *at += 1; Ok(value)
}
fn text(bytes: &[u8]) -> Result<String> { String::from_utf8(bytes.to_vec()).map_err(|_| "词典必须使用 UTF-8 编码".into()) }
fn number(bytes: &[u8]) -> u64 { bytes.iter().fold(0, |n, byte| (n << 8) | u64::from(*byte)) }
fn key(word: &str) -> String { word.trim().to_lowercase() }

pub fn sections(bytes: &[u8], sequence: &str) -> Result<Vec<Section>> {
    let mut at = 0;
    let mut result = Vec::new();
    let types: Vec<u8> = sequence.bytes().collect();
    let mut index = 0;
    while at < bytes.len() || (!types.is_empty() && index < types.len()) {
        let kind = if types.is_empty() { field(bytes, &mut at, 1)?[0] }
            else { *types.get(index).ok_or("词条类型数量不匹配")? };
        if !kind.is_ascii_alphabetic() { return Err("词条类型无效".into()); }
        let last = !types.is_empty() && index + 1 == types.len();
        let value = if last { let length = bytes.len() - at; field(bytes, &mut at, length)? }
            else if kind.is_ascii_uppercase() {
                let length = number(field(bytes, &mut at, 4)?) as usize;
                field(bytes, &mut at, length)?
            } else { terminated(bytes, &mut at)? };
        if kind.is_ascii_lowercase() {
            let format = match kind { b't' => "phonetic", b'h' | b'g' => "html", b'x' => "xdxf", _ => "text" };
            result.push(Section { format: format.into(), text: text(value)? });
        }
        index += 1;
    }
    if !types.is_empty() && index != types.len() { return Err("词条类型数量不匹配".into()); }
    Ok(result)
}

fn load(path: &Path, id: String, kind: String, builtin: bool, enabled: bool) -> Result<Dictionary> {
    let raw = String::from_utf8(read_bounded(path, 65536)?).map_err(|_| "无效的词典信息文件")?;
    let mut lines = raw.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim_end) != Some("StarDict's dict ifo file") { return Err("不是 StarDict 词典".into()); }
    let meta: HashMap<&str, &str> = lines.filter_map(|line| line.trim_end().split_once('=')).collect();
    if !matches!(meta.get("version"), Some(&"2.4.2" | &"3.0.0")) { return Err("仅支持 StarDict 2.4.2 / 3.0.0".into()); }
    let bits = meta.get("idxoffsetbits").copied().unwrap_or("32");
    let width = match bits { "32" => 4, "64" => 8, _ => return Err("无效的索引偏移位数".into()) };
    let idx = path.with_extension("idx");
    let idx = if idx.exists() { idx } else { path.with_extension("idx.gz") };
    let bytes = read_bounded(&idx, MAX_INDEX)?;
    let expected_size: usize = meta.get("idxfilesize").ok_or("缺少索引大小")?.parse().map_err(|_| "无效索引大小")?;
    if expected_size != bytes.len() { return Err("词典索引大小不匹配".into()); }
    let mut data = path.with_extension("dict");
    // dictzip 在第一次使用时展开成缓存副本；以后只按偏移读取词条。
    if !data.exists() {
        let compressed = path.with_extension("dict.dz");
        let cache = path.with_extension("dict.cache");
        if !cache.exists() {
            let decoded = read_bounded(&compressed, MAX_DICT)?;
            let temporary = path.with_extension("dict.cache.tmp");
            fs::write(&temporary, decoded).map_err(|e| e.to_string())?;
            fs::rename(&temporary, &cache).map_err(|e| e.to_string())?;
        }
        data = cache;
    }
    let data_len = fs::metadata(&data).map_err(|e| e.to_string())?.len();
    if data_len > MAX_DICT { return Err("词典正文超过 1 GiB".into()); }
    let mut entries = Vec::new(); let mut keys: HashMap<String, Vec<usize>> = HashMap::new(); let mut at = 0;
    while at < bytes.len() {
        let word = text(terminated(&bytes, &mut at)?)?;
        if word.is_empty() { return Err("词典包含空词头".into()); }
        let offset = number(field(&bytes, &mut at, width)?);
        let size = number(field(&bytes, &mut at, 4)?) as usize;
        if size > MAX_ENTRY || offset.checked_add(size as u64).filter(|end| *end <= data_len).is_none() { return Err("词条偏移或长度越界".into()); }
        keys.entry(key(&word)).or_default().push(entries.len());
        entries.push(Entry { word, offset, size });
    }
    let expected: usize = meta.get("wordcount").ok_or("缺少词条数")?.parse().map_err(|_| "无效词条数")?;
    if expected != entries.len() { return Err("词条数量与索引不符".into()); }
    let syn = path.with_extension("syn");
    if syn.exists() {
        let bytes = read_bounded(&syn, MAX_INDEX)?; let mut at = 0; let mut count = 0;
        while at < bytes.len() {
            let alias = text(terminated(&bytes, &mut at)?)?;
            let target = number(field(&bytes, &mut at, 4)?) as usize;
            if target >= entries.len() { return Err("别名索引越界".into()); }
            keys.entry(key(&alias)).or_default().push(target); count += 1;
        }
        if meta.get("synwordcount").and_then(|x| x.parse::<usize>().ok()) != Some(count) { return Err("别名数量与索引不符".into()); }
    }
    let name = meta.get("bookname").ok_or("缺少词典名称")?.to_string();
    Ok(Dictionary {
        info: PackInfo { id, name, kind, count: entries.len(), enabled, builtin,
            version: meta.get("date").unwrap_or(&"").to_string(), source: meta.get("website").unwrap_or(&"").to_string() },
        entries, keys, sequence: meta.get("sametypesequence").unwrap_or(&"").to_string(), data,
    })
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("dictionaries");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?; Ok(dir)
}
fn preferences(root: &Path) -> HashMap<String, bool> {
    fs::read(root.join("enabled.json")).ok().and_then(|data| serde_json::from_slice(&data).ok()).unwrap_or_default()
}
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err("无效的词典标识".into()); }
    Ok(())
}
fn ensure_loaded(app: &tauri::AppHandle, state: &DictionaryState) -> Result<()> {
    let root = root(app)?;
    let manifest_path = app.path().resource_dir().map_err(|e| e.to_string())?.join("dictionaries/manifest.json");
    let manifest: Vec<serde_json::Value> = serde_json::from_slice(&fs::read(manifest_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let prefs = preferences(&root);
    let mut maps = state.0.lock().map_err(|e| e.to_string())?;
    maps.retain(|id, dict| !dict.info.builtin || manifest.iter().any(|entry| entry["id"].as_str() == Some(id.as_str())));
    for entry in manifest {
        let id = entry["id"].as_str().ok_or("词典清单损坏")?;
        validate_id(id)?;
        let enabled = *prefs.get(id).unwrap_or(&true);
        let dir = root.join(id); fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let source_dir = app.path().resource_dir().map_err(|e| e.to_string())?.join(format!("dictionaries/{id}"));
        let update = fs::read(source_dir.join(format!("{id}.ifo"))).ok() != fs::read(dir.join(format!("{id}.ifo"))).ok();
        if !update {
            if let Some(dict) = maps.get_mut(id) { dict.info.enabled = enabled; continue; }
        }
        maps.remove(id);
        if update {
            let cache = dir.join(format!("{id}.dict.cache"));
            if cache.exists() { fs::remove_file(cache).map_err(|e| e.to_string())?; }
        }
        for item in fs::read_dir(&source_dir).map_err(|e| e.to_string())? {
            let source = item.map_err(|e| e.to_string())?.path();
            if !source.is_file() { continue; }
            let target = dir.join(source.file_name().ok_or("词典资源名称无效")?);
            if update || !target.exists() { fs::copy(source, target).map_err(|e| e.to_string())?; }
        }
        let dict = load(&dir.join(format!("{id}.ifo")), id.into(), entry["kind"].as_str().unwrap_or("chinese").into(), true, enabled)?;
        maps.insert(id.into(), dict);
    }
    for item in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        let Some(id) = path.file_name().and_then(|x| x.to_str()).filter(|x| x.starts_with("custom-")) else { continue; };
        if maps.contains_key(id) { continue; }
        let kind = fs::read_to_string(path.join("kind.txt")).unwrap_or_else(|_| "chinese".into());
        let dict = load(&path.join("dictionary.ifo"), id.into(), kind, false, *prefs.get(id).unwrap_or(&true))?;
        maps.insert(id.into(), dict);
    }
    Ok(())
}

#[tauri::command]
pub async fn list_dictionaries(app: tauri::AppHandle, state: tauri::State<'_, DictionaryState>) -> Result<Vec<PackInfo>> {
    ensure_loaded(&app, &state)?;
    let mut list: Vec<_> = state.0.lock().map_err(|e| e.to_string())?.values().map(|dict| dict.info.clone()).collect();
    list.sort_by(|a, b| a.id.cmp(&b.id)); Ok(list)
}
#[tauri::command]
pub async fn set_dictionary_enabled(app: tauri::AppHandle, state: tauri::State<'_, DictionaryState>, id: String, enabled: bool) -> Result<()> {
    validate_id(&id)?; ensure_loaded(&app, &state)?;
    let root = root(&app)?;
    let mut maps = state.0.lock().map_err(|e| e.to_string())?;
    let dict = maps.get_mut(&id).ok_or("找不到词典")?;
    let mut prefs = preferences(&root); prefs.insert(id, enabled);
    let temp = root.join("enabled.json.tmp");
    fs::write(&temp, serde_json::to_vec(&prefs).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(temp, root.join("enabled.json")).map_err(|e| e.to_string())?;
    dict.info.enabled = enabled; Ok(())
}
#[tauri::command]
pub async fn import_dictionary(app: tauri::AppHandle, state: tauri::State<'_, DictionaryState>, path: String, kind: String) -> Result<PackInfo> {
    if !matches!(kind.as_str(), "english" | "chinese" | "idiom") { return Err("请选择词典类别".into()); }
    let source = PathBuf::from(path);
    if source.extension().and_then(|x| x.to_str()) != Some("ifo") { return Err("请选择解压后的 .ifo 文件".into()); }
    let root = root(&app)?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let id = format!("custom-{nonce}");
    let stage = root.join(format!(".import-{nonce}")); fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        for (plain, compressed, max) in [("ifo", "ifo", 65536), ("idx", "idx.gz", MAX_INDEX), ("dict", "dict.dz", MAX_DICT)] {
            let from = if source.with_extension(plain).exists() { source.with_extension(plain) } else { source.with_extension(compressed) };
            let data = read_bounded(&from, max)?;
            fs::write(stage.join(format!("dictionary.{plain}")), data).map_err(|e| e.to_string())?;
        }
        if source.with_extension("syn").exists() { fs::write(stage.join("dictionary.syn"), read_bounded(&source.with_extension("syn"), MAX_INDEX)?).map_err(|e| e.to_string())?; }
        fs::write(stage.join("kind.txt"), &kind).map_err(|e| e.to_string())?;
        let mut dictionary = load(&stage.join("dictionary.ifo"), id.clone(), kind, false, true)?;
        let target = root.join(&id);
        fs::rename(&stage, &target).map_err(|e| e.to_string())?;
        dictionary.data = target.join("dictionary.dict");
        let info = dictionary.info.clone();
        state.0.lock().map_err(|e| e.to_string())?.insert(id, dictionary);
        Ok(info)
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&stage); }
    result
}

fn candidates(query: &str) -> Vec<String> {
    let value = key(query.trim_matches(|c: char| !c.is_alphanumeric()));
    let mut forms = vec![value.clone()];
    if value.is_ascii() && value.len() > 3 {
        for ending in ["s", "es", "ed", "ing"] {
            if let Some(stem) = value.strip_suffix(ending).filter(|stem| stem.len() > 1) {
                forms.push(stem.into());
                if ending == "ed" || ending == "ing" { forms.push(format!("{stem}e"));
                    let chars: Vec<_> = stem.chars().collect();
                    if chars.len() > 2 && chars[chars.len()-1] == chars[chars.len()-2] { forms.push(stem[..stem.len()-1].into()); }
                }
            }
        }
        for ending in ["ies", "ied"] { if let Some(stem) = value.strip_suffix(ending) { forms.push(format!("{stem}y")); } }
    }
    forms
}
#[tauri::command]
pub async fn lookup_dictionary(app: tauri::AppHandle, state: tauri::State<'_, DictionaryState>, query: String) -> Result<Vec<LookupEntry>> {
    if query.chars().count() > 80 { return Err("请选择一个词或短语查询".into()); }
    ensure_loaded(&app, &state)?;
    let maps = state.0.lock().map_err(|e| e.to_string())?;
    let mut dictionaries: Vec<_> = maps.values().filter(|dict| dict.info.enabled).collect();
    if dictionaries.is_empty() { return Err("没有启用的本地词典，请在设置中启用或导入词典".into()); }
    dictionaries.sort_by_key(|dict| (if dict.info.kind == "idiom" { 0 } else { 1 }, &dict.info.id));
    let mut output = Vec::new();
    for dict in dictionaries {
        let forms = candidates(&query);
        let exact = dict.keys.contains_key(&forms[0]);
        let mut seen = Vec::new();
        for form in forms.iter().take(if exact { 1 } else { forms.len() }) {
            for &position in dict.keys.get(form).into_iter().flatten() {
                if seen.contains(&position) || seen.len() >= 8 { continue; } seen.push(position);
                let entry = &dict.entries[position];
                let mut file = File::open(&dict.data).map_err(|e| e.to_string())?;
                file.seek(SeekFrom::Start(entry.offset)).map_err(|e| e.to_string())?;
                let mut bytes = vec![0; entry.size]; file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
                output.push(LookupEntry { word: entry.word.clone(), dictionary: dict.info.name.clone(), dictionary_id: dict.info.id.clone(),
                    kind: dict.info.kind.clone(), source: dict.info.source.clone(), version: dict.info.version.clone(), sections: sections(&bytes, &dict.sequence)? });
            }
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("tauriview-dictionary-{}-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&path).unwrap(); Self(path)
        }
        fn pack(&self, offset64: bool) -> PathBuf {
            let path = self.0.join("test.ifo");
            let mut index = b"bank\0".to_vec();
            if offset64 { index.extend_from_slice(&0_u64.to_be_bytes()); } else { index.extend_from_slice(&0_u32.to_be_bytes()); }
            index.extend_from_slice(&7_u32.to_be_bytes());
            fs::write(path.with_extension("idx"), &index).unwrap();
            fs::write(path.with_extension("dict"), b"IPA\0def").unwrap();
            fs::write(&path, format!("StarDict's dict ifo file\nversion={}\nbookname=Test\nwordcount=1\nidxfilesize={}\nidxoffsetbits={}\nsametypesequence=tm\n",
                if offset64 { "3.0.0" } else { "2.4.2" }, index.len(), if offset64 { 64 } else { 32 })).unwrap();
            path
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn open(path: &Path) -> Result<Dictionary> { load(path, "test".into(), "english".into(), false, true) }
    fn definitions(dict: &Dictionary, query: &str) -> Vec<String> {
        dict.keys.get(&key(query)).unwrap().iter().map(|&id| {
            let entry = &dict.entries[id];
            let mut file = File::open(&dict.data).unwrap(); file.seek(SeekFrom::Start(entry.offset)).unwrap();
            let mut bytes = vec![0; entry.size]; file.read_exact(&mut bytes).unwrap();
            sections(&bytes, &dict.sequence).unwrap().into_iter().map(|s| s.text).collect::<Vec<_>>().join("\n")
        }).collect()
    }
    #[test]
    fn parses_32_and_64_bit_indices() {
        for bits in [false, true] { let fixture = Fixture::new(); let path = fixture.pack(bits);
            let dictionary = open(&path).unwrap();
            assert_eq!(definitions(&dictionary, "BANK"), vec!["IPA\ndef"]);
        }
    }
    #[test]
    fn supports_synonyms_and_rejects_broken_targets() {
        let fixture = Fixture::new(); let path = fixture.pack(false);
        let mut info = fs::read_to_string(&path).unwrap(); info.push_str("synwordcount=1\n"); fs::write(&path, info).unwrap();
        let mut syn = b"banks\0".to_vec(); syn.extend_from_slice(&0_u32.to_be_bytes());
        fs::write(path.with_extension("syn"), &syn).unwrap();
        assert_eq!(definitions(&open(&path).unwrap(), "banks"), vec!["IPA\ndef"]);
        syn[9] = 9; fs::write(path.with_extension("syn"), syn).unwrap();
        assert!(open(&path).err().unwrap().contains("别名索引"));
    }
    #[test]
    fn rejects_offsets_sizes_counts_and_truncated_text() {
        let fixture = Fixture::new(); let path = fixture.pack(false);
        fs::write(path.with_extension("dict"), b"short").unwrap();
        assert!(open(&path).err().unwrap().contains("越界"));
        let path = fixture.pack(false); let mut idx = fs::read(path.with_extension("idx")).unwrap(); idx.truncate(3);
        fs::write(path.with_extension("idx"), idx).unwrap();
        assert!(open(&path).is_err());
        assert!(sections(b"mno-terminator", "").is_err());
    }
    #[test]
    fn decodes_typed_text_and_skips_binary_resources() {
        let fields = sections(b"tIPA\0mmeaning\0", "").unwrap();
        assert_eq!(fields[0].format, "phonetic"); assert_eq!(fields[1].text, "meaning");
        assert_eq!(sections(b"IPA\0", "tm").unwrap()[1].text, "");
        let fields = sections(b"W\0\0\0\x03abcmtail\0", "").unwrap();
        assert_eq!(fields.len(), 1); assert_eq!(fields[0].text, "tail");
        assert!(sections(b"W\0\0\0\x09abc", "").is_err());
    }
    #[test]
    fn real_bundles_have_pinyin_simplified_aliases_and_english_inflections() {
        // 以 manifest 为准：中文/成语包可能换成本地版本，dev 上则是 mapull 包
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/dictionaries");
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join("manifest.json")).unwrap()).unwrap();
        for pack in manifest.as_array().unwrap() {
            let id = pack["id"].as_str().unwrap();
            let kind = pack["kind"].as_str().unwrap();
            let source = root.join(id);
            if !source.is_dir() { continue; }
            let fixture = Fixture::new();
            for extension in ["ifo", "idx.gz", "dict.dz", "syn"] {
                fs::copy(source.join(format!("{id}.{extension}")), fixture.0.join(format!("{id}.{extension}"))).unwrap();
            }
            let dict = open(&fixture.0.join(format!("{id}.ifo"))).unwrap();
            match kind {
                "english" => {
                    assert!(dict.keys.contains_key("went"));
                    assert!(dict.keys["went"].iter().any(|&index| dict.entries[index].word == "go"));
                    assert!(definitions(&dict, "read").iter().any(|text| text.contains("读")));
                }
                "chinese" => {
                    assert!(definitions(&dict, "银行").iter().any(|text| text.contains("háng")));
                    assert!(!definitions(&dict, "行").is_empty());
                }
                _ => {
                    assert!(dict.keys.contains_key("望梅止渴"));
                    assert!(dict.keys.contains_key("画蛇添足"));
                    assert!(!definitions(&dict, "画蛇添足").is_empty());
                    // 本地 EuDic 转换包只保留释义，不应再带出处/扩展资料
                    if pack["source"].as_str().unwrap_or("").contains("EuDic") {
                        assert!(definitions(&dict, "画蛇添足").iter().all(|text| !text.contains("【出处】") && !text.contains("【扩展资料】")));
                    }
                }
            }
        }
    }
}

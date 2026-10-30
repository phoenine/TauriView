//! Obsidian's existing Book / Flashcard schema. Existing notes are never rewritten.
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::{Path, PathBuf}};

#[derive(Deserialize)]
pub struct ExportBook {
    id: String,
    title: String,
    author: String,
    created: String,
    items: Vec<ExportCard>,
}

#[derive(Deserialize)]
struct ExportCard {
    id: String,
    quote: String,
    insight: String,
    chapter: String,
    created: String,
    #[serde(rename = "fileStamp")]
    file_stamp: String,
    cfi: String,
    percent: f64,
}

#[derive(Debug, Default, Serialize)]
pub struct ExportResult {
    books: usize,
    cards: usize,
    skipped: usize,
}

fn quoted(value: &str) -> String { serde_json::to_string(value).unwrap() }

fn frontmatter(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start_matches('\u{feff}');
    // Templater may prepend its rename script before the opening delimiter.
    let start = text.find("---")?;
    let rest = text[start + 3..].strip_prefix("\r\n")
        .or_else(|| text[start + 3..].strip_prefix('\n'))?;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some((&rest[..offset], &rest[offset + line.len()..]));
        }
        offset += line.len();
    }
    None
}

/// Only the simple top-level identity fields are needed; keep the original YAML
/// scalar for book_key so numeric keys and quoted string keys retain their types.
fn field(text: &str, name: &str) -> Option<(String, String)> {
    let (head, _) = frontmatter(text)?;
    let raw = head.lines().find_map(|line| line.strip_prefix(&format!("{name}:")))?.trim();
    let value = if raw.starts_with('"') {
        let mut stream = serde_json::Deserializer::from_str(raw).into_iter::<String>();
        stream.next()?.ok()?
    } else if raw.starts_with('\'') {
        let inside = raw.strip_prefix('\'')?;
        let mut value = String::new();
        let mut chars = inside.chars().peekable();
        loop {
            match chars.next()? {
                '\'' if chars.peek() == Some(&'\'') => { chars.next(); value.push('\''); }
                '\'' => break,
                c => value.push(c),
            }
        }
        value
    } else {
        raw.split(" #").next()?.trim_end().to_string()
    };
    if value.is_empty() || matches!(value.as_str(), "null" | "~" | "|" | ">") { return None; }
    let scalar = if raw.starts_with(['"', '\'']) { quoted(&value) }
        else { raw.split(" #").next()?.trim_end().to_string() };
    Some((value, scalar))
}

fn normalized(title: &str) -> String {
    title.trim().trim_start_matches('《').trim_end_matches('》').trim().to_lowercase()
}

fn filename(title: &str) -> String {
    let value: String = title.chars().map(|c| {
        if c.is_control() || "<>:\"/\\|?*#[]^".contains(c) { '_' } else { c }
    }).take(80).collect();
    let value = value.trim().trim_end_matches('.');
    if value.is_empty() { "未命名书籍".into() } else { value.into() }
}

fn card_name(stamp: &str, index: usize) -> Result<String, String> {
    // The timestamp comes from the annotation's local creation time. Validate it
    // before using it in a path; colliding seconds receive a readable suffix.
    let parts: Vec<_> = stamp.split('-').collect();
    let ranges = [(1, 9999), (1, 12), (1, 31), (0, 23), (0, 59), (0, 59)];
    if parts.len() != 6 || parts.iter().enumerate().any(|(i, part)| {
        part.len() != if i == 0 { 4 } else { 2 }
            || !part.bytes().all(|c| c.is_ascii_digit())
            || part.parse::<u32>().map_or(true, |n| n < ranges[i].0 || n > ranges[i].1)
    }) {
        return Err("摘抄创建时间无效，无法生成读书卡片文件名".into());
    }
    let suffix = if index == 1 { String::new() } else { format!("_{index}") };
    Ok(format!("文章摘要_{stamp}{suffix}.md"))
}

fn chapter_number(path: &str) -> String {
    for part in path.split(['›', '>']) {
        let part = part.trim();
        if let Some(after) = part.strip_prefix('第') {
            if let Some((number, _)) = after.split_once('章') {
                if !number.is_empty() && number.chars().all(|c| c.is_numeric() || "零〇一二三四五六七八九十百千万两".contains(c)) {
                    return number.into();
                }
            }
        }
    }
    String::new()
}

fn load_template(vault: &Path, name: &str, fallback: &str) -> Result<String, String> {
    let path = vault.join("Template").join(name);
    if !path.exists() { return Ok(fallback.into()); }
    let text = fs::read_to_string(&path).map_err(|e| format!("无法读取模板 {}：{e}", path.display()))?;
    if frontmatter(&text).is_none() {
        return Err(format!("模板 {} 缺少完整的 YAML 属性区", path.display()));
    }
    Ok(text)
}

/// Replace only populated export fields; preserve custom properties, defaults,
/// lists and the entire template body. Templater's leading rename script is omitted.
fn apply_template(template: &str, fields: &[(&str, String)]) -> String {
    let (head, body) = frontmatter(template).unwrap();
    let mut rendered = String::from("---\n");
    let mut seen = std::collections::HashSet::new();
    let mut replacing = false;
    for line in head.lines() {
        let top_level = !line.starts_with(char::is_whitespace);
        if top_level {
            if let Some((key, _)) = line.split_once(':') {
                if let Some((_, value)) = fields.iter().find(|(name, _)| *name == key) {
                    rendered.push_str(&format!("{key}: {value}\n"));
                    seen.insert(key.to_string());
                    replacing = true;
                    continue;
                }
                replacing = false;
            }
        }
        if replacing && (line.trim().is_empty() || !top_level) { continue; }
        replacing = false;
        rendered.push_str(line);
        rendered.push('\n');
    }
    for (key, value) in fields {
        if !seen.contains(*key) { rendered.push_str(&format!("{key}: {value}\n")); }
    }
    rendered.push_str("---\n");
    rendered.push_str(body);
    rendered
}

struct BookNote { path: PathBuf, text: String }
struct Pending { path: PathBuf, text: String, book: bool }

#[tauri::command]
pub fn validate_obsidian_vault(vault: String) -> Result<(), String> {
    if !Path::new(&vault).join(".obsidian").is_dir() {
        return Err("请选择包含 .obsidian 文件夹的 Obsidian 仓库根目录".into());
    }
    Ok(())
}

#[tauri::command]
pub fn export_obsidian(vault: String, groups: Vec<ExportBook>) -> Result<ExportResult, String> {
    export(Path::new(&vault), groups)
}

fn export(vault: &Path, groups: Vec<ExportBook>) -> Result<ExportResult, String> {
    if !vault.join(".obsidian").is_dir() {
        return Err("请选择包含 .obsidian 文件夹的 Obsidian 仓库根目录".into());
    }
    let book_dir = vault.join("Books");
    let card_dir = vault.join("读书卡片");
    // Identity lives in frontmatter, so renamed and legacy hash-named cards also
    // remain idempotent. Never depend on a filename to detect an existing export.
    let mut existing_cards = std::collections::HashSet::new();
    if card_dir.exists() {
        for entry in fs::read_dir(&card_dir).map_err(|e| format!("无法读取读书卡片：{e}"))? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") { continue; }
            let text = fs::read_to_string(&path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
            if let (Some(book), Some(card)) = (field(&text, "tauriview_book_id"), field(&text, "tauriview_annotation_id")) {
                existing_cards.insert((book.0, card.0));
            }
        }
    }
    let mut notes = Vec::new();
    if book_dir.exists() {
        for entry in fs::read_dir(&book_dir).map_err(|e| format!("无法读取 Books：{e}"))? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) == Some("md") {
                let text = fs::read_to_string(&path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
                notes.push(BookNote { path, text });
            }
        }
    }
    let book_template = load_template(vault, "Book.md",
        "---\nstart:\nbook_key:\ncover:\nname:\nauthor:\ndescription:\nscore:\ncategory:\nsource:\nstatus:\n---\n\n## 读书卡片\n\n```dataview\nTABLE quote AS 原文, insight AS 批注 FROM \"读书卡片\"\nWHERE book_key = this.book_key\n```\n")?;
    let card_template = load_template(vault, "Flashcard.md",
        "---\ncreated:\nbook_key:\nquote:\nbook:\ninsight:\nchapter:\npage:\ntags:\nmood:\n---\n\n## 思考卡片\n\n> [!note] Topic\n> \n\n> [!abstract] Initial Understanding\n> \n\n> [!tip] Explanation for a kid\n> \n\n> [!warning] Knowledge Gap\n> \n\n> [!example] Analogy\n> \n\n> [!success] Final Explanation\n")?;
    let mut pending = Vec::new();
    let mut planned_paths = std::collections::HashSet::new();
    let mut reserved_cards = std::collections::HashSet::new();
    let mut result = ExportResult::default();
    for book in groups {
        if book.items.is_empty() { continue; }
        let matches: Vec<_> = notes.iter().filter(|note| {
            let title_match = normalized(note.path.file_stem().and_then(|s| s.to_str()).unwrap_or("")) == normalized(&book.title)
                || field(&note.text, "name").is_some_and(|(name, _)| normalized(&name) == normalized(&book.title));
            let id_match = field(&note.text, "tauriview_book_id").is_some_and(|(id, _)| id == book.id);
            title_match || id_match
        }).collect();
        if matches.len() > 1 { return Err(format!("《{}》匹配到多个书籍页，请先在 Books 中消除重名", book.title)); }
        let (book_path, key) = if let Some(note) = matches.first() {
            let key = field(&note.text, "book_key")
                .ok_or_else(|| format!("{} 缺少可用的 book_key，请先在 Obsidian 中填写", note.path.display()))?.1;
            (note.path.clone(), key)
        } else {
            let path = book_dir.join(format!("《{}》.md", filename(&book.title)));
            let key = quoted(&format!("tauriview-{}", book.id));
            let text = apply_template(&book_template, &[
                ("start", quoted(&book.created)), ("book_key", key.clone()),
                ("name", quoted(&book.title)), ("author", format!("\n  - {}", quoted(&book.author))),
                ("tauriview_book_id", quoted(&book.id)),
            ]);
            notes.push(BookNote { path: path.clone(), text: text.clone() });
            pending.push(Pending { path: path.clone(), text, book: true });
            (path, key)
        };
        let link = format!("[[Books/{}]]", book_path.file_stem().unwrap().to_string_lossy());
        for card in book.items {
            if !existing_cards.insert((book.id.clone(), card.id.clone())) {
                result.skipped += 1;
                continue;
            }
            let mut index = 1;
            let path = loop {
                let candidate = card_dir.join(card_name(&card.file_stamp, index)?);
                if !candidate.exists() && reserved_cards.insert(candidate.clone()) { break candidate; }
                index += 1;
            };
            let mut text = apply_template(&card_template, &[
                ("created", quoted(&card.created)), ("book_key", key.clone()),
                ("quote", quoted(&card.quote)), ("book", quoted(&link)),
                ("insight", quoted(&card.insight)), ("chapter", quoted(&chapter_number(&card.chapter))),
                ("chapter_path", quoted(&card.chapter)), ("tauriview_book_id", quoted(&book.id)),
                ("tauriview_annotation_id", quoted(&card.id)), ("tauriview_cfi", quoted(&card.cfi)),
                ("tauriview_percent", card.percent.to_string()),
            ]);
            if !card.insight.trim().is_empty() {
                text.push_str(&format!("\n\n## 批注\n\n{}\n", card.insight));
            }
            pending.push(Pending { path, text, book: false });
        }
    }
    // Validate every output before writing any of them.
    for item in &pending {
        if item.path.exists() || !planned_paths.insert(item.path.clone()) {
            return Err(format!("目标文件已存在或书名重复，已停止：{}", item.path.display()));
        }
    }
    fs::create_dir_all(&book_dir).and_then(|_| fs::create_dir_all(&card_dir)).map_err(|e| e.to_string())?;
    for item in pending {
        let write = || -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&item.path)?;
            if let Err(error) = file.write_all(item.text.as_bytes()).and_then(|_| file.sync_all()) {
                drop(file);
                let _ = fs::remove_file(&item.path);
                return Err(error);
            }
            Ok(())
        };
        write().map_err(|e| format!("已新增 {} 本书、{} 张卡片；写入 {} 失败：{e}。可重试，已有文件会跳过。",
            result.books, result.cards, item.path.display()))?;
        if item.book { result.books += 1; } else { result.cards += 1; }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(id: &str, title: &str) -> ExportBook {
        ExportBook { id: id.into(), title: title.into(), author: "作者".into(), created: "2026/10/29".into(),
            items: vec![ExportCard { id: "annotation-1".into(), quote: "原文\n第二行：\"引用\"".into(),
                insight: "AI 理解：\n**重点**\n- 条目".into(), chapter: "章节 › 小节".into(),
                created: "2026/10/29".into(), file_stamp: "2026-10-29-19-15-18".into(), cfi: "epubcfi(/6/2)".into(), percent: 0.2 }] }
    }

    #[test]
    fn exports_templates_links_keys_and_preserves_edits() {
        let dir = std::env::temp_dir().join(format!("tauriview-obsidian-test-{}", std::process::id()));
        fs::create_dir_all(dir.join(".obsidian")).unwrap();
        fs::create_dir_all(dir.join("Books")).unwrap();
        fs::create_dir_all(dir.join("Template")).unwrap();
        fs::write(dir.join("Template/Book.md"), "---\nstart: template\nauthor:\n  - 模板作者\ncustom: 自定义属性\n---\nBOOK BODY\n").unwrap();
        fs::write(dir.join("Template/Flashcard.md"), "<%* rename() %>---\nquote:\ntags:\n  - 阅读\nmood: happy\n---\nCARD BODY\n").unwrap();
        let original = "---\nbook_key: 895042278 # numeric identity\nname: 菜根谭\n---\n用户的正文";
        fs::write(dir.join("Books/《菜根谭》.md"), original).unwrap();
        let first = export(&dir, vec![group("book-1", "菜根谭"), group("book-2", "新书/标题")]).unwrap();
        assert_eq!((first.books, first.cards, first.skipped), (1, 2, 0));
        let path = dir.join("读书卡片/文章摘要_2026-10-29-19-15-18.md");
        assert!(dir.join("读书卡片/文章摘要_2026-10-29-19-15-18_2.md").exists());
        let card = fs::read_to_string(&path).unwrap();
        assert!(card.contains("book_key: 895042278\n"));
        assert_eq!(field(&card, "quote").unwrap().0, "原文\n第二行：\"引用\"");
        assert_eq!(field(&card, "book").unwrap().0, "[[Books/《菜根谭》]]");
        assert!(card.contains("CARD BODY") && card.contains("## 批注\n\nAI 理解：\n**重点**"));
        assert!(!card.contains("rename()"));
        assert!(card.contains("tags:\n  - 阅读\nmood: happy\n"));
        fs::write(&path, format!("{card}\n用户修改")).unwrap();
        let second = export(&dir, vec![group("book-1", "菜根谭"), group("book-2", "新书/标题")]).unwrap();
        assert_eq!((second.books, second.cards, second.skipped), (0, 0, 2));
        assert!(fs::read_to_string(path).unwrap().ends_with("用户修改"));
        assert_eq!(fs::read_to_string(dir.join("Books/《菜根谭》.md")).unwrap(), original);
        let new_book = fs::read_to_string(dir.join("Books/《新书_标题》.md")).unwrap();
        assert!(new_book.contains("BOOK BODY"));
        assert!(new_book.contains("custom: 自定义属性\n"));
        assert!(new_book.contains("author: \n  - \"作者\"\n"));
        assert!(!new_book.contains("模板作者"));
        assert_eq!(field(&new_book, "book_key").unwrap().0, "tauriview-book-2");
        assert_eq!(chapter_number("书名 › 第一卷 › 第十二章 小节"), "十二");
        assert_eq!(chapter_number("第3章 小节"), "3");
        assert_eq!(chapter_number("推荐序"), "");
        // Missing identities and ambiguous title matches fail before any new files.
        fs::write(dir.join("Books/《缺少标识》.md"), "---\nname: 缺少标识\n---\n").unwrap();
        assert!(export(&dir, vec![group("book-3", "缺少标识")]).unwrap_err().contains("book_key"));
        fs::write(dir.join("Books/副本.md"), original).unwrap();
        assert!(export(&dir, vec![group("book-1", "菜根谭")]).unwrap_err().contains("多个"));
        assert!(export(&dir.join("Books"), vec![]).unwrap_err().contains(".obsidian"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_templates_use_defaults_and_legacy_cards_are_recognized() {
        let dir = std::env::temp_dir().join(format!("tauriview-obsidian-fallback-test-{}", std::process::id()));
        fs::create_dir_all(dir.join(".obsidian")).unwrap();
        fs::create_dir_all(dir.join("读书卡片")).unwrap();
        let occupied = dir.join("读书卡片/文章摘要_2026-10-29-19-15-18.md");
        fs::write(&occupied, "用户已有的同名笔记").unwrap();
        let first = export(&dir, vec![group("book-1", "新书")]).unwrap();
        assert_eq!((first.books, first.cards), (1, 1));
        let path = dir.join("读书卡片/文章摘要_2026-10-29-19-15-18_2.md");
        let card = fs::read_to_string(&path).unwrap();
        assert!(card.contains("## 思考卡片") && card.contains("> [!abstract] Initial Understanding"));
        assert!(card.contains("## 批注") && card.contains("AI 理解："));
        assert_eq!(field(&card, "quote").unwrap().0, "原文\n第二行：\"引用\"");
        assert_eq!(fs::read_to_string(&occupied).unwrap(), "用户已有的同名笔记");
        let book = fs::read_to_string(dir.join("Books/《新书》.md")).unwrap();
        assert!(book.contains("WHERE book_key = this.book_key"));
        // Both a user rename and files created by the earlier exporter are safe.
        fs::rename(&path, dir.join("读书卡片/TauriView_f00fdec57ea15f7a.md")).unwrap();
        let second = export(&dir, vec![group("book-1", "新书")]).unwrap();
        assert_eq!((second.cards, second.skipped), (0, 1));
        assert!(card_name("../../bad", 1).is_err());
        assert!(card_name("2026-13-29-19-15-18", 1).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}

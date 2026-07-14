use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use notify_debouncer_full::notify::{Config, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer_opt, DebounceEventHandler, DebounceEventResult, Debouncer, NoCache,
};

/// 반드시 NoCache: macOS 기본 RecommendedCache(FileIdMap)는 watch 시작 시
/// walkdir로 트리 전체를 돌며 파일마다 stat해 파일ID를 모은다(rename 스티칭용).
/// 대형 폴더(수십만~수백만 파일)에선 프로젝트 열기가 수십 초씩 걸리는 원인이
/// 됐다. 우리는 이벤트 내용(rename 추적)을 전혀 보지 않고 "뭔가 바뀜"만 쓰므로
/// 캐시는 순수 낭비다.
type FileWatcher = Debouncer<RecommendedWatcher, NoCache>;

/// 공통 debouncer 생성 — NoCache 강제 (위 주석 참조).
fn md_debouncer<F: DebounceEventHandler>(
    timeout_ms: u64,
    handler: F,
) -> Result<FileWatcher, String> {
    new_debouncer_opt::<F, RecommendedWatcher, NoCache>(
        Duration::from_millis(timeout_ms),
        None,
        handler,
        NoCache::new(),
        Config::default(),
    )
    .map_err(|e| e.to_string())
}

/// Process-global buffer of file paths to open at startup.
///
/// MUST be a process global (not Tauri managed state): on macOS a cold-launch
/// `RunEvent::Opened` (or document state-restoration) can fire BEFORE `setup()`
/// runs `app.manage(...)`, so a managed-state lookup would be empty/None there
/// and the very first opened document would be silently dropped (the "first
/// Open-in-Default-App shows the app but no document; second time works" bug).
/// A global is available regardless of Tauri lifecycle timing.
static INITIAL: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();

fn initial_buf() -> &'static Mutex<Vec<PathBuf>> {
    INITIAL.get_or_init(|| Mutex::new(Vec::new()))
}

/// Managed application state: keeps the active debouncers alive, keyed by the
/// watched file path. Dropping a `Debouncer` stops its watch, so each must be
/// retained here. With tabs, several files are watched at once; `unwatch_file`
/// removes (drops) one when its tab closes.
struct AppState {
    watchers: Mutex<HashMap<String, FileWatcher>>,
    dir_watchers: Mutex<HashMap<String, FileWatcher>>,
}

/// Event payload for `file-opened` and `file-changed`.
#[derive(Clone, Serialize)]
struct FilePayload {
    path: String,
}

/// Drain and return any file paths buffered for opening at startup (from the
/// macOS `Opened` event or argv). The frontend calls this once on startup and
/// opens a tab per path. Returns an empty vec when there is nothing buffered.
#[tauri::command]
fn get_initial_file() -> Vec<String> {
    let mut buf = initial_buf().lock().unwrap();
    let out = buf.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    buf.clear();
    out
}

/// Read a file as a UTF-8 string.
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Start watching `path` for changes (idempotent per path).
///
/// Watches the PARENT directory non-recursively (not the file inode) because
/// editors like Zed atomic-save via temp file + rename, which would invalidate
/// an inode-level watch. Debounced events are filtered to the target file name.
/// A watcher already registered for the same `path` is replaced (and dropped).
#[tauri::command]
fn watch_file(
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target.parent().ok_or("no parent")?.to_path_buf();
    let fname = target.file_name().ok_or("no filename")?.to_os_string();
    let emit_path = path.clone();
    let handle = app.clone();

    let mut debouncer = md_debouncer(200, move |res: DebounceEventResult| {
        if let Ok(events) = res {
            let hit = events
                .iter()
                .any(|e| e.paths.iter().any(|p| p.file_name() == Some(fname.as_os_str())));
            if hit {
                let _ = handle.emit(
                    "file-changed",
                    FilePayload {
                        path: emit_path.clone(),
                    },
                );
            }
        }
    })?;

    debouncer
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    // Insert (replacing + dropping any prior watcher for this exact path).
    state.watchers.lock().unwrap().insert(path, debouncer);

    Ok(())
}

/// Stop watching `path` (called when its tab closes). Dropping the debouncer
/// stops the underlying watch.
#[tauri::command]
fn unwatch_file(path: String, state: tauri::State<AppState>) {
    state.watchers.lock().unwrap().remove(&path);
}

/// A node in the lazy project file tree (`scan_dir`). Files are markdown-only;
/// directories always appear (their children are fetched lazily, one level at
/// a time, so a directory shows up before we know whether any markdown lives
/// below it).
#[derive(Clone, Serialize)]
struct TreeNode {
    name: String,
    path: String,
    is_dir: bool,
}

/// Return value of `scan_dir`. `truncated` is set when the listing hit
/// SCAN_DIR_MAX_ENTRIES and stopped early.
#[derive(Clone, Serialize)]
struct ScanDirResult {
    children: Vec<TreeNode>,
    truncated: bool,
}

/// Entry cap for a single `scan_dir` level.
const SCAN_DIR_MAX_ENTRIES: usize = 5_000;

fn is_markdown_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

fn cmp_tree_name(a: &TreeNode, b: &TreeNode) -> std::cmp::Ordering {
    a.name.to_lowercase().cmp(&b.name.to_lowercase())
}

/// List ONE level of `dir` for the lazy project tree: markdown files plus all
/// subdirectories (no recursive pruning — that would defeat lazy loading, so
/// directories with no markdown below them do appear). Errs when `dir` is not
/// a directory — the frontend drop handler relies on this to tell folders
/// from stray non-markdown files. Dotfiles, `node_modules` and symlinks are
/// skipped; symlinks are never followed. Directories sort before files, each
/// name-sorted case-insensitively. Async + blocking thread: refreshes can
/// fan this out over many expanded dirs at once, and a slow volume must not
/// stall the main thread.
#[tauri::command]
async fn scan_dir(dir: String) -> Result<ScanDirResult, String> {
    tauri::async_runtime::spawn_blocking(move || scan_dir_inner(dir, SCAN_DIR_MAX_ENTRIES))
        .await
        .map_err(|e| e.to_string())?
}

/// Cap-injectable core of `scan_dir` (tests pass a tiny `max_entries` to
/// exercise the truncation boundary cheaply; the command uses the const).
fn scan_dir_inner(dir: String, max_entries: usize) -> Result<ScanDirResult, String> {
    let p = PathBuf::from(&dir);
    if !p.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    // `Err` is reserved for "not a directory" (the drop handler's folder-vs-file
    // signal); a readable-directory that nonetheless fails read_dir (e.g. a
    // permission race) yields empty children, not an error.
    let Ok(rd) = std::fs::read_dir(&p) else {
        return Ok(ScanDirResult {
            children: Vec::new(),
            truncated: false,
        });
    };
    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();
    let mut truncated = false;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let is_dir = ft.is_dir();
        // Skip non-collectible entries (non-markdown files) BEFORE the cap
        // check: only directories and markdown files count. Otherwise a
        // trailing dotfile/`.txt` on an otherwise-complete listing would flip
        // `truncated`.
        if !is_dir && !is_markdown_name(&name) {
            continue;
        }
        // Enforce the cap at PUSH time: truncate only when a collectible entry
        // can't be added because this level is already full.
        if dirs.len() + files.len() >= max_entries {
            truncated = true;
            break;
        }
        let path = entry.path().to_string_lossy().into_owned();
        if is_dir {
            dirs.push(TreeNode {
                name,
                path,
                is_dir: true,
            });
        } else {
            files.push(TreeNode {
                name,
                path,
                is_dir: false,
            });
        }
    }
    dirs.sort_by(cmp_tree_name);
    files.sort_by(cmp_tree_name);
    dirs.extend(files);
    Ok(ScanDirResult {
        children: dirs,
        truncated,
    })
}

/// One directory's one-level listing inside a deep scan (`scan_dir_deep`).
#[derive(Clone, Serialize)]
struct DeepDir {
    path: String,
    children: Vec<TreeNode>,
}

/// Return value of `scan_dir_deep`. `dirs` is in BFS order (parents before
/// children, root first) and PRUNED: directories whose scanned subtree holds
/// no markdown are dropped (from `dirs` and from their parents' `children`) —
/// the eager scan knows the whole subtree, so unlike lazy `scan_dir` it can
/// prune. Dirs beyond a truncation frontier are unknown and stay visible.
/// `truncated` is set when a budget ran out with work remaining, or any
/// single level hit its entry cap.
#[derive(Clone, Serialize)]
struct DeepScanResult {
    dirs: Vec<DeepDir>,
    truncated: bool,
}

/// Directory budget for one `scan_dir_deep` call.
const DEEP_SCAN_MAX_DIRS: usize = 20_000;
/// Aggregate entry budget across all levels of one `scan_dir_deep` call —
/// bounds the single IPC payload (the per-level cap alone would still allow
/// max_dirs × max_entries nodes in one response).
const DEEP_SCAN_MAX_TOTAL_ENTRIES: usize = 100_000;

/// Eagerly scan the WHOLE subtree under `dir` in one call (context-menu
/// "하위 전체 펼치기"): BFS over directories, each level listed with the same
/// rules as `scan_dir`, then md-less directories pruned. Runs on a blocking
/// thread — a large tree must not sit on the main thread. Errs only when
/// `dir` itself is not a directory; subdirectories that vanish mid-scan are
/// skipped silently.
#[tauri::command]
async fn scan_dir_deep(dir: String) -> Result<DeepScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        scan_dir_deep_inner(
            dir,
            DEEP_SCAN_MAX_DIRS,
            SCAN_DIR_MAX_ENTRIES,
            DEEP_SCAN_MAX_TOTAL_ENTRIES,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cap-injectable core of `scan_dir_deep`. `truncated` follows the
/// attempt-beyond-cap rule: it is set only when work was actually skipped
/// (queue non-empty at a budget), not when the scan ends exactly at cap.
fn scan_dir_deep_inner(
    dir: String,
    max_dirs: usize,
    max_entries: usize,
    max_total_entries: usize,
) -> Result<DeepScanResult, String> {
    let mut dirs: Vec<DeepDir> = Vec::new();
    let mut truncated = false;
    let mut total_entries = 0usize;
    let mut queue: VecDeque<String> = VecDeque::from([dir]);
    while let Some(d) = queue.pop_front() {
        if dirs.len() >= max_dirs || total_entries >= max_total_entries {
            truncated = true;
            break;
        }
        let res = match scan_dir_inner(d.clone(), max_entries) {
            Ok(r) => r,
            // Root not a directory → propagate (same contract as scan_dir);
            // a subdirectory that vanished between listing and scan → skip.
            Err(e) if dirs.is_empty() => return Err(e),
            Err(_) => continue,
        };
        if res.truncated {
            truncated = true;
        }
        total_entries += res.children.len();
        for c in &res.children {
            if c.is_dir {
                queue.push_back(c.path.clone());
            }
        }
        dirs.push(DeepDir {
            path: d,
            children: res.children,
        });
    }
    Ok(prune_deep(dirs, truncated))
}

/// Drop directories whose scanned subtree contains no markdown. Computed
/// bottom-up over the BFS list (children come after parents, so a reverse
/// pass sees every child's verdict first). A child dir that was never scanned
/// (beyond the truncation frontier or vanished mid-scan) is UNKNOWN and kept —
/// pruning must never hide a directory it didn't examine. The root (first
/// entry) is always kept: the user asked about that folder explicitly.
fn prune_deep(dirs: Vec<DeepDir>, truncated: bool) -> DeepScanResult {
    // path → "subtree has markdown". Files in `children` are md-only already.
    let mut has_md: HashMap<String, bool> = HashMap::with_capacity(dirs.len());
    for d in dirs.iter().rev() {
        let keep = d
            .children
            .iter()
            .any(|c| !c.is_dir || *has_md.get(&c.path).unwrap_or(&true));
        has_md.insert(d.path.clone(), keep);
    }
    let root = dirs.first().map(|d| d.path.clone());
    let dirs = dirs
        .into_iter()
        .filter(|d| Some(&d.path) == root.as_ref() || *has_md.get(&d.path).unwrap_or(&true))
        .map(|mut d| {
            d.children
                .retain(|c| !c.is_dir || *has_md.get(&c.path).unwrap_or(&true));
            d
        })
        .collect();
    DeepScanResult { dirs, truncated }
}

/// One matching line inside a file (`search_dir`). `line` is 1-based.
#[derive(Clone, Serialize)]
struct SearchMatch {
    line: u32,
    text: String,
}

/// A file with hits (`search_dir`): content matches and/or a file-name match.
#[derive(Clone, Serialize)]
struct SearchFile {
    path: String,
    name: String,
    name_match: bool,
    matches: Vec<SearchMatch>,
}

/// Return value of `search_dir`. `truncated` is set when a cap was hit.
#[derive(Clone, Serialize)]
struct SearchResult {
    files: Vec<SearchFile>,
    truncated: bool,
}

/// Total match-units (content lines + name matches) reported across all files.
const SEARCH_MAX_MATCHES: usize = 500;
/// Markdown files visited (read) before truncating.
const SEARCH_MAX_FILES: usize = 10_000;
/// Directory-visit budget: bound recursion so a tree of millions of
/// (mostly markdown-free) directories can't be walked in full.
const SEARCH_MAX_DIRS: usize = 50_000;
/// Skip any single file larger than this — reading it into a `String` could
/// allocate multiple GB. Skipped silently, exactly like an unreadable file.
const SEARCH_MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// Preview cap per matched line (chars, not bytes — must not split a UTF-8 char).
const SEARCH_PREVIEW_CHARS: usize = 200;
/// Chars of leading context kept before the first match in a line preview.
const SEARCH_PREVIEW_LEAD: usize = 60;

/// Injectable copy of the search budgets so tests can exercise every cap
/// cheaply; `Default` reproduces the production consts.
struct SearchCaps {
    max_matches: usize,
    max_files: usize,
    max_dirs: usize,
    max_file_bytes: u64,
}

impl Default for SearchCaps {
    fn default() -> Self {
        SearchCaps {
            max_matches: SEARCH_MAX_MATCHES,
            max_files: SEARCH_MAX_FILES,
            max_dirs: SEARCH_MAX_DIRS,
            max_file_bytes: SEARCH_MAX_FILE_BYTES,
        }
    }
}

/// Lowercase one char to exactly one char. `char::to_lowercase` can expand to
/// several chars (e.g. 'İ' → "i̇"); taking the first keeps a 1:1 char mapping so
/// offsets stay aligned between the (lowercased) search haystack and the
/// original text used to build the preview.
fn lower1(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// First char-index in `haystack` where `needle` occurs (both already 1:1
/// lowercased via [`lower1`]), or `None`. Contiguous, case-folded substring
/// search over char slices.
fn find_sub(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len())
        .find(|&start| haystack[start..start + needle.len()] == *needle)
}

/// Recursive case-insensitive content search below `root` for the project
/// sidebar ("search in this folder"). Runs OFF the main thread: the walk is
/// blocking I/O, so it is off-loaded via `spawn_blocking` (a synchronous walk
/// here would freeze the macOS UI on a large tree).
///
/// Same skip rules as `scan_dir` (dotfiles, `node_modules`, symlinks never
/// followed, unreadable entries silently skipped); only markdown files are
/// searched, and files larger than `SEARCH_MAX_FILE_BYTES` are skipped. A file
/// is reported when its content matches and/or its name contains the needle.
/// Each directory is walked files-first then subdirectories, each group
/// name-sorted case-insensitively; the visit budgets (`SEARCH_MAX_*`) bound the
/// work and set `truncated` when exceeded.
#[tauri::command]
async fn search_dir(root: String, query: String) -> Result<SearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || search_dir_sync(root, query))
        .await
        .map_err(|e| e.to_string())?
}

/// Synchronous body of `search_dir` (also the direct entry point for tests),
/// running the walk with the production caps.
fn search_dir_sync(root: String, query: String) -> Result<SearchResult, String> {
    search_dir_with_caps(root, query, SearchCaps::default())
}

/// Cap-injectable core: validate inputs, then walk `root` with `caps`.
fn search_dir_with_caps(
    root: String,
    query: String,
    caps: SearchCaps,
) -> Result<SearchResult, String> {
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("empty query".into());
    }
    // 1:1 lowercase the needle too, so it compares against the haystack under
    // the same folding used for offset math (see `lower1`).
    let needle: Vec<char> = trimmed.chars().map(lower1).collect();
    let mut searcher = Searcher {
        needle,
        caps,
        result: SearchResult {
            files: Vec::new(),
            truncated: false,
        },
        total_matches: 0,
        visited_files: 0,
        visited_dirs: 0,
    };
    searcher.walk(&p);
    Ok(searcher.result)
}

/// Mutable state carried through the recursive search walk.
struct Searcher {
    needle: Vec<char>,
    caps: SearchCaps,
    result: SearchResult,
    total_matches: usize,
    visited_files: usize,
    visited_dirs: usize,
}

impl Searcher {
    /// Walk `dir`: this level's markdown files first, then its subdirectories.
    /// Returns `false` once a cap was hit (with `result.truncated` set) so
    /// callers stop walking. Files-first ordering means the budgets keep the
    /// results found before the cutoff and only drop deeper/later ones.
    fn walk(&mut self, dir: &Path) -> bool {
        // Every directory entered counts against the visit budget.
        self.visited_dirs += 1;
        if self.visited_dirs > self.caps.max_dirs {
            self.result.truncated = true;
            return false;
        }
        // Unreadable directory (permissions, race): skip silently, keep walking.
        let Ok(rd) = std::fs::read_dir(dir) else {
            return true;
        };
        let mut dirs: Vec<(String, PathBuf)> = Vec::new();
        let mut files: Vec<(String, PathBuf)> = Vec::new();
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                dirs.push((name, entry.path()));
            } else if is_markdown_name(&name) {
                files.push((name, entry.path()));
            }
        }
        dirs.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
        files.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
        for (name, path) in &files {
            if !self.search_file(name, path) {
                return false;
            }
        }
        for (_, path) in &dirs {
            if !self.walk(path) {
                return false;
            }
        }
        true
    }

    /// Search one markdown file. Returns `false` once a cap was hit. A file's
    /// content matches may be cut mid-file at the match cap.
    fn search_file(&mut self, name: &str, path: &Path) -> bool {
        // Attempt-beyond-cap on the file budget: truncate only when there is
        // actually another file to visit past the cap.
        if self.visited_files >= self.caps.max_files {
            self.result.truncated = true;
            return false;
        }
        self.visited_files += 1;

        // Size guard + unreadable/non-UTF-8: skip silently (same policy).
        let Ok(meta) = path.metadata() else {
            return true;
        };
        if meta.len() > self.caps.max_file_bytes {
            return true;
        }
        let Ok(content) = std::fs::read_to_string(path) else {
            return true;
        };

        let mut matches: Vec<SearchMatch> = Vec::new();
        let mut aborted = false;
        for (i, line) in content.lines().enumerate() {
            let Some(text) = self.preview_if_match(line) else {
                continue;
            };
            // Attempt-beyond-cap: reaching exactly the cap is fine; only a
            // FURTHER match past it truncates.
            if self.total_matches >= self.caps.max_matches {
                self.result.truncated = true;
                aborted = true;
                break;
            }
            matches.push(SearchMatch {
                line: (i + 1) as u32,
                text,
            });
            self.total_matches += 1;
        }

        // A name match counts as one match-unit toward the cap too, with the
        // same attempt-beyond-cap semantics as a content match.
        let mut name_match = false;
        if !aborted && self.name_matches(name) {
            if self.total_matches >= self.caps.max_matches {
                self.result.truncated = true;
                aborted = true;
            } else {
                name_match = true;
                self.total_matches += 1;
            }
        }

        if name_match || !matches.is_empty() {
            self.result.files.push(SearchFile {
                path: path.to_string_lossy().into_owned(),
                name: name.to_string(),
                name_match,
                matches,
            });
        }
        !aborted
    }

    /// If `line` contains the needle (1:1 case-folded), return a preview
    /// windowed around the FIRST match so the match is always visible even when
    /// it lies far into a long line. `…` marks a window that doesn't start at
    /// the line's beginning and/or continues past its end.
    fn preview_if_match(&self, line: &str) -> Option<String> {
        let trimmed: Vec<char> = line.trim().chars().collect();
        let hay: Vec<char> = trimmed.iter().map(|&c| lower1(c)).collect();
        let pos = find_sub(&hay, &self.needle)?;
        let start = pos.saturating_sub(SEARCH_PREVIEW_LEAD);
        let end = (start + SEARCH_PREVIEW_CHARS).min(trimmed.len());
        let mut text = String::new();
        if start > 0 {
            text.push('…');
        }
        text.extend(trimmed[start..end].iter().copied());
        if end < trimmed.len() {
            text.push('…');
        }
        Some(text)
    }

    /// Whether the file name contains the needle (1:1 case-folded), for
    /// consistency with the content-match folding.
    fn name_matches(&self, name: &str) -> bool {
        let hay: Vec<char> = name.chars().map(lower1).collect();
        find_sub(&hay, &self.needle).is_some()
    }
}

/// Start watching `root` recursively for the project tree. Any debounced
/// change below it emits `tree-changed` (no payload — the frontend rescans
/// the whole tree). Only one project is open at a time, so any previous dir
/// watch is replaced (dropped). Async + blocking thread: watch 시작이 느린
/// 볼륨에서도 메인스레드(UI)를 잡지 않게 한다 (NoCache라 워크는 없지만
/// FSEvents 등록/해제 자체도 메인스레드 밖으로).
#[tauri::command]
async fn watch_dir(
    root: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let handle = app.clone();
    let watch_root = root.clone();
    let debouncer = tauri::async_runtime::spawn_blocking(move || -> Result<FileWatcher, String> {
        let mut d = md_debouncer(500, move |res: DebounceEventResult| {
            if res.is_ok() {
                let _ = handle.emit("tree-changed", ());
            }
        })?;
        d.watch(Path::new(&watch_root), RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        Ok(d)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut map = state.dir_watchers.lock().unwrap();
    map.clear();
    map.insert(root, debouncer);
    Ok(())
}

/// Stop the project tree watch (project closed). Dropping the debouncer
/// stops the underlying recursive watch.
#[tauri::command]
fn unwatch_dir(root: String, state: tauri::State<AppState>) {
    state.dir_watchers.lock().unwrap().remove(&root);
}

/// Event payload for `pdf-exported`.
#[derive(Clone, Serialize)]
struct PdfPayload {
    ok: bool,
    path: String,
    error: Option<String>,
}

/// Save the current webview content as a paginated PDF at `dest`, without any
/// print dialog. Completion is reported via the `pdf-exported` event because
/// the Windows implementation is asynchronous; macOS emits it synchronously.
#[tauri::command]
fn export_pdf(
    dest: String,
    title: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    // macOS draws the header/footer in the DOM before capture; only the
    // Windows print pipeline consumes `title` natively.
    #[cfg(target_os = "macos")]
    let _ = &title;
    // macOS: WKWebView's print operation (both run variants) yields blank or
    // corrupt PDFs, so use `createPDF` — it reliably captures the full
    // document as ONE long vector page — then slice that page into A4-ratio
    // pages by MediaBox windowing (content stream shared, vectors preserved).
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        let dest2 = dest.clone();
        window
            .with_webview(move |wv| {
                use block2::RcBlock;
                use objc2::MainThreadMarker;
                use objc2_foundation::{NSData, NSError};
                use objc2_web_kit::{WKPDFConfiguration, WKWebView};

                unsafe {
                    let webview: &WKWebView = &*(wv.inner() as *const WKWebView);
                    let app2 = app.clone();
                    let dest3 = dest2.clone();
                    let block = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                        let result: Result<(), String> = (|| {
                            if data.is_null() {
                                return Err(if error.is_null() {
                                    "PDF 데이터 없음".to_string()
                                } else {
                                    (*error).localizedDescription().to_string()
                                });
                            }
                            paginate_pdf(&(*data).to_vec(), &dest3)
                        })();
                        let _ = app2.emit(
                            "pdf-exported",
                            PdfPayload {
                                ok: result.is_ok(),
                                path: dest3.clone(),
                                error: result.err(),
                            },
                        );
                    });
                    let mtm = MainThreadMarker::new()
                        .expect("with_webview closure must run on the main thread");
                    let config = WKPDFConfiguration::new(mtm);
                    webview.createPDFWithConfiguration_completionHandler(Some(&config), &block);
                }
            })
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Windows: WebView2's PrintToPdf runs a real print pipeline (applies
    // @media print CSS and paginates natively) — no post-processing needed.
    #[cfg(target_os = "windows")]
    {
        let app = window.app_handle().clone();
        let dest2 = dest.clone();
        window
            .with_webview(move |wv| {
                use webview2_com::Microsoft::Web::WebView2::Win32::{
                    ICoreWebView2Environment6, ICoreWebView2_2, ICoreWebView2_7,
                };
                use webview2_com::PrintToPdfCompletedHandler;
                use windows::core::{Interface, HSTRING};

                let emit = |app: &tauri::AppHandle, ok: bool, path: String, err: Option<String>| {
                    let _ = app.emit(
                        "pdf-exported",
                        PdfPayload {
                            ok,
                            path,
                            error: err,
                        },
                    );
                };

                unsafe {
                    let controller = wv.controller();
                    let core = match controller.CoreWebView2() {
                        Ok(c) => c,
                        Err(e) => return emit(&app, false, dest2.clone(), Some(e.to_string())),
                    };
                    let core7: ICoreWebView2_7 = match core.cast() {
                        Ok(c) => c,
                        Err(e) => return emit(&app, false, dest2.clone(), Some(e.to_string())),
                    };
                    // Print settings: native header (document title) + footer
                    // (page numbers); blank out the footer URI (tauri://…).
                    let settings = core
                        .cast::<ICoreWebView2_2>()
                        .and_then(|c2| c2.Environment())
                        .and_then(|env| env.cast::<ICoreWebView2Environment6>())
                        .and_then(|env6| env6.CreatePrintSettings());
                    let settings = match settings {
                        Ok(s) => {
                            let _ = s.SetShouldPrintHeaderAndFooter(true);
                            let _ = s.SetHeaderTitle(&HSTRING::from(
                                title.clone().unwrap_or_default(),
                            ));
                            let _ = s.SetFooterUri(&HSTRING::from(""));
                            Some(s)
                        }
                        Err(_) => None, // settings are best-effort; export anyway
                    };
                    let app2 = app.clone();
                    let dest3 = dest2.clone();
                    let handler = PrintToPdfCompletedHandler::create(Box::new(
                        move |result: windows::core::Result<()>, is_successful| {
                            let ok = result.is_ok() && is_successful;
                            let err = if ok { None } else { Some(format!("{result:?}")) };
                            let _ = app2.emit(
                                "pdf-exported",
                                PdfPayload {
                                    ok,
                                    path: dest3.clone(),
                                    error: err,
                                },
                            );
                            Ok(())
                        },
                    ));
                    if let Err(e) =
                        core7.PrintToPdf(&HSTRING::from(dest2.as_str()), settings.as_ref(), &handler)
                    {
                        emit(&app, false, dest2.clone(), Some(e.to_string()));
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (dest, window);
        Err("PDF export not supported on this platform".into())
    }
}


/// Slice a single-long-page PDF (WKWebView `createPDF` output) into A4-ratio
/// pages. Every output page references the SAME content stream and differs
/// only in its MediaBox window, so vectors/text stay intact. A page boundary
/// can land mid-line — inherent to geometric slicing of a screen render.
#[cfg(target_os = "macos")]
fn paginate_pdf(input: &[u8], dest: &str) -> Result<(), String> {
    use lopdf::{Document, Object};

    let mut doc = Document::load_mem(input).map_err(|e| e.to_string())?;
    let pages = doc.get_pages();
    let (_, &page_id) = pages.iter().next().ok_or("empty pdf")?;
    let page_dict = doc
        .get_object(page_id)
        .and_then(|o| o.as_dict())
        .map_err(|e| e.to_string())?
        .clone();

    let media: Vec<f64> = page_dict
        .get(b"MediaBox")
        .and_then(|o| o.as_array())
        .map_err(|e| e.to_string())?
        .iter()
        .map(|o| o.as_float().unwrap_or(0.0) as f64)
        .collect();
    let [x0, y0, x1, y1] = media[..] else {
        return Err("bad MediaBox".into());
    };
    let (w, h) = (x1 - x0, y1 - y0);
    let page_h = w * 842.0 / 595.0; // A4 aspect at the captured width
    let n = (h / page_h).ceil().max(1.0) as usize;

    if n > 1 {
        let parent = page_dict
            .get(b"Parent")
            .and_then(|o| o.as_reference())
            .map_err(|e| e.to_string())?;
        let mut kids: Vec<Object> = Vec::with_capacity(n);
        for i in 0..n {
            let top = y1 - page_h * i as f64;
            let bottom = (top - page_h).max(y0);
            let mut d = page_dict.clone();
            d.set(
                "MediaBox",
                vec![x0.into(), bottom.into(), x1.into(), top.into()],
            );
            kids.push(Object::Reference(doc.add_object(Object::Dictionary(d))));
        }
        let pages_node = doc
            .get_object_mut(parent)
            .and_then(|o| o.as_dict_mut())
            .map_err(|e| e.to_string())?;
        pages_node.set("Kids", kids);
        pages_node.set("Count", n as i64);
    }

    doc.save(dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Modification time of `path` in epoch milliseconds. Used by the frontend's
/// polling fallback for environments where the notify watcher delivers no
/// events (network drives, some Windows setups).
#[tauri::command]
fn file_mtime(path: String) -> Result<u64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let mtime = meta.modified().map_err(|e| e.to_string())?;
    mtime
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Win/Linux: the file path arrives as argv[1]. On macOS this is empty for
    // double-click launches (the path comes via RunEvent::Opened instead), and
    // the is_file() filter discards macOS launch junk like `-psn_…`.
    if let Some(p) = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
        initial_buf().lock().unwrap().push(p);
    }

    let mut builder = tauri::Builder::default();

    // Single-instance (Windows/Linux): a second launch forwards its argv here
    // instead of starting a new process, so multiple opened files land as tabs
    // in the one running window. MUST be the first plugin registered. Not on
    // macOS — there a double-click arrives via RunEvent::Opened, not argv, and
    // the OS already enforces a single instance.
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for arg in argv.iter().skip(1) {
                let p = PathBuf::from(arg);
                if p.is_file() {
                    if let Ok(mut buf) = initial_buf().lock() {
                        buf.push(p.clone());
                    }
                    let _ = app.emit(
                        "file-opened",
                        FilePayload {
                            path: p.to_string_lossy().into_owned(),
                        },
                    );
                }
            }
            // Bring the existing window forward.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }

    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            app.manage(AppState {
                watchers: Mutex::new(HashMap::new()),
                dir_watchers: Mutex::new(HashMap::new()),
            });
            // Headless PDF smoke hook: MDVIEW_PDF_EXPORT_TEST=/path/out.pdf
            // asks the frontend to run its full export flow (theme override,
            // chrome hiding, invoke) ~5s after launch. Exists because macOS
            // TCC blocks synthetic keystrokes in scripted verification; also
            // usable as a CI smoke test.
            if let Ok(dest) = std::env::var("MDVIEW_PDF_EXPORT_TEST") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(5));
                    let _ = handle.emit("pdf-export-test", FilePayload { path: dest });
                });
            }
            // Headless project-mode smoke hook: MDVIEW_PROJECT_TEST=/path/to/dir
            // asks the frontend to open the given folder as a project ~3s after
            // launch, bypassing the folder picker dialog. Exists because macOS
            // TCC blocks synthetic clicks in scripted verification; also usable
            // as a CI smoke test.
            if let Ok(dir) = std::env::var("MDVIEW_PROJECT_TEST") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    let _ = handle.emit("project-open-test", FilePayload { path: dir });
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_file,
            read_file,
            watch_file,
            unwatch_file,
            file_mtime,
            export_pdf,
            scan_dir,
            scan_dir_deep,
            search_dir,
            watch_dir,
            unwatch_dir
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|handle, event| {
        // macOS file-open: the path is NOT in argv; it arrives here as a URL.
        // Buffer into the process-global INITIAL (works even before managed
        // state exists — fixes the cold-launch first-open drop) AND emit
        // "file-opened" for the already-running case. The frontend drains the
        // buffer via get_initial_file on startup and listens for "file-opened"
        // thereafter (it dedupes by path, so overlap is harmless).
        //
        // This closure is called from tao's `application:openURLs:` ObjC
        // delegate (extern "C", CANNOT unwind) — a panic here becomes
        // abort -> crash -> macOS state-restoration crash-loop. So it must be
        // panic-free: the global buffer needs no managed state, and the lock is
        // handled gracefully.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &event {
            for path in urls.iter().filter_map(|u| u.to_file_path().ok()) {
                if let Ok(mut buf) = initial_buf().lock() {
                    buf.push(path.clone());
                }
                let _ = handle.emit(
                    "file-opened",
                    FilePayload {
                        path: path.to_string_lossy().into_owned(),
                    },
                );
            }
        }
        let _ = (handle, event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::thread;
    use std::time::Duration;

    fn touch(p: &Path) {
        fs::write(p, "x").unwrap();
    }

    fn scan(dir: &Path) -> ScanDirResult {
        scan_dir_inner(dir.to_string_lossy().into_owned(), SCAN_DIR_MAX_ENTRIES).unwrap()
    }

    #[test]
    fn scan_dir_rejects_non_directory() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("a.md"));
        let res = scan_dir_inner(
            t.path().join("a.md").to_string_lossy().into_owned(),
            SCAN_DIR_MAX_ENTRIES,
        );
        assert!(res.is_err());
    }

    #[test]
    fn scan_dir_empty_dir_has_no_children() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("note.txt")); // md 없고 하위 폴더도 없음
        let res = scan(t.path());
        assert!(res.children.is_empty());
        assert!(!res.truncated);
    }

    #[test]
    fn scan_dir_filters_files_keeps_subdirs_and_sorts() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("note.md"));
        touch(&t.path().join("skip.txt"));
        fs::create_dir(t.path().join("sub")).unwrap(); // 마크다운 없는 폴더도 표시
        let res = scan(t.path());
        let names: Vec<_> = res.children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["sub", "note.md"]); // 폴더 우선, .txt 제외
        assert!(res.children[0].is_dir);
        assert!(!res.children[1].is_dir);
        assert!(!res.truncated);
    }

    #[test]
    fn scan_dir_skips_dotfiles_and_node_modules() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join(".git")).unwrap();
        fs::create_dir(t.path().join("node_modules")).unwrap();
        touch(&t.path().join(".hidden.md"));
        touch(&t.path().join("real.md"));
        let res = scan(t.path());
        let names: Vec<_> = res.children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["real.md"]);
    }

    #[test]
    fn scan_dir_complete_listing_with_trailing_skippable_not_truncated() {
        // Exactly `max_entries` collectible entries plus a skippable dotfile
        // and a non-markdown file must NOT report truncated (finding 6: the cap
        // is checked at push time, so a trailing non-collectible can't flip it).
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("a.md"));
        touch(&t.path().join("b.md"));
        touch(&t.path().join(".hidden"));
        touch(&t.path().join("note.txt"));
        let res = scan_dir_inner(t.path().to_string_lossy().into_owned(), 2).unwrap();
        assert_eq!(res.children.len(), 2);
        assert!(!res.truncated);
    }

    #[test]
    fn scan_dir_truncates_when_collectible_exceeds_cap() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("a.md"));
        touch(&t.path().join("b.md"));
        touch(&t.path().join("c.md"));
        let res = scan_dir_inner(t.path().to_string_lossy().into_owned(), 2).unwrap();
        assert_eq!(res.children.len(), 2);
        assert!(res.truncated);
    }

    fn scan_deep(dir: &Path) -> DeepScanResult {
        scan_dir_deep_inner(
            dir.to_string_lossy().into_owned(),
            DEEP_SCAN_MAX_DIRS,
            SCAN_DIR_MAX_ENTRIES,
            DEEP_SCAN_MAX_TOTAL_ENTRIES,
        )
        .unwrap()
    }

    fn scan_deep_capped(dir: &Path, max_dirs: usize, max_total: usize) -> DeepScanResult {
        scan_dir_deep_inner(
            dir.to_string_lossy().into_owned(),
            max_dirs,
            SCAN_DIR_MAX_ENTRIES,
            max_total,
        )
        .unwrap()
    }

    #[test]
    fn scan_dir_deep_rejects_non_directory() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("a.md"));
        let res = scan_dir_deep_inner(
            t.path().join("a.md").to_string_lossy().into_owned(),
            DEEP_SCAN_MAX_DIRS,
            SCAN_DIR_MAX_ENTRIES,
            DEEP_SCAN_MAX_TOTAL_ENTRIES,
        );
        assert!(res.is_err());
    }

    #[test]
    fn scan_dir_deep_lists_subtree_bfs_and_prunes_mdless_dirs() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("root.md"));
        fs::create_dir(t.path().join("b")).unwrap(); // md 없음 → prune
        fs::create_dir(t.path().join("a")).unwrap();
        fs::create_dir(t.path().join("a/inner")).unwrap();
        fs::create_dir(t.path().join("a/hollow")).unwrap(); // md 없음 → prune
        touch(&t.path().join("a/inner/deep.md")); // a는 깊은 md 덕에 유지
        let res = scan_deep(t.path());
        assert!(!res.truncated);
        // BFS 순서(부모 먼저) + prune: b·a/hollow 는 dirs에서도 부모 children에서도 빠진다.
        let paths: Vec<_> = res
            .dirs
            .iter()
            .map(|d| {
                Path::new(&d.path)
                    .strip_prefix(t.path())
                    .map(|r| r.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
            .collect();
        assert_eq!(paths, vec!["", "a", "a/inner"]);
        let root_names: Vec<_> = res.dirs[0].children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(root_names, vec!["a", "root.md"]);
        let a_names: Vec<_> = res.dirs[1].children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(a_names, vec!["inner"]);
        let inner_names: Vec<_> = res.dirs[2].children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(inner_names, vec!["deep.md"]);
    }

    #[test]
    fn scan_dir_deep_mdless_root_kept_with_empty_children() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("note.txt"));
        fs::create_dir(t.path().join("hollow")).unwrap();
        let res = scan_deep(t.path());
        // 루트는 사용자가 지목한 폴더 — prune 대상이 아니고, 빈 결과로 답한다.
        assert_eq!(res.dirs.len(), 1);
        assert!(res.dirs[0].children.is_empty());
        assert!(!res.truncated);
    }

    #[test]
    fn scan_dir_deep_skips_dot_and_node_modules_subtrees() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join(".git")).unwrap();
        touch(&t.path().join(".git/x.md"));
        fs::create_dir(t.path().join("node_modules")).unwrap();
        touch(&t.path().join("node_modules/y.md"));
        fs::create_dir(t.path().join("ok")).unwrap();
        touch(&t.path().join("ok/z.md"));
        let res = scan_deep(t.path());
        let names: Vec<_> = res.dirs[0].children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["ok"]); // 숨김/node_modules 하위는 순회도 표시도 안 함
        assert_eq!(res.dirs.len(), 2);
    }

    #[test]
    fn scan_dir_deep_truncates_when_dir_budget_skips_work_and_keeps_unscanned() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join("a")).unwrap();
        fs::create_dir(t.path().join("b")).unwrap();
        let res = scan_deep_capped(t.path(), 2, DEEP_SCAN_MAX_TOTAL_ENTRIES);
        assert!(res.truncated); // b가 예산에 걸림
        // a는 스캔됐고 md 없음 → prune. b는 미스캔(모름) → 보수적으로 유지.
        assert_eq!(res.dirs.len(), 1);
        let names: Vec<_> = res.dirs[0].children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["b"]);
    }

    #[test]
    fn scan_dir_deep_exactly_at_dir_budget_not_truncated() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join("a")).unwrap();
        touch(&t.path().join("a/x.md"));
        let res = scan_deep_capped(t.path(), 2, DEEP_SCAN_MAX_TOTAL_ENTRIES);
        assert_eq!(res.dirs.len(), 2);
        assert!(!res.truncated); // 정확히 예산만큼 — 건너뛴 작업 없음
    }

    #[test]
    fn scan_dir_deep_total_entry_budget_truncates_with_work_remaining() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("a.md"));
        touch(&t.path().join("b.md"));
        fs::create_dir(t.path().join("sub")).unwrap();
        touch(&t.path().join("sub/c.md"));
        // 루트 스캔에서 총 3 엔트리 ≥ 2 — sub가 남은 채 중단 → truncated.
        let res = scan_deep_capped(t.path(), DEEP_SCAN_MAX_DIRS, 2);
        assert!(res.truncated);
        assert_eq!(res.dirs.len(), 1);
    }

    #[test]
    fn scan_dir_deep_exactly_at_total_budget_not_truncated() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("a.md"));
        touch(&t.path().join("b.md"));
        let res = scan_deep_capped(t.path(), DEEP_SCAN_MAX_DIRS, 2);
        assert!(!res.truncated); // 남은 작업 없음 — 캡과 정확히 일치는 잘림이 아니다
        assert_eq!(res.dirs[0].children.len(), 2);
    }

    #[test]
    fn scan_dir_deep_level_truncation_propagates() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("a.md"));
        touch(&t.path().join("b.md"));
        touch(&t.path().join("c.md"));
        let res = scan_dir_deep_inner(
            t.path().to_string_lossy().into_owned(),
            DEEP_SCAN_MAX_DIRS,
            2,
            DEEP_SCAN_MAX_TOTAL_ENTRIES,
        )
        .unwrap();
        assert!(res.truncated);
        assert_eq!(res.dirs[0].children.len(), 2);
    }

    fn search(dir: &Path, q: &str) -> SearchResult {
        search_dir_sync(dir.to_string_lossy().into_owned(), q.into()).unwrap()
    }

    fn search_capped(dir: &Path, q: &str, caps: SearchCaps) -> SearchResult {
        search_dir_with_caps(dir.to_string_lossy().into_owned(), q.into(), caps).unwrap()
    }

    #[test]
    fn search_dir_rejects_non_directory() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("a.md"));
        let res = search_dir_sync(
            t.path().join("a.md").to_string_lossy().into_owned(),
            "x".into(),
        );
        assert!(res.is_err());
    }

    #[test]
    fn search_dir_rejects_empty_or_whitespace_query() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().to_string_lossy().into_owned();
        assert!(search_dir_sync(root.clone(), "".into()).is_err());
        assert!(search_dir_sync(root, "   ".into()).is_err());
    }

    #[test]
    fn search_dir_finds_case_insensitive_in_nested_dirs() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("sub").join("deep")).unwrap();
        fs::write(
            t.path().join("sub").join("deep").join("a.md"),
            "first line\nHello World\n",
        )
        .unwrap();
        let res = search(t.path(), "hello");
        assert_eq!(res.files.len(), 1);
        assert_eq!(res.files[0].name, "a.md");
        assert!(!res.files[0].name_match);
        assert_eq!(res.files[0].matches.len(), 1);
        assert_eq!(res.files[0].matches[0].line, 2); // 1-based
        assert_eq!(res.files[0].matches[0].text, "Hello World");
        assert!(!res.truncated);
    }

    #[test]
    fn search_dir_skips_node_modules_dotfiles_and_non_markdown() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join("node_modules")).unwrap();
        fs::write(t.path().join("node_modules").join("x.md"), "needle").unwrap();
        fs::create_dir(t.path().join(".git")).unwrap();
        fs::write(t.path().join(".git").join("y.md"), "needle").unwrap();
        fs::write(t.path().join(".hidden.md"), "needle").unwrap();
        fs::write(t.path().join("plain.txt"), "needle").unwrap();
        fs::write(t.path().join("real.md"), "a needle here").unwrap();
        let res = search(t.path(), "needle");
        let names: Vec<_> = res.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["real.md"]);
    }

    #[test]
    fn search_dir_name_match_without_content_hits() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("guide-hello.md"), "nothing relevant\n").unwrap();
        let res = search(t.path(), "hello");
        assert_eq!(res.files.len(), 1);
        assert!(res.files[0].name_match);
        assert!(res.files[0].matches.is_empty());
    }

    #[test]
    fn search_dir_truncates_at_match_cap() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("big.md"), "needle line\n".repeat(600)).unwrap();
        let res = search(t.path(), "needle");
        let total: usize = res.files.iter().map(|f| f.matches.len()).sum();
        assert_eq!(total, SEARCH_MAX_MATCHES);
        assert!(res.truncated);
    }

    #[test]
    fn search_dir_preview_capped_utf8_safe() {
        let t = tempfile::tempdir().unwrap();
        let line = format!("{}needle", "가".repeat(300)); // multibyte, > 200 chars
        fs::write(t.path().join("wide.md"), line).unwrap();
        let res = search(t.path(), "needle");
        assert_eq!(res.files.len(), 1);
        assert_eq!(res.files[0].matches.len(), 1);
        assert!(res.files[0].matches[0].text.chars().count() <= SEARCH_PREVIEW_CHARS);
    }

    #[test]
    fn search_dir_preview_windows_around_late_match() {
        // A 400+ char line with the needle well past char 200: the preview must
        // still CONTAIN the needle (windowed around it) and open with '…'
        // because the window no longer starts at the line's beginning.
        let t = tempfile::tempdir().unwrap();
        let line = format!("{}needle{}", "a".repeat(250), "b".repeat(150));
        fs::write(t.path().join("w.md"), line).unwrap();
        let res = search(t.path(), "needle");
        assert_eq!(res.files.len(), 1);
        let text = &res.files[0].matches[0].text;
        assert!(text.contains("needle"), "preview must show the match: {text}");
        assert!(text.starts_with('…'), "windowed preview must start with …");
        assert!(text.chars().count() <= SEARCH_PREVIEW_CHARS + 2); // window + up to 2 ellipses
    }

    #[test]
    fn search_dir_exactly_at_match_cap_not_truncated() {
        // Reaching exactly the cap with nothing further must leave truncated=false.
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("a.md"), "needle\nneedle\nneedle\n").unwrap();
        let caps = SearchCaps {
            max_matches: 3,
            ..Default::default()
        };
        let res = search_capped(t.path(), "needle", caps);
        let total: usize = res.files.iter().map(|f| f.matches.len()).sum();
        assert_eq!(total, 3);
        assert!(!res.truncated);
    }

    #[test]
    fn search_dir_match_beyond_cap_truncated() {
        // A further match past the cap sets truncated (attempt-beyond-cap).
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("a.md"), "needle\nneedle\nneedle\nneedle\n").unwrap();
        let caps = SearchCaps {
            max_matches: 3,
            ..Default::default()
        };
        let res = search_capped(t.path(), "needle", caps);
        let total: usize = res.files.iter().map(|f| f.matches.len()).sum();
        assert_eq!(total, 3);
        assert!(res.truncated);
    }

    #[test]
    fn search_dir_dir_budget_stops_descent() {
        // Linear chain root/a/b/c, each with a matching md file. With max_dirs=2
        // only root and a are visited: their files are present, deeper files are
        // absent, and truncated is set.
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        fs::write(root.join("root.md"), "needle").unwrap();
        let a = root.join("a");
        fs::create_dir(&a).unwrap();
        fs::write(a.join("a.md"), "needle").unwrap();
        let b = a.join("b");
        fs::create_dir(&b).unwrap();
        fs::write(b.join("b.md"), "needle").unwrap();
        let c = b.join("c");
        fs::create_dir(&c).unwrap();
        fs::write(c.join("c.md"), "needle").unwrap();
        let caps = SearchCaps {
            max_dirs: 2,
            ..Default::default()
        };
        let res = search_capped(root, "needle", caps);
        let names: Vec<_> = res.files.iter().map(|f| f.name.as_str()).collect();
        assert!(res.truncated);
        assert!(names.contains(&"root.md")); // visited dir's file present
        assert!(names.contains(&"a.md")); // visited dir's file present
        assert!(!names.contains(&"b.md")); // below the budget: unvisited
        assert!(!names.contains(&"c.md"));
    }

    #[test]
    fn search_dir_skips_oversize_file() {
        // A file above the injected byte cap is skipped like an unreadable one:
        // its content match is absent, and truncated is unaffected.
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("big.md"), "needle needle needle").unwrap(); // 20 bytes
        fs::write(t.path().join("small.md"), "needle").unwrap(); // 6 bytes
        let caps = SearchCaps {
            max_file_bytes: 10,
            ..Default::default()
        };
        let res = search_capped(t.path(), "needle", caps);
        let names: Vec<_> = res.files.iter().map(|f| f.name.as_str()).collect();
        assert!(!names.contains(&"big.md"));
        assert!(names.contains(&"small.md"));
        assert!(!res.truncated);
    }

    #[test]
    fn search_dir_name_match_respects_cap() {
        // Three name-only matches (no content hits) with max_matches=2: only two
        // are reported and truncated is set (finding 5: name matches count too).
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("one-hello.md"), "x").unwrap();
        fs::write(t.path().join("two-hello.md"), "x").unwrap();
        fs::write(t.path().join("three-hello.md"), "x").unwrap();
        let caps = SearchCaps {
            max_matches: 2,
            ..Default::default()
        };
        let res = search_capped(t.path(), "hello", caps);
        assert_eq!(res.files.len(), 2);
        assert!(res.truncated);
    }

    #[test]
    fn file_mtime_returns_millis_and_changes_on_write() {
        let dir = std::env::temp_dir();
        let p = dir.join("mdview-mtime-test.md");
        std::fs::write(&p, "a").unwrap();
        let t1 = file_mtime(p.to_string_lossy().into_owned()).unwrap();
        assert!(t1 > 1_600_000_000_000); // 2020년 이후 epoch millis
        thread::sleep(Duration::from_millis(1100));
        std::fs::write(&p, "b").unwrap();
        let t2 = file_mtime(p.to_string_lossy().into_owned()).unwrap();
        assert!(t2 > t1);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn file_mtime_errors_on_missing_file() {
        assert!(file_mtime("/nonexistent/x.md".into()).is_err());
    }
}

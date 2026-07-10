use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};

type FileWatcher = Debouncer<RecommendedWatcher, RecommendedCache>;

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

    let mut debouncer = new_debouncer(
        Duration::from_millis(200),
        None,
        move |res: DebounceEventResult| {
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
        },
    )
    .map_err(|e| e.to_string())?;

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

/// A node in the project file tree (`scan_tree`). Files are markdown-only;
/// directories appear only when their subtree contains at least one markdown
/// file.
#[derive(Clone, Serialize)]
struct TreeNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<TreeNode>,
}

/// Return value of `scan_tree`. `truncated` is set when the scan hit
/// SCAN_MAX_ENTRIES and stopped early.
#[derive(Clone, Serialize)]
struct ScanResult {
    tree: TreeNode,
    truncated: bool,
}

/// Entry cap for `scan_tree`: past this many collected nodes the scan stops
/// so a runaway root (e.g. `/`) cannot hang the UI.
const SCAN_MAX_ENTRIES: usize = 10_000;

fn is_markdown_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

fn cmp_tree_name(a: &TreeNode, b: &TreeNode) -> std::cmp::Ordering {
    a.name.to_lowercase().cmp(&b.name.to_lowercase())
}

/// Recursively collect the markdown-bearing children of `dir`, honouring the
/// shared entry `budget`. Directories with no markdown anywhere below them
/// are pruned. Dotfiles, `node_modules` and symlinks are skipped; symlinks
/// are never followed (avoids cycles and out-of-root jumps). Unreadable
/// entries/dirs are silently skipped. Directories sort before files,
/// each name-sorted case-insensitively.
fn scan_children(dir: &Path, budget: &mut usize, truncated: &mut bool) -> Vec<TreeNode> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();
    for entry in rd.flatten() {
        if *budget == 0 {
            *truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            *budget -= 1;
            let children = scan_children(&path, budget, truncated);
            if children.is_empty() {
                *budget += 1; // pruned: refund the slot
                continue;
            }
            dirs.push(TreeNode {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: true,
                children,
            });
        } else if is_markdown_name(&name) {
            *budget -= 1;
            files.push(TreeNode {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: false,
                children: Vec::new(),
            });
        }
    }
    dirs.sort_by(cmp_tree_name);
    files.sort_by(cmp_tree_name);
    dirs.extend(files);
    dirs
}

/// Scan `root` for markdown files, returning the pruned tree. Errs when
/// `root` is not a directory — the frontend drop handler uses this to tell
/// folders from stray non-markdown files. The root node is always returned,
/// children may be empty (frontend shows "md 파일 없음").
#[tauri::command]
fn scan_tree(root: String) -> Result<ScanResult, String> {
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let mut budget = SCAN_MAX_ENTRIES;
    let mut truncated = false;
    let children = scan_children(&p, &mut budget, &mut truncated);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.clone());
    Ok(ScanResult {
        tree: TreeNode {
            name,
            path: root,
            is_dir: true,
            children,
        },
        truncated,
    })
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_file,
            read_file,
            watch_file,
            unwatch_file,
            file_mtime,
            export_pdf,
            scan_tree
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

    fn touch(p: &Path) {
        fs::write(p, "x").unwrap();
    }

    fn scan(dir: &Path, budget: usize) -> (Vec<TreeNode>, bool) {
        let mut budget = budget;
        let mut truncated = false;
        let kids = scan_children(dir, &mut budget, &mut truncated);
        (kids, truncated)
    }

    #[test]
    fn keeps_only_markdown_files() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("a.md"));
        touch(&t.path().join("B.MARKDOWN"));
        touch(&t.path().join("c.txt"));
        let (kids, truncated) = scan(t.path(), 100);
        let names: Vec<_> = kids.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["a.md", "B.MARKDOWN"]); // 대소문자 무시 정렬
        assert!(!truncated);
    }

    #[test]
    fn prunes_dirs_without_markdown() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join("empty")).unwrap();
        fs::create_dir(t.path().join("docs")).unwrap();
        touch(&t.path().join("docs").join("x.md"));
        let (kids, _) = scan(t.path(), 100);
        assert_eq!(kids.len(), 1);
        assert_eq!(kids[0].name, "docs");
        assert!(kids[0].is_dir);
        assert_eq!(kids[0].children[0].name, "x.md");
    }

    #[test]
    fn skips_dotfiles_and_node_modules() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join(".git")).unwrap();
        touch(&t.path().join(".git").join("readme.md"));
        fs::create_dir_all(t.path().join("node_modules").join("pkg")).unwrap();
        touch(&t.path().join("node_modules").join("pkg").join("README.md"));
        touch(&t.path().join(".hidden.md"));
        touch(&t.path().join("real.md"));
        let (kids, _) = scan(t.path(), 100);
        let names: Vec<_> = kids.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["real.md"]);
    }

    #[test]
    fn dirs_sort_before_files() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("aaa.md"));
        fs::create_dir(t.path().join("zzz")).unwrap();
        touch(&t.path().join("zzz").join("n.md"));
        let (kids, _) = scan(t.path(), 100);
        let names: Vec<_> = kids.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["zzz", "aaa.md"]);
    }

    #[test]
    fn budget_truncates_scan() {
        let t = tempfile::tempdir().unwrap();
        for i in 0..5 {
            touch(&t.path().join(format!("f{i}.md")));
        }
        let (kids, truncated) = scan(t.path(), 3);
        assert_eq!(kids.len(), 3);
        assert!(truncated);
    }

    #[test]
    fn scan_tree_rejects_non_directory() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("a.md"));
        let res = scan_tree(t.path().join("a.md").to_string_lossy().into_owned());
        assert!(res.is_err());
    }

    #[test]
    fn scan_tree_returns_root_node_even_when_empty() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("note.txt")); // md 없음
        let res = scan_tree(t.path().to_string_lossy().into_owned()).unwrap();
        assert!(res.tree.is_dir);
        assert!(res.tree.children.is_empty());
        assert!(!res.truncated);
    }
}

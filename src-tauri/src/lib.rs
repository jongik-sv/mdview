use std::collections::HashMap;
use std::path::PathBuf;
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
fn export_pdf(dest: String, window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        let dest2 = dest.clone();
        window
            .with_webview(move |wv| {
                use objc2::rc::Retained;
                use objc2::runtime::ProtocolObject;
                use objc2_app_kit::{NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob};
                use objc2_foundation::{NSCopying, NSString, NSURL};
                use objc2_web_kit::WKWebView;

                let result: Result<(), String> = (|| unsafe {
                    let webview: &WKWebView = &*(wv.inner() as *const WKWebView);
                    let info: Retained<NSPrintInfo> = NSPrintInfo::sharedPrintInfo().copy();
                    info.setJobDisposition(NSPrintSaveJob);
                    let url = NSURL::fileURLWithPath(&NSString::from_str(&dest2));
                    let dict = info.dictionary();
                    dict.setObject_forKey(&*url, ProtocolObject::from_ref(&*NSPrintJobSavingURL));
                    let op = webview.printOperationWithPrintInfo(&info);
                    op.setShowsPrintPanel(false);
                    op.setShowsProgressPanel(false);
                    // WKWebView print operations need an explicit view frame,
                    // otherwise the spooled PDF comes out blank.
                    if let Some(view) = op.view() {
                        view.setFrame(webview.frame());
                    }
                    if op.runOperation() {
                        Ok(())
                    } else {
                        Err("print operation failed".into())
                    }
                })();

                let _ = app.emit(
                    "pdf-exported",
                    PdfPayload {
                        ok: result.is_ok(),
                        path: dest2.clone(),
                        error: result.err(),
                    },
                );
            })
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (dest, window);
        Err("PDF export not supported on this platform".into())
    }
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_file,
            read_file,
            watch_file,
            unwatch_file,
            file_mtime,
            export_pdf
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

    #[test]
    fn file_mtime_returns_millis_and_changes_on_write() {
        let dir = std::env::temp_dir();
        let p = dir.join("mdview-mtime-test.md");
        std::fs::write(&p, "a").unwrap();
        let t1 = file_mtime(p.to_string_lossy().into_owned()).unwrap();
        assert!(t1 > 1_600_000_000_000); // 2020년 이후 epoch millis
        std::thread::sleep(std::time::Duration::from_millis(1100));
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

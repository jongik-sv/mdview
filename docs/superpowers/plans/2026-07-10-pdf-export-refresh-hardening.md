# PDF 출력 + 리프레시 보강 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 활성 마크다운 문서를 다이얼로그 없이 .pdf로 저장하는 기능 + 파일 감시가 실패하는 환경 대비 mtime 폴링 폴백/수동 새로고침.

**Architecture:** PDF는 wry 미노출 네이티브 API를 `with_webview()`로 직접 호출 (macOS: WKWebView printOperation, Windows: WebView2 PrintToPdf). 완료는 `pdf-exported` 이벤트로 프론트에 통지. 리프레시는 기존 notify 감시를 유지한 채 2초 mtime 폴링과 Cmd/Ctrl+R을 추가.

**Tech Stack:** Tauri 2, vanilla TS, objc2/objc2-app-kit/objc2-web-kit (mac), webview2-com/windows (win)

## Global Constraints

- Rust 네이티브 crate 버전은 wry와 일치: objc2 `0.6`, objc2-app-kit/web-kit/foundation `0.3`, block2 `0.6`, webview2-com `0.38`, windows `0.61` (cargo tree로 실측 확인됨)
- `dialog:default` capability에 save 포함 — capabilities 변경 불필요
- Linux PDF export는 범위 외: `Err("PDF export not supported on this platform")`
- 스펙: `docs/superpowers/specs/2026-07-10-pdf-export-refresh-hardening-design.md`
- 커밋 메시지 한국어, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` 푸터

---

### Task 1: Rust `file_mtime` 커맨드

**Files:**
- Modify: `src-tauri/src/lib.rs` (커맨드 추가 + generate_handler 등록 + 파일 말미 tests 모듈)

**Interfaces:**
- Produces: `file_mtime(path: String) -> Result<u64, String>` — epoch millis. invoke 이름 `file_mtime`, 인자 `{ path }`.

- [ ] **Step 1: 실패하는 테스트 작성** — lib.rs 말미에 추가:

```rust
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
```

- [ ] **Step 2: 실패 확인** — Run: `cargo test --manifest-path src-tauri/Cargo.toml file_mtime` → Expected: 컴파일 에러 "cannot find function `file_mtime`"

- [ ] **Step 3: 구현** — `unwatch_file` 아래에 추가:

```rust
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
```

generate_handler에 `file_mtime` 추가:

```rust
        .invoke_handler(tauri::generate_handler![
            get_initial_file,
            read_file,
            watch_file,
            unwatch_file,
            file_mtime
        ])
```

- [ ] **Step 4: 통과 확인** — Run: `cargo test --manifest-path src-tauri/Cargo.toml file_mtime` → Expected: `test result: ok. 2 passed`

- [ ] **Step 5: Commit** — `git add src-tauri/src/lib.rs && git commit -m "feat: file_mtime 커맨드 (폴링 폴백용)"`

---

### Task 2: 프론트 리프레시 보강 (폴링 + 수동 + 에러 내성)

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: Task 1의 `invoke<number>('file_mtime', { path })`
- Produces: `Tab.mtime?: number` 필드, `POLL_MS = 2000` 인터벌, Cmd/Ctrl+R 핸들러

프론트 테스트 하네스 없음 — 검증은 실앱 구동(기존 방식). 단계:

- [ ] **Step 1: Tab에 mtime 추가** — `interface Tab`(src/main.ts:169 부근)에 `mtime?: number;` 필드 추가. `_addTab`의 Tab 리터럴에 `mtime: 0` 포함:

```ts
interface Tab {
  path: string;
  title: string;
  content: string;
  blocks: string[];
  scrollY: number;
  mtime?: number;
}
```

```ts
  const tab: Tab = { path, title, content: tabContent, blocks: [], scrollY: 0, mtime: 0 };
```

- [ ] **Step 2: mtime 헬퍼 + reloadTab 에러 내성** — `reloadTab` (src/main.ts:858 부근)을 다음으로 교체. read 실패(atomic save 순간 파일 부재) 시 조용히 기존 내용 유지:

```ts
/** Fetch mtime for a path; null when unavailable (deleted, briefly missing). */
async function fetchMtime(path: string): Promise<number | null> {
  try {
    return await invoke<number>('file_mtime', { path });
  } catch {
    return null;
  }
}

async function reloadTab(path: string): Promise<void> {
  const tab = findTab(path);
  if (!tab) return;
  // If it's the active tab, save scroll before re-render
  if (path === activePath) {
    tab.scrollY = window.scrollY;
  }
  // Atomic saves briefly remove the file; on read failure keep the current
  // content — the watcher's next event or the mtime poll retries naturally.
  let next: string;
  try {
    next = await invoke<string>('read_file', { path });
  } catch {
    return;
  }
  tab.content = next;
  tab.mtime = (await fetchMtime(path)) ?? tab.mtime;
  if (path === activePath) {
    await renderActive(); // renderActive restores scrollY after mermaid
    if (viewMode === 'source') {
      await renderSource(editorContainer, tab.content);
      setSourceTheme(effectiveTheme);
      setSourceFontSize(fontPx);
      if (searchOpen) {
        // Background reload: reset index to first but don't scroll (preserve viewport).
        searchCurrentIdx = -1;
        runSearch(false);
      }
    }
  }
}
```

- [ ] **Step 3: openTabFromPath에서 초기 mtime 기록** — `_addTab(path, c);` 다음 줄에 추가:

```ts
  const t = findTab(path);
  if (t) t.mtime = (await fetchMtime(path)) ?? 0;
```

- [ ] **Step 4: 폴링 루프** — `startTauri()` 내부(리스너 등록 뒤)에 추가:

```ts
  // Polling fallback: environments where the notify watcher delivers no
  // events (network drives, some Windows setups). mtime comparison keeps it
  // idempotent with watcher-driven reloads (reloadTab refreshes tab.mtime).
  const POLL_MS = 2000;
  setInterval(() => {
    for (const tab of tabs) {
      void fetchMtime(tab.path).then((m) => {
        if (m !== null && tab.mtime !== undefined && m !== tab.mtime) {
          void reloadTab(tab.path);
        }
      });
    }
  }, POLL_MS);
```

- [ ] **Step 5: Cmd/Ctrl+R 수동 리로드** — 기존 전역 keydown(src/main.ts:393 부근)에 분기 추가 (WebView 자체 리로드 차단):

```ts
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    triggerFind();
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
    e.preventDefault();
    if (activePath) void reloadTab(activePath);
  } else if (e.key === 'Escape' && searchOpen) {
    e.preventDefault();
    closeSearchBar();
  }
});
```

- [ ] **Step 6: 타입체크 + 실앱 검증** — Run: `npx tsc --noEmit` → PASS. 실앱: dev 바이너리로 테스트 파일 열고 (1) 외부에서 파일 수정 → 2초 내 갱신 (2) Cmd+R → 즉시 갱신. screencapture로 확인.

- [ ] **Step 7: Commit** — `git add src/main.ts && git commit -m "feat: 리프레시 보강 — mtime 폴링 폴백, Cmd/Ctrl+R 수동 리로드, atomic save 순간 read 실패 내성"`

---

### Task 3: print CSS + 테마 export 오버라이드

**Files:**
- Modify: `src/theme.ts`, `src/styles.css`

**Interfaces:**
- Produces: `setExportOverride(on: boolean): void` (theme.ts export) — on이면 라이트 강제(비영속), off면 원래 모드 복귀. 기존 `apply()` 경유라 onChange 콜백(mermaid 재렌더)도 동일하게 발화.

- [ ] **Step 1: theme.ts 오버라이드** — `computeEffective` 위에 상태 추가, 함수 수정, export 추가:

```ts
let exportOverride = false;

function computeEffective(): EffectiveTheme {
  if (exportOverride) {
    return 'light';
  }
  if (mode === 'system') {
    return darkQuery.matches ? 'dark' : 'light';
  }
  return mode;
}

/**
 * PDF export는 항상 라이트로 출력한다. localStorage에 남기지 않는 임시
 * 오버라이드 — apply()를 타므로 onChange(mermaid 재렌더 등)도 동일 발화.
 */
export function setExportOverride(on: boolean): void {
  exportOverride = on;
  apply();
}
```

- [ ] **Step 2: print CSS** — `src/styles.css` 말미에 추가:

```css
/* ── PDF export / print ─────────────────────────────────────────────────────
   Hide app chrome; print only the rendered document, always on white. */
@media print {
  #toolbar,
  #search-bar,
  #recent-menu,
  #editor {
    display: none !important;
  }
  html,
  body {
    background: #fff !important;
  }
  #content {
    display: block !important;
    max-width: none !important;
    padding: 0 !important;
    margin: 0 !important;
  }
  #content pre,
  #content table,
  #content .mermaid-block,
  #content img {
    break-inside: avoid;
  }
}
```

- [ ] **Step 3: 타입체크** — Run: `npx tsc --noEmit` → PASS

- [ ] **Step 4: Commit** — `git add src/theme.ts src/styles.css && git commit -m "feat: PDF export 준비 — 테마 라이트 오버라이드, print CSS"`

---

### Task 4: Rust `export_pdf` (macOS)

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `export_pdf(dest: String)` invoke 커맨드. 완료 시 `pdf-exported` 이벤트 emit — payload `{ ok: bool, path: String, error: String | null }` (`PdfPayload`).

- [ ] **Step 1: 의존성** — Cargo.toml에 추가 (버전은 wry 실측과 일치):

```toml
[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.6"
objc2-foundation = "0.3"
objc2-app-kit = { version = "0.3", features = ["NSPrintInfo", "NSPrintOperation"] }
objc2-web-kit = { version = "0.3", features = ["WKWebView", "objc2-app-kit"] }
```

컴파일에서 feature 누락 에러가 나면 에러 메시지가 요구하는 feature를 그대로 추가한다 (objc2 계열은 클래스 단위 fine-grained feature).

- [ ] **Step 2: 커맨드 구현** — lib.rs에 추가:

```rust
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
                use objc2_app_kit::{NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob};
                use objc2_foundation::{NSString, NSURL};
                use objc2_web_kit::WKWebView;

                let result: Result<(), String> = (|| unsafe {
                    let webview: &WKWebView = &*(wv.inner() as *const WKWebView);
                    let info: Retained<NSPrintInfo> = NSPrintInfo::sharedPrintInfo().copy();
                    info.setJobDisposition(NSPrintSaveJob);
                    let url = NSURL::fileURLWithPath(&NSString::from_str(&dest2));
                    let dict = info.dictionary();
                    dict.setObject_forKey(
                        &*url,
                        objc2::runtime::ProtocolObject::from_ref(NSPrintJobSavingURL),
                    );
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
```

`use tauri::{Emitter, Manager};`는 파일 상단에 이미 있음. generate_handler에 `export_pdf` 추가:

```rust
        .invoke_handler(tauri::generate_handler![
            get_initial_file,
            read_file,
            watch_file,
            unwatch_file,
            file_mtime,
            export_pdf
        ])
```

- [ ] **Step 3: 컴파일 루프** — Run: `cargo check --manifest-path src-tauri/Cargo.toml`. objc2 바인딩 시그니처(예: `copy()`의 트레이트 import `objc2_foundation::NSCopying`, `ProtocolObject` 경로, `op.view()` Option 여부)는 에러 메시지 따라 교정. Expected: 최종 `Finished`.

주의: `runOperation()`이 WKWebView에서 빈 PDF/무응답이면 폴백 —
`runOperationModalForWindow_delegate_didRunSelector_contextInfo(main_window, None, None, null_mut())`
+ 파일 생성 폴링(0.5s × 20회, 존재+크기>0 → ok emit)로 전환한다. 이 판단은 Task 5의 실검증에서.

- [ ] **Step 4: Commit** — `git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs && git commit -m "feat: export_pdf 커맨드 (macOS WKWebView printOperation)"`

---

### Task 5: 프론트 PDF UI + macOS 실검증

**Files:**
- Modify: `index.html`, `src/main.ts`

**Interfaces:**
- Consumes: Task 4 `invoke('export_pdf', { dest })` + `pdf-exported` 이벤트, Task 3 `setExportOverride`
- Produces: `#btn-pdf` 툴바 버튼, Cmd/Ctrl+P 단축키

- [ ] **Step 1: 툴바 버튼** — index.html `#btn-copy-path` 버튼 앞에 추가:

```html
        <button class="icon-btn" id="btn-pdf" title="PDF로 저장 (⌘P)">
          <!-- document-download icon -->
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="12" y1="12" x2="12" y2="18"/>
            <polyline points="9 15 12 18 15 15"/>
          </svg>
        </button>
```

- [ ] **Step 2: export 흐름** — src/main.ts. import 확장:

```ts
import { open, save } from '@tauri-apps/plugin-dialog';
import { initTheme, setMode, getMode, setExportOverride, type EffectiveTheme, type ThemeMode } from './theme';
```

DOM ref 추가(기존 ref 블록에):

```ts
const btnPdf = document.querySelector<HTMLButtonElement>('#btn-pdf')!;
```

`renderAllMermaid` 아래에 export 함수 추가:

```ts
// ── PDF export ────────────────────────────────────────────────────────────────
let pdfExporting = false;

/**
 * Save the active document as PDF: pick destination, force light theme
 * (mermaid re-rendered light), let Rust drive the native print-to-PDF, then
 * restore the current theme. Completion arrives via the `pdf-exported` event.
 */
async function exportPdf(): Promise<void> {
  if (!isTauri || pdfExporting || activePath === null) return;
  const tab = findTab(activePath);
  if (!tab) return;
  const defaultName = tab.title.replace(/\.(md|markdown)$/i, '') + '.pdf';
  const sep = activePath.includes('\\') ? '\\' : '/';
  const dir = activePath.slice(0, activePath.lastIndexOf(sep));
  const dest = await save({
    defaultPath: dir + sep + defaultName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (dest === null) return; // user cancelled
  pdfExporting = true;
  try {
    // PDF is always light; setExportOverride triggers the theme onChange,
    // but that mermaid re-render is fire-and-forget — await one explicitly.
    setExportOverride(true);
    await renderAllMermaid(tab.blocks, 'default');
    await invoke('export_pdf', { dest });
  } catch (err) {
    toast(`PDF 저장 실패: ${err}`);
    setExportOverride(false);
    pdfExporting = false;
  }
}

function finishPdfExport(ok: boolean, path: string, error: string | null): void {
  setExportOverride(false);
  pdfExporting = false;
  if (ok) {
    toast(`PDF 저장됨: ${path}`);
  } else {
    toast(`PDF 저장 실패: ${error ?? '알 수 없는 오류'}`);
  }
}

btnPdf.addEventListener('click', () => void exportPdf());
```

`startTauri()`의 리스너 블록에 추가:

```ts
  await listen<{ ok: boolean; path: string; error: string | null }>('pdf-exported', (e) => {
    finishPdfExport(e.payload.ok, e.payload.path, e.payload.error);
  });
```

전역 keydown에 분기 추가 (Task 2에서 만든 r 분기 옆):

```ts
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
    e.preventDefault();
    void exportPdf();
  }
```

- [ ] **Step 3: 타입체크** — Run: `npx tsc --noEmit` → PASS

- [ ] **Step 4: macOS 실검증** — `npm run tauri build -- --no-bundle` 후 새 바이너리로 mermaid+코드블록+긴 본문 테스트 문서 열기 → PDF 버튼 → 저장 → 산출 .pdf를 열어 확인: (a) 페이지네이션 존재 (b) 라이트 테마 (c) 툴바/탭바 없음 (d) mermaid 라이트 렌더. 다크 모드에서 export 후 화면이 다크로 복귀하는지 확인. 빈 PDF/무응답이면 Task 4 Step 3의 폴백(runOperationModalForWindow + 파일 폴링)으로 전환 후 재검증.

- [ ] **Step 5: Commit** — `git add index.html src/main.ts && git commit -m "feat: PDF로 저장 — 툴바 버튼/Cmd·Ctrl+P, 라이트 강제, 완료 toast"`

---

### Task 6: Rust `export_pdf` (Windows) + 크로스빌드

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 4의 `PdfPayload`/`pdf-exported` 계약 그대로
- Produces: Windows 분기 구현 (컴파일 검증만 — 실기 미검증)

- [ ] **Step 1: 의존성** —

```toml
[target.'cfg(target_os = "windows")'.dependencies]
webview2-com = "0.38"
windows = "0.61"
```

- [ ] **Step 2: Windows 분기** — `export_pdf`의 `#[cfg(not(target_os = "macos"))]` 블록을 다음으로 교체:

```rust
    #[cfg(target_os = "windows")]
    {
        let app = window.app_handle().clone();
        let dest2 = dest.clone();
        window
            .with_webview(move |wv| {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_7;
                use webview2_com::PrintToPdfCompletedHandler;
                use windows::core::{Interface, HSTRING};

                let emit_err = |app: &tauri::AppHandle, msg: String| {
                    let _ = app.emit(
                        "pdf-exported",
                        PdfPayload {
                            ok: false,
                            path: String::new(),
                            error: Some(msg),
                        },
                    );
                };

                unsafe {
                    let controller = wv.controller();
                    let core = match controller.CoreWebView2() {
                        Ok(c) => c,
                        Err(e) => return emit_err(&app, e.to_string()),
                    };
                    let core7: ICoreWebView2_7 = match core.cast() {
                        Ok(c) => c,
                        Err(e) => return emit_err(&app, e.to_string()),
                    };
                    let app2 = app.clone();
                    let dest3 = dest2.clone();
                    let handler = PrintToPdfCompletedHandler::create(Box::new(
                        move |result, is_successful| {
                            let ok = result.is_ok() && is_successful;
                            let _ = app2.emit(
                                "pdf-exported",
                                PdfPayload {
                                    ok,
                                    path: dest3.clone(),
                                    error: if ok {
                                        None
                                    } else {
                                        Some(format!("{result:?}"))
                                    },
                                },
                            );
                            Ok(())
                        },
                    ));
                    if let Err(e) =
                        core7.PrintToPdf(&HSTRING::from(dest2.as_str()), None, &handler)
                    {
                        emit_err(&app, e.to_string());
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
```

`PrintToPdfCompletedHandler::create`의 클로저 시그니처(에러 타입, 반환형)는 webview2-com 0.38 문서 기준 — 컴파일 에러 메시지에 맞춰 교정.

- [ ] **Step 3: 크로스 컴파일 검증** — Run: `XWIN_ACCEPT_LICENSE=1 cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc` (cargo-xwin 환경이면 `cargo xwin check ...`) → Expected: `Finished`. mac 빌드 회귀 확인: `cargo check --manifest-path src-tauri/Cargo.toml` → `Finished`.

- [ ] **Step 4: Commit** — `git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs && git commit -m "feat: export_pdf Windows 분기 (WebView2 PrintToPdf)"`

---

### Task 7: 최종 검증 + 번들 빌드

**Files:** 없음 (검증/빌드만)

- [ ] **Step 1: 전체 테스트** — `cargo test --manifest-path src-tauri/Cargo.toml` → ok, `npx tsc --noEmit` → PASS
- [ ] **Step 2: macOS 번들** — `npm run tauri build` (tail 파이프 금지) → .app 산출. 산출 앱으로 스모크: 파일 열기 → 외부 수정 반영 → Cmd+R → PDF export 1회.
- [ ] **Step 3: Windows 번들** — `XWIN_ACCEPT_LICENSE=1 npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc` → NSIS 인스톨러 산출 (실기 미검증 한계 명시).
- [ ] **Step 4: 사용자 보고** — 산출물 경로, 검증 결과, Windows 실기 미검증 한계.

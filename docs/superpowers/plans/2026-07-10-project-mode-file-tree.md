# 프로젝트 모드 (파일트리 사이드바) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 폴더를 열면 좌측 사이드바에 md 전용 파일트리를 표시하고, 클릭으로 기존 탭 시스템에 파일을 연다.

**Architecture:** 파일시스템 접근은 전부 Rust(스캔 + 재귀 watch, fs 플러그인 사용 안 함). 프론트는 vanilla TS로 사이드바 DOM을 직접 렌더. 프로젝트 미오픈 시 기존 UX 무변화.

**Tech Stack:** Tauri v2, notify-debouncer-full 0.7 (기존), vanilla TypeScript, tempfile(dev-dep, 테스트용)

**Spec:** `docs/superpowers/specs/2026-07-10-project-mode-file-tree-design.md`

## Global Constraints

- 파일 필터: `.md`/`.markdown` 확장자만 (대소문자 무시)
- 폴더 필터: 하위에 md가 하나라도 있는 폴더만. `.`으로 시작하는 항목·`node_modules` 제외, 심볼릭 링크 안 따라감
- 스캔 상한: 10,000 엔트리 (`SCAN_MAX_ENTRIES`), 초과 시 `truncated: true`
- localStorage 키: `mdview-project`
- 이벤트 이름: `tree-changed`
- 사이드바 폭: 240px 고정. 프로젝트 미오픈 시 `hidden`
- 완료 후 버전 0.1.4 (`pnpm bump 0.1.4` — package.json/tauri.conf.json/Cargo.toml 동시 갱신)
- Rust 테스트: `cargo test --manifest-path src-tauri/Cargo.toml` (dist/ 없으면 먼저 `pnpm build`)
- 프론트 타입체크: `pnpm build` (tsc && vite build)
- 커밋 메시지 끝: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Rust `scan_tree` 커맨드 + 단위 테스트

**Files:**
- Modify: `src-tauri/Cargo.toml` (dev-dependencies에 tempfile 추가)
- Modify: `src-tauri/src/lib.rs` (TreeNode/ScanResult/scan_children/scan_tree + tests 모듈 + 커맨드 등록)

**Interfaces:**
- Consumes: 없음 (독립)
- Produces: `scan_tree(root: String) -> Result<ScanResult, String>` Tauri 커맨드.
  `ScanResult { tree: TreeNode, truncated: bool }`,
  `TreeNode { name: String, path: String, is_dir: bool, children: Vec<TreeNode> }`
  (serde 직렬화 → JS에서 `{ name, path, is_dir, children }`, `truncated`).
  root가 디렉토리가 아니면 `Err` — Task 5의 드롭 핸들러가 파일/폴더 판별에 사용.

- [ ] **Step 1: tempfile dev-dep 추가**

`src-tauri/Cargo.toml`의 `[target.'cfg(target_os = "windows")'.dependencies]` 섹션 뒤(파일 끝)에 추가:

```toml

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src-tauri/src/lib.rs` 파일 끝에 추가:

```rust
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
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 컴파일 에러 — `scan_children`, `scan_tree`, `TreeNode` 미정의.
(참고: `tauri::generate_context!` 때문에 `dist/`가 필요 — 없으면 먼저 `pnpm build`.)

- [ ] **Step 4: 구현**

`src-tauri/src/lib.rs` 상단 import 수정 — 기존 `use std::path::PathBuf;` 를:

```rust
use std::path::{Path, PathBuf};
```

`unwatch_file` 함수 정의 끝(약 line 113 `}` ) 뒤, `/// Event payload for `pdf-exported`.` 주석 앞에 추가:

```rust
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
```

`invoke_handler`의 `generate_handler![...]` 목록에 `scan_tree` 추가:

```rust
        .invoke_handler(tauri::generate_handler![
            get_initial_file,
            read_file,
            watch_file,
            unwatch_file,
            file_mtime,
            export_pdf,
            scan_tree
        ])
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 7개 테스트 전부 PASS (`test result: ok. 7 passed`)

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "feat(rust): scan_tree — md 전용 프로젝트 트리 스캔

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Rust `watch_dir`/`unwatch_dir` 커맨드

**Files:**
- Modify: `src-tauri/src/lib.rs` (AppState 필드 추가, 커맨드 2개, setup/등록 갱신)

**Interfaces:**
- Consumes: 기존 notify 디바운서 인프라 (`FileWatcher` 타입, `new_debouncer`)
- Produces: `watch_dir(root: String) -> Result<(), String>`, `unwatch_dir(root: String)`
  Tauri 커맨드. 변경 시 `tree-changed` 이벤트 emit (payload 없음 — 프론트는 재스캔만 함).
  watch_dir는 호출 시 이전 dir watch를 전부 교체 (단일 프로젝트).

주의: notify watcher는 단위 테스트로 이벤트 검증이 어려움(플랫폼 이벤트 루프 필요).
이 Task는 컴파일 + 기존 테스트 유지가 게이트, 동작 검증은 Task 6 수동 루프에서.

- [ ] **Step 1: AppState에 dir_watchers 추가**

`struct AppState` 를:

```rust
struct AppState {
    watchers: Mutex<HashMap<String, FileWatcher>>,
    dir_watchers: Mutex<HashMap<String, FileWatcher>>,
}
```

`setup()`의 `app.manage(AppState { ... })` 를:

```rust
            app.manage(AppState {
                watchers: Mutex::new(HashMap::new()),
                dir_watchers: Mutex::new(HashMap::new()),
            });
```

- [ ] **Step 2: 커맨드 구현**

Task 1에서 넣은 `scan_tree` 함수 뒤에 추가:

```rust
/// Start watching `root` recursively for the project tree. Any debounced
/// change below it emits `tree-changed` (no payload — the frontend rescans
/// the whole tree). Only one project is open at a time, so any previous dir
/// watch is replaced (dropped).
#[tauri::command]
fn watch_dir(
    root: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let handle = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        None,
        move |res: DebounceEventResult| {
            if res.is_ok() {
                let _ = handle.emit("tree-changed", ());
            }
        },
    )
    .map_err(|e| e.to_string())?;
    debouncer
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
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
```

`generate_handler!` 목록에 `watch_dir`, `unwatch_dir` 추가 (scan_tree 뒤):

```rust
            export_pdf,
            scan_tree,
            watch_dir,
            unwatch_dir
```

- [ ] **Step 3: 컴파일 + 기존 테스트 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 7개 테스트 PASS, 경고 없음(unused 등)

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(rust): watch_dir/unwatch_dir — 프로젝트 트리 재귀 watch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 사이드바 UI 골격 (index.html + styles.css)

**Files:**
- Modify: `index.html` (사이드바 마크업 + 폴더 열기 버튼)
- Modify: `src/styles.css` (사이드바/트리 스타일, pdf-exporting 확장)

**Interfaces:**
- Consumes: 기존 `.icon-btn` 스타일, `html[data-mdview-theme]` 테마 셀렉터, `body.pdf-exporting` 규칙
- Produces: DOM id — `#sidebar`, `#sidebar-title`, `#sidebar-close`, `#tree`, `#btn-open-folder`.
  CSS 클래스 — `body.project-open`(콘텐츠 밀기), `.tree-children`, `.tree-row`,
  `.tree-row.active`, `.tree-dir`, `.tree-file`, `.tree-icon`, `.tree-label`, `.tree-empty`.
  Task 4의 main.ts가 이 id/클래스를 그대로 사용.

기본 `hidden`이므로 이 Task 단독으로는 화면 변화 없음. 게이트 = 빌드 통과.

- [ ] **Step 1: index.html에 폴더 열기 버튼 추가**

`<button class="icon-btn" id="btn-open" title="파일 열기 (+)">+</button>` (line 86) **앞**에 추가:

```html
        <button class="icon-btn" id="btn-open-folder" title="폴더 열기">
          <!-- folder icon -->
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
```

- [ ] **Step 2: index.html에 사이드바 마크업 추가**

`</div>` (toolbar 닫는 태그, line 88)와 `<article id="content" ...>` 사이에 추가:

```html
    <!-- Project mode: md-only file tree (hidden unless a folder is open) -->
    <aside id="sidebar" hidden>
      <div id="sidebar-header">
        <span id="sidebar-title"></span>
        <button class="icon-btn" id="sidebar-close" title="프로젝트 닫기">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div id="tree"></div>
    </aside>
```

- [ ] **Step 3: styles.css에 사이드바 스타일 추가**

`body.pdf-exporting` 블록(약 line 584) **앞**에 추가:

```css
/* ── 프로젝트 모드: 파일트리 사이드바 ─────────────────────────────────────
   고정 240px, sticky 툴바(min-height 44px) 아래에 fixed. 프로젝트 미오픈
   시 hidden — 기존 단일 뷰어 레이아웃은 변하지 않는다. */
#sidebar {
  position: fixed;
  top: 44px;
  left: 0;
  bottom: 0;
  width: 240px;
  overflow-y: auto;
  overflow-x: hidden;
  border-right: 1px solid;
  font-size: 13px;
  z-index: 50;
  user-select: none;
}
body.project-open #content,
body.project-open #editor {
  margin-left: 240px;
}
html[data-mdview-theme='light'] #sidebar {
  background: #f6f8fa;
  border-color: #d1d9e0;
  color: #1f2328;
}
html[data-mdview-theme='dark'] #sidebar {
  background: #010409;
  border-color: #3d444d;
  color: #f0f6fc;
}

#sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 6px 6px 12px;
  font-weight: 600;
  position: sticky;
  top: 0;
  background: inherit;
}
#sidebar-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-children {
  padding-left: 14px;
}
#tree > .tree-children {
  padding-left: 0;
}
.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
  border-radius: 4px;
}
html[data-mdview-theme='light'] .tree-row:hover {
  background: #eaeef2;
}
html[data-mdview-theme='dark'] .tree-row:hover {
  background: #161b22;
}
html[data-mdview-theme='light'] .tree-row.active {
  background: #ddf4ff;
}
html[data-mdview-theme='dark'] .tree-row.active {
  background: #1f6feb33;
}
.tree-icon {
  width: 12px;
  flex-shrink: 0;
  text-align: center;
  font-size: 10px;
  opacity: 0.7;
}
.tree-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tree-empty {
  padding: 12px;
  opacity: 0.6;
}
```

- [ ] **Step 4: pdf-exporting 규칙 확장**

기존 블록:

```css
body.pdf-exporting #toolbar,
body.pdf-exporting #search-bar,
body.pdf-exporting #recent-menu,
body.pdf-exporting #editor {
  display: none !important;
}
```

를 다음으로 교체 (`#sidebar` 추가 + margin 리셋):

```css
body.pdf-exporting #toolbar,
body.pdf-exporting #search-bar,
body.pdf-exporting #recent-menu,
body.pdf-exporting #sidebar,
body.pdf-exporting #editor {
  display: none !important;
}
/* 프로젝트 모드에서 PDF 캡처 시 본문이 사이드바만큼 밀려 있으면 안 된다. */
body.pdf-exporting #content {
  margin-left: 0 !important;
}
```

- [ ] **Step 5: 빌드 확인**

Run: `pnpm build`
Expected: tsc + vite build 성공 (exit 0)

- [ ] **Step 6: 커밋**

```bash
git add index.html src/styles.css
git commit -m "feat(ui): 파일트리 사이드바 마크업/스타일 골격

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: main.ts 프로젝트 모드 코어 (열기/렌더/클릭/하이라이트)

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: Task 1 `scan_tree`, Task 2 `watch_dir`/`unwatch_dir` 커맨드,
  Task 3 DOM id/클래스, 기존 `openTabFromPath(path)`, `toast(msg)`, `invoke`, `open`(dialog)
- Produces: `openProject(root: string, silent?: boolean): Promise<void>`,
  `closeProject(): void`, `refreshTree(): Promise<void>`,
  `updateTreeHighlight(): void`, 상수 `PROJECT_KEY = 'mdview-project'`.
  Task 5의 startTauri 통합이 이 함수들을 호출.

- [ ] **Step 1: 프로젝트 모드 섹션 추가**

`src/main.ts`의 `openTabFromPath` 함수 끝(line 1063 `}`)과
`// ── Theme init (before first render) ──...` 주석 사이에 추가:

```ts
// ── Project mode (md-only file tree sidebar) ─────────────────────────────────
interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeNode[];
}
interface ScanResult {
  tree: TreeNode;
  truncated: boolean;
}

const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
const sidebarTitle = document.querySelector<HTMLElement>('#sidebar-title')!;
const sidebarClose = document.querySelector<HTMLButtonElement>('#sidebar-close')!;
const treeEl = document.querySelector<HTMLElement>('#tree')!;
const btnOpenFolder = document.querySelector<HTMLButtonElement>('#btn-open-folder')!;

const PROJECT_KEY = 'mdview-project';
let projectRoot: string | null = null;
let projectTree: TreeNode | null = null;
const expandedPaths = new Set<string>();

/// silent: 시작 시 복원/드롭 판별 경로 — 실패해도 toast 없이 조용히 넘어간다.
async function openProject(root: string, silent = false): Promise<void> {
  let res: ScanResult;
  try {
    res = await invoke<ScanResult>('scan_tree', { root });
  } catch (e) {
    if (silent) {
      // 복원 대상 폴더가 사라진 경우: 기억을 지운다.
      if (localStorage.getItem(PROJECT_KEY) === root) {
        localStorage.removeItem(PROJECT_KEY);
      }
    } else {
      toast(`폴더 열기 실패: ${String(e)}`);
    }
    return;
  }
  if (projectRoot !== root) {
    // 새 프로젝트: 펼침 상태 초기화, 루트 직속만 펼침(자식 dir는 접힘).
    expandedPaths.clear();
  }
  projectRoot = root;
  projectTree = res.tree;
  if (res.truncated) toast('항목이 많아 트리를 일부만 표시합니다');
  sidebarTitle.textContent = res.tree.name;
  sidebarTitle.title = root;
  sidebar.hidden = false;
  document.body.classList.add('project-open');
  renderTree();
  localStorage.setItem(PROJECT_KEY, root);
  await invoke('watch_dir', { root });
}

function closeProject(): void {
  if (projectRoot) void invoke('unwatch_dir', { root: projectRoot });
  projectRoot = null;
  projectTree = null;
  expandedPaths.clear();
  treeEl.textContent = '';
  sidebar.hidden = true;
  document.body.classList.remove('project-open');
  localStorage.removeItem(PROJECT_KEY);
}

/// tree-changed 수신 시 재스캔. 펼침 상태(expandedPaths)는 그대로 유지.
async function refreshTree(): Promise<void> {
  if (!projectRoot) return;
  try {
    const res = await invoke<ScanResult>('scan_tree', { root: projectRoot });
    projectTree = res.tree;
    renderTree();
  } catch {
    // 프로젝트 폴더 자체가 사라짐
    closeProject();
  }
}

function renderTree(): void {
  treeEl.textContent = '';
  if (!projectTree) return;
  if (projectTree.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'md 파일 없음';
    treeEl.appendChild(empty);
    return;
  }
  treeEl.appendChild(buildTreeChildren(projectTree.children));
  updateTreeHighlight();
}

function buildTreeChildren(nodes: TreeNode[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'tree-children';
  for (const n of nodes) {
    const row = document.createElement('div');
    row.className = 'tree-row ' + (n.is_dir ? 'tree-dir' : 'tree-file');
    row.dataset.path = n.path;
    row.title = n.path;

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = n.name;
    row.appendChild(icon);
    row.appendChild(label);
    wrap.appendChild(row);

    if (n.is_dir) {
      const expanded = expandedPaths.has(n.path);
      icon.textContent = expanded ? '▾' : '▸';
      row.addEventListener('click', () => {
        if (expandedPaths.has(n.path)) {
          expandedPaths.delete(n.path);
        } else {
          expandedPaths.add(n.path);
        }
        renderTree();
      });
      if (expanded) {
        wrap.appendChild(buildTreeChildren(n.children));
      }
    } else {
      row.addEventListener('click', () => {
        void openTabFromPath(n.path);
      });
    }
  }
  return wrap;
}

/// 활성 탭 파일을 트리에서 하이라이트. renderTabBar()가 탭 변화마다 호출.
function updateTreeHighlight(): void {
  if (sidebar.hidden) return;
  for (const el of treeEl.querySelectorAll<HTMLElement>('.tree-row.active')) {
    el.classList.remove('active');
  }
  if (!activePath) return;
  const row = treeEl.querySelector<HTMLElement>(
    `.tree-file[data-path="${CSS.escape(activePath)}"]`,
  );
  if (row) {
    row.classList.add('active');
    row.scrollIntoView({ block: 'nearest' });
  }
}

sidebarClose.addEventListener('click', () => closeProject());

btnOpenFolder.addEventListener('click', async () => {
  const sel = await open({ directory: true });
  if (typeof sel === 'string') {
    await openProject(sel);
  }
});
```

- [ ] **Step 2: renderTabBar에 하이라이트 훅 추가**

`renderTabBar()` 함수(line 884) 끝의:

```ts
  activeEl?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  updateCopyPathBtn();
}
```

를:

```ts
  activeEl?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  updateCopyPathBtn();
  updateTreeHighlight();
}
```

(함수 선언은 호이스팅되므로 정의 순서 무관.)

- [ ] **Step 3: 타입체크 + 빌드**

Run: `pnpm build`
Expected: 성공. `open`이 directory 모드에서 `string | null` 반환 — 배열 아님 주의.

- [ ] **Step 4: dev 수동 검증 (코어 플로우)**

Run: `pnpm tauri dev`
확인:
1. 툴바 폴더 버튼 클릭 → 폴더 선택 다이얼로그 → 선택 시 좌측 트리 표시
2. 트리에 md 파일/md 있는 폴더만 보임
3. 루트 직속 폴더는 접힘(▸) 상태로 시작, 클릭 → 펼침(▾)
4. 파일 클릭 → 탭으로 열림, 트리에서 해당 행 하이라이트
5. 탭 전환 → 하이라이트 따라감
6. × 클릭 → 사이드바 사라지고 본문 margin 원복, 탭은 유지

- [ ] **Step 5: 커밋**

```bash
git add src/main.ts
git commit -m "feat: 프로젝트 모드 코어 — 폴더 열기, 트리 렌더, 클릭 오픈, 하이라이트

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: startTauri 통합 — 드롭/자동갱신/복원/하네스

**Files:**
- Modify: `src/main.ts` (startTauri 내부 4곳 + Chrome 하네스 분기)

**Interfaces:**
- Consumes: Task 4 `openProject`/`refreshTree`/`PROJECT_KEY`, Rust `tree-changed` 이벤트
- Produces: 최종 사용자 플로우 (드래그&드롭, 자동 갱신, 재실행 복원)

- [ ] **Step 1: tree-changed 리스너 추가**

`startTauri()` 안, `pdf-export-test` 리스너 블록 뒤에 추가:

```ts
  await listen('tree-changed', () => {
    void refreshTree();
  });
```

- [ ] **Step 2: 드롭 핸들러에 폴더 지원 추가**

기존:

```ts
  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'drop') {
      for (const p of event.payload.paths) {
        void openTabFromPath(p);
      }
    }
  });
```

를:

```ts
  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'drop') {
      for (const p of event.payload.paths) {
        if (/\.(md|markdown)$/i.test(p)) {
          void openTabFromPath(p);
        } else {
          // md가 아니면 폴더로 시도 — scan_tree가 디렉토리 판별.
          // 파일 등 실패 케이스는 조용히 무시(silent).
          void openProject(p, true);
        }
      }
    }
  });
```

- [ ] **Step 3: 시작 시 프로젝트 복원**

`startTauri()` 끝부분, 기존:

```ts
  const initial = await invoke<string[]>('get_initial_file');
  if (initial.length > 0) {
    for (const p of initial) {
      await openTabFromPath(p);
    }
  } else {
    await renderActive(); // show placeholder
  }
```

뒤에 추가:

```ts
  // 마지막 프로젝트 복원 (폴더가 사라졌으면 openProject가 조용히 기억을 지움)
  const savedProject = localStorage.getItem(PROJECT_KEY);
  if (savedProject) {
    await openProject(savedProject, true);
  }
```

- [ ] **Step 4: Chrome dev 하네스에서 폴더 버튼 숨김**

파일 끝 기존:

```ts
} else {
  // Chrome dev harness: hide + button, load fixture
  btnOpen.style.display = 'none';
```

를:

```ts
} else {
  // Chrome dev harness: hide + button, load fixture
  btnOpen.style.display = 'none';
  btnOpenFolder.style.display = 'none';
```

- [ ] **Step 5: 빌드 + dev 수동 검증 (통합 플로우)**

Run: `pnpm build && pnpm tauri dev`
확인:
1. Finder에서 폴더를 창에 드래그 → 프로젝트 열림. md 파일 드래그 → 기존처럼 탭
2. 프로젝트 열린 상태에서 터미널로 `touch <프로젝트>/새파일.md` → 1초 내 트리에 나타남
3. `rm` 으로 삭제 → 트리에서 사라짐. 펼쳐 둔 폴더는 펼침 유지
4. 앱 종료 → 재실행 → 같은 프로젝트 자동 복원
5. 프로젝트 폴더 통째로 삭제 후 재실행 → 에러 없이 뷰어 모드로 시작
6. md 없는 폴더 열기 → "md 파일 없음" 표시

- [ ] **Step 6: 커밋**

```bash
git add src/main.ts
git commit -m "feat: 프로젝트 모드 통합 — 폴더 드롭, tree-changed 자동갱신, 재실행 복원

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 전체 검증 + PDF 회귀 + 0.1.4 릴리스

**Files:**
- Modify: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (bump 스크립트가 처리)

**Interfaces:**
- Consumes: Task 1-5 전부
- Produces: v0.1.4 macOS .app/.dmg + Windows NSIS 인스톨러

- [ ] **Step 1: 전체 테스트**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && pnpm build`
Expected: Rust 테스트 전부 PASS, 프론트 빌드 성공

- [ ] **Step 2: PDF 회귀 확인**

프로젝트 모드 켠 상태에서 PDF 내보내기 1회 (`pnpm tauri dev` → 폴더 열기 → md 열기 → ⌘P):
사이드바가 PDF에 찍히지 않고, 본문이 왼쪽으로 밀려 있지 않아야 함
(`body.pdf-exporting #sidebar` / `margin-left: 0` 규칙 검증).

- [ ] **Step 3: 버전 bump**

Run: `pnpm bump 0.1.4`
Expected: package.json / tauri.conf.json / Cargo.toml 모두 0.1.4로 변경 (Cargo.lock 포함)

- [ ] **Step 4: 릴리스 커밋**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: release v0.1.4

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: macOS 빌드**

Run: `pnpm tauri build`
Expected: `src-tauri/target/release/bundle/` 에 0.1.4 .app/.dmg.
주의(메모리): tail로 파이프하지 말 것(종료코드 가림). DMG 실패 시 stale `/Volumes/dmg.*` detach.

- [ ] **Step 6: Windows 빌드**

Run: `XWIN_ACCEPT_LICENSE=1 pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc`
Expected: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/mdview_0.1.4_x64-setup.exe`

- [ ] **Step 7: 빌드 산출물로 스모크**

빌드된 .app 실행 → 폴더 열기 → 파일 클릭 → 트리 갱신 확인 (dev가 아닌 번들에서 1회).

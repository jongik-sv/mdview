# BPMN 트리 노출 + 외부 프로그램 열기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프로젝트 모드 파일트리에 `.bpmn` 파일을 `.md`와 동급으로 노출하고, 클릭하거나
드래그&드롭하면 mdview 탭으로 열지 않고 OS에 등록된 기본 프로그램(예: Camunda Modeler)으로
위임한다.

**Architecture:** 백엔드의 파일명 게이트(`is_markdown_name`)를 `is_viewable_name`으로 이름
변경·확장해 `.bpmn`도 인정하게 만든다(트리 스캔의 유일한 필터 지점이라 이 한 곳만 바꾸면
lazy 스캔과 pruning 둘 다 자동으로 맞물린다). 프론트엔드는 트리 파일 행 클릭 핸들러와
드래그&드롭 핸들러 두 곳에서 `.bpmn` 확장자를 판별해 기존 `openTabFromPath` 대신 이미
import되어 있는 `openPath`(OS 기본 프로그램 실행, `@tauri-apps/plugin-opener`)를 호출한다.
새 의존성·새 파일·새 IPC 커맨드 없음.

**Tech Stack:** Rust(Tauri backend, `src-tauri/src/lib.rs`), TypeScript(`src/main.ts`),
기존 `@tauri-apps/plugin-opener`의 `openPath`.

## Global Constraints

- bpmn-js 등 신규 프론트 의존성 추가 없음 — `package.json` 변경 없음.
- `src-tauri/tauri.conf.json` 변경 없음 — mdview를 `.bpmn` 기본 앱으로 등록하지 않는다.
- `.bpmn` 파일은 절대 탭으로 열리지 않는다 — 탭 시스템, 소스뷰, PDF 내보내기, 문서 내
  검색 코드 경로는 건드리지 않는다.
- 트리 아이콘은 기존 아이콘셋과 통일된 `currentColor` 선화 스타일(폴더/파일 아이콘과 동일
  시각 언어). bpmn.io 공식 컬러 로고를 그대로 쓰지 않는다.
- 최종 버전: `0.1.12` (patch bump).
- 이 프로젝트에는 프론트엔드 자동화 테스트 인프라가 없다(기존 컨벤션) — 프론트 변경의
  "테스트"는 `pnpm build`(타입체크 통과)와 수동 시나리오 확인으로 한다. Rust 쪽은
  `cargo test`가 있으므로 TDD로 진행한다.

---

### Task 1: 백엔드 — `.bpmn`을 유효 파일로 인정 (`is_markdown_name` → `is_viewable_name`)

**Files:**
- Modify: `src-tauri/src/lib.rs:133-136` (TreeNode 독스트링), `:155-158`
  (`is_markdown_name` 정의), `:164-172` (`scan_dir` 독스트링), `:209-215`
  (`scan_dir_inner` 내부 호출부 + 주석), `:335-340` (`prune_deep` 독스트링),
  `:341-343` (`prune_deep` 내부 주석)
- Test: `src-tauri/src/lib.rs` 안의 `mod tests` (파일 하단, 1052행 부근)

**Interfaces:**
- Consumes: 없음 (독립 변경, 기존 `TreeNode`/`ScanDirResult`/`DeepScanResult` 타입 그대로)
- Produces: `is_viewable_name(name: &str) -> bool` — 이후 어떤 코드도 `is_markdown_name`을
  참조하지 않는다. 프론트의 `TreeNode.path`에 `.bpmn` 파일도 나타난다는 계약을 제공한다
  (Task 2가 이 계약을 소비한다).

현재 코드 (`src-tauri/src/lib.rs:155-158`):

```rust
fn is_markdown_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}
```

호출부 (`src-tauri/src/lib.rs:209-215`, `scan_dir_inner` 내부):

```rust
        // Skip non-collectible entries (non-markdown files) BEFORE the cap
        // check: only directories and markdown files count. Otherwise a
        // trailing dotfile/`.txt` on an otherwise-complete listing would flip
        // `truncated`.
        if !is_dir && !is_markdown_name(&name) {
            continue;
        }
```

기존 테스트 헬퍼(`src-tauri/src/lib.rs:1052-1065`, 이미 존재 — 참고용):

```rust
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
```

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/lib.rs`의 `scan_dir_filters_files_keeps_subdirs_and_sorts` 테스트
바로 다음(1099행 부근)에 추가:

```rust
    #[test]
    fn scan_dir_includes_bpmn_alongside_markdown() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("note.md"));
        touch(&t.path().join("diagram.bpmn"));
        touch(&t.path().join("skip.txt"));
        let res = scan(t.path());
        let names: Vec<_> = res.children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["diagram.bpmn", "note.md"]); // 이름순, .txt는 제외
    }
```

`scan_dir_deep_lists_subtree_bfs_and_prunes_mdless_dirs` 테스트 바로 다음
(1201행 부근)에 추가:

```rust
    #[test]
    fn scan_dir_deep_keeps_bpmn_only_dir() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("root.md"));
        fs::create_dir(t.path().join("flows")).unwrap();
        touch(&t.path().join("flows/order.bpmn")); // md는 없지만 bpmn이 있어 더 이상 prune 안 됨
        let res = scan_deep(t.path());
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
        assert_eq!(paths, vec!["", "flows"]);
        let flows_names: Vec<_> = res.dirs[1].children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(flows_names, vec!["order.bpmn"]);
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd src-tauri && cargo test scan_dir_includes_bpmn_alongside_markdown scan_dir_deep_keeps_bpmn_only_dir -- --nocapture`

Expected: 두 테스트 모두 FAIL —
`scan_dir_includes_bpmn_alongside_markdown`은 `names`에 `"diagram.bpmn"`이 없어
`assert_eq!` 실패, `scan_dir_deep_keeps_bpmn_only_dir`는 `flows`가 prune되어
`paths`가 `[""]`뿐이라 실패.

- [ ] **Step 3: 최소 구현 — 함수 이름 변경·확장 + 호출부 + 독스트링 갱신**

`src-tauri/src/lib.rs:133-136`, TreeNode 독스트링:

```rust
/// A node in the lazy project file tree (`scan_dir`). Files are markdown or
/// BPMN (see `is_viewable_name`); directories always appear (their children
/// are fetched lazily, one level at a time, so a directory shows up before we
/// know whether any viewable file lives below it).
```

`src-tauri/src/lib.rs:155-158`, 함수 이름 변경 + `.bpmn` 추가:

```rust
fn is_viewable_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".bpmn")
}
```

`src-tauri/src/lib.rs:164-172`, `scan_dir` 독스트링 (「markdown」 표현을 실제 동작에
맞게 갱신):

```rust
/// List ONE level of `dir` for the lazy project tree: viewable files (`.md`,
/// `.markdown`, `.bpmn`) plus all subdirectories (no recursive pruning — that
/// would defeat lazy loading, so directories with no viewable file below them
/// do appear). Errs when `dir` is not a directory — the frontend drop handler
/// relies on this to tell folders from stray non-viewable files. Dotfiles,
/// `node_modules` and symlinks are skipped; symlinks are never followed.
/// Directories sort before files, each name-sorted case-insensitively. Async +
/// blocking thread: refreshes can fan this out over many expanded dirs at
/// once, and a slow volume must not stall the main thread.
```

`src-tauri/src/lib.rs:209-215`, 호출부 + 주석:

```rust
        // Skip non-collectible entries (non-viewable files) BEFORE the cap
        // check: only directories and viewable files (md/bpmn) count.
        // Otherwise a trailing dotfile/`.txt` on an otherwise-complete listing
        // would flip `truncated`.
        if !is_dir && !is_viewable_name(&name) {
            continue;
        }
```

`src-tauri/src/lib.rs:335-340`, `prune_deep` 독스트링:

```rust
/// Drop directories whose scanned subtree contains no viewable file (md or
/// bpmn). Computed bottom-up over the BFS list (children come after parents,
/// so a reverse pass sees every child's verdict first). A child dir that was
/// never scanned (beyond the truncation frontier or vanished mid-scan) is
/// UNKNOWN and kept — pruning must never hide a directory it didn't examine.
/// The root (first entry) is always kept: the user asked about that folder
/// explicitly.
```

`src-tauri/src/lib.rs:341-343`, 내부 주석:

```rust
    // path → "subtree has a viewable file". Files in `children` are already
    // viewable-only (md/bpmn).
```

- [ ] **Step 4: 테스트 통과 확인 + 회귀 확인**

Run: `cd src-tauri && cargo test`

Expected: 신규 2개 포함 전체 PASS. 기존 `scan_dir_filters_files_keeps_subdirs_and_sorts`,
`scan_dir_deep_lists_subtree_bfs_and_prunes_mdless_dirs` 등도 여전히 PASS (동작 변화 없음
— `.md` 전용 fixture는 `.bpmn`이 섞이지 않는 한 결과가 그대로).

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat: 프로젝트 트리가 .bpmn 파일도 인식하도록 확장

is_markdown_name을 is_viewable_name으로 이름 변경하고 .bpmn을 추가로
인정하게 해, scan_dir(lazy)와 scan_dir_deep(prune) 양쪽에서 bpmn 파일이
md와 동급으로 수집/유지되게 한다.
EOF
)"
```

---

### Task 2: 프론트엔드 — BPMN 아이콘 + 외부 프로그램 열기(트리 클릭 + 드래그&드롭)

**Files:**
- Modify: `src/main.ts:1250-1252` (아이콘 상수), `:1647-1652` (트리 파일 행),
  `:1513` (주석), `:1560`, `:1641` (빈 폴더 안내 문구), `:2085-2097` (드래그&드롭)

**Interfaces:**
- Consumes: Task 1의 계약 — `scan_dir`/`scan_dir_deep`가 반환하는 `TreeNode.path`에
  `.bpmn` 파일이 나타남 (Rust 쪽이 이미 그렇게 보장). 기존 `openPath(path: string):
  Promise<void>` (import 이미 존재, `src/main.ts:4`), `toast(msg: string): void`
  (`src/main.ts:53`), `openTabFromPath(path: string): Promise<void>` (`src/main.ts:1228`).
- Produces: 트리에서 `.bpmn` 행을 누르거나 `.bpmn` 파일 하나를 창에 드롭하면 탭이 생기지
  않고 OS 기본 프로그램이 실행됨 — 이후 태스크(버전 릴리스)가 수동 검증 시 관찰하는 동작.

현재 코드 (`src/main.ts:1250-1252`):

```typescript
const SVG_FILE =
  '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M3.75 1.75h5.5l3 3v9a.75.75 0 0 1-.75.75h-7.75a.75.75 0 0 1-.75-.75v-11.25a.75.75 0 0 1 .75-.75z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.25 1.75v3h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5 11.2V8l1.6 1.9L8.2 8v3.2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
```

현재 코드 (`src/main.ts:1647-1652`, `buildTreeChildren` 파일 분기):

```typescript
    } else {
      icon.innerHTML = SVG_FILE;
      row.addEventListener('click', () => {
        void openTabFromPath(n.path);
      });
    }
```

현재 코드 (`src/main.ts:2085-2097`, 드래그&드롭):

```typescript
  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'drop') {
      for (const p of event.payload.paths) {
        if (/\.(md|markdown)$/i.test(p)) {
          void openTabFromPath(p);
        } else {
          // md가 아니면 폴더로 시도 — scan_dir가 디렉토리 판별.
          // 파일 등 실패 케이스는 조용히 무시(silent).
          void openProject(p, true);
        }
      }
    }
  });
```

- [ ] **Step 1: BPMN 아이콘 상수 추가**

`src/main.ts:1252` (`SVG_FILE` 정의 바로 다음)에 추가:

```typescript
// 원(시작 이벤트)-사각형(태스크)-원(종료 이벤트) — BPMN 표기법을 참고한 파일 아이콘.
// 폴더/파일 아이콘과 동일하게 currentColor 선화 스타일로 통일.
const SVG_BPMN =
  '<svg width="15" height="15" viewBox="0 0 16 16"><circle cx="2.6" cy="8" r="1.5" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M4.1 8h2.3" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="6.6" y="5.7" width="4.3" height="4.6" rx="0.9" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M10.9 8h2.1" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="13.5" cy="8" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
```

- [ ] **Step 2: 트리 파일 행 — bpmn이면 아이콘/클릭 동작 분기**

`src/main.ts:1647-1652`을 다음으로 교체:

```typescript
    } else if (/\.bpmn$/i.test(n.path)) {
      icon.innerHTML = SVG_BPMN;
      row.addEventListener('click', () => {
        openPath(n.path).catch((err) => {
          console.error('openPath failed:', n.path, err);
          toast(`열기 실패: ${err}`);
        });
      });
    } else {
      icon.innerHTML = SVG_FILE;
      row.addEventListener('click', () => {
        void openTabFromPath(n.path);
      });
    }
```

- [ ] **Step 3: 드래그&드롭 — 단일 bpmn 파일도 외부로 열기**

`src/main.ts:2085-2097`을 다음으로 교체:

```typescript
  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'drop') {
      for (const p of event.payload.paths) {
        if (/\.(md|markdown)$/i.test(p)) {
          void openTabFromPath(p);
        } else if (/\.bpmn$/i.test(p)) {
          openPath(p).catch((err) => {
            console.error('openPath failed:', p, err);
            toast(`열기 실패: ${err}`);
          });
        } else {
          // md/bpmn이 아니면 폴더로 시도 — scan_dir가 디렉토리 판별.
          // 파일 등 실패 케이스는 조용히 무시(silent).
          void openProject(p, true);
        }
      }
    }
  });
```

- [ ] **Step 4: 빈 폴더 안내 문구 갱신**

`src/main.ts:1560`과 `:1641`의 `'md 파일 없음'`을 각각 `'md/bpmn 파일 없음'`으로 교체
(두 곳 모두 동일 문자열 리터럴, 개별 위치에서 수정). `src/main.ts:1513` 주석의
`"md 파일 없음"` 인용도 `"md/bpmn 파일 없음"`으로 맞춰 갱신:

```typescript
  // 클릭한 폴더는 무조건 펼친다 — 유효 파일이 없어도 "md/bpmn 파일 없음"으로 응답이 보이게.
```

- [ ] **Step 5: 타입체크 통과 확인**

Run: `pnpm build`

Expected: `tsc` 에러 없이 통과, `vite build` 성공 (기존 빌드와 동일한 출력 — 신규
청크/의존성 없음).

- [ ] **Step 6: 수동 시나리오 확인 (`pnpm dev` + Chrome/Playwright, mocked Tauri internals)**

Run: `pnpm dev` (vite dev server, 기존 프로젝트 컨벤션대로 `__TAURI_INTERNALS__` 모킹한
Playwright/Chrome MCP로 구동)

확인 항목:
1. `.md`와 `.bpmn`이 섞인 폴더를 프로젝트로 열기 → 트리에 두 종류 다 보이는지, `.bpmn`
   행 아이콘이 `SVG_BPMN`(원-사각형-원 글리프)으로 `.md` 행과 시각적으로 구분되는지.
2. `.bpmn`만 있는 하위 폴더가 트리에서 더 이상 숨겨지지 않는지.
3. `.bpmn` 행 클릭 → 탭이 새로 생기지 않고(탭바 변화 없음) `openPath` 호출 로그가
   콘솔에 찍히는지 (mocked 환경이라 실제 외부 앱 실행 결과는 콘솔 로그로 대신 확인).
4. 창에 `.bpmn` 파일 하나만 드래그&드롭 → 탭이 생기지 않고 동일하게 `openPath` 경로를
   타는지 (기존처럼 조용히 무시되지 않는지).
5. 빈 폴더(둘 다 없음)를 펼쳤을 때 "md/bpmn 파일 없음" 문구가 보이는지.

Expected: 위 5개 항목 모두 관찰한 그대로 통과. 실패 시 해당 스텝의 코드로 돌아가 원인
파악 후 재확인.

- [ ] **Step 7: 커밋**

```bash
git add src/main.ts
git commit -m "$(cat <<'EOF'
feat: 트리의 .bpmn 파일은 OS 기본 프로그램으로 열기

전용 아이콘(원-사각형-원 BPMN 모티프)을 추가하고, 트리 클릭과 창
드래그&드롭 양쪽에서 .bpmn 파일은 탭으로 열지 않고 openPath로
OS 기본 프로그램(예: Camunda Modeler)에 위임한다.
EOF
)"
```

---

### Task 3: 버전 릴리스 (0.1.12) + 빌드 + 재설치 검증

**Files:**
- Modify (자동): `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
  (모두 `scripts/bump-version.mjs`가 갱신)

**Interfaces:**
- Consumes: Task 1·2가 끝난 `main` 브랜치 상태 (커밋 완료, 테스트 통과).
- Produces: 태그 `v0.1.12`, `/Applications/mdview.app` 재설치본 (0.1.12).

- [ ] **Step 1: 버전 bump + 태그**

Run: `pnpm bump 0.1.12 --tag`

Expected: `package.json`/`src-tauri/tauri.conf.json`/`src-tauri/Cargo.toml`의 버전이
`0.1.12`로 갱신되고, 세 파일이 커밋되고, 태그 `v0.1.12`가 생성·push됨 (이 저장소는
태그 push가 릴리스 워크플로우를 트리거하는 컨벤션 — `scripts/bump-version.mjs` 참고).

- [ ] **Step 2: macOS 릴리스 빌드**

Run: `npx tauri build 2>&1`

Expected: `Finished 2 bundles at: .../target/release/bundle/macos/mdview.app`,
`.../bundle/dmg/mdview_0.1.12_aarch64.dmg` — 빌드 실패(0이 아닌 종료 코드) 없음.
(주의: 절대 `tail`로 파이프하지 않는다 — 종료 코드가 가려짐.)

- [ ] **Step 3: 기존 설치본 교체**

Run:

```bash
osascript -e 'quit app "mdview"' 2>/dev/null
pkill -x mdview 2>/dev/null
sleep 1
rm -rf "/Applications/mdview.app"
cp -R "/Users/jji/project/mdview/src-tauri/target/release/bundle/macos/mdview.app" "/Applications/mdview.app"
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "/Applications/mdview.app/Contents/Info.plist"
```

Expected: 마지막 줄 출력이 `0.1.12`.

- [ ] **Step 4: 실제 앱에서 최종 스모크 확인**

`/Applications/mdview.app`을 실행해 Task 2 Step 6의 5개 시나리오를 실제 앱(모킹 없이)
에서 재확인 — 특히 3번(`.bpmn` 클릭 시 실제로 OS 기본 프로그램이 뜨는지, mocked 환경과
달리 이번엔 콘솔 로그가 아니라 실제 앱 실행으로 확인)과 4번(드래그&드롭)을 눈으로 검증.

Expected: `.bpmn` 클릭/드롭 시 mdview 탭이 아니라 OS에 연결된 프로그램(설치돼 있다면
Camunda Modeler, 없다면 OS가 "연결 프로그램 선택" 안내를 띄우는 것도 정상 — mdview가
직접 열지만 않으면 됨)이 실행됨.

- [ ] **Step 5: 완료 보고**

별도 커밋 없음(Step 1의 bump 커밋이 이미 태그와 함께 push됨). 사용자에게 버전, 빌드
결과, 스모크 확인 결과를 보고.

---

## Self-Review

- **Spec coverage:** 확정 요구사항 표의 7개 항목 모두 Task 1(트리 노출)/Task 2(아이콘,
  클릭 라우팅, 드래그드롭, 문구)/Global Constraints(패키징 무변경, 탭 무변경)로 매핑됨.
  "파일 연결/PDF/소스뷰/검색 변경 없음" 항목은 애초에 코드를 건드리지 않는 것이 곧 구현이라
  별도 태스크 없음 — Global Constraints에 명시.
- **Placeholder scan:** TBD/TODO/"적절히 처리" 없음. 모든 스텝에 실제 코드·명령·기대 출력
  명시.
- **Type consistency:** `openPath(path: string): Promise<void>`, `toast(msg: string): void`,
  `is_viewable_name(name: &str) -> bool` — Task 1/2 전체에서 동일하게 사용.

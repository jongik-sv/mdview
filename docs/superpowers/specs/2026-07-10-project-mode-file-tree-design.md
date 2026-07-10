# 프로젝트 모드 (파일트리 사이드바) — 설계

- 날짜: 2026-07-10
- 대상 버전: 0.1.4
- 요구 출처: idea.md 수정요청 1번 — "mdview project 모드(파일트리보이게) 지원(md 파일만 보이도록)"

## 목표

폴더를 열면 좌측 사이드바에 파일트리를 표시한다. `.md`/`.markdown` 파일만 보이고,
클릭하면 기존 탭 시스템으로 열린다. 폴더를 열지 않으면 지금과 완전히 동일한
단일 뷰어 UX를 유지한다.

## 확정 요구사항

| 항목 | 결정 |
|---|---|
| 진입 | 툴바 "폴더 열기" 버튼 + 폴더 드래그&드롭 |
| 파일 필터 | `.md`/`.markdown`만 표시 |
| 폴더 필터 | md를 (하위 포함) 가진 폴더만 표시. 닷파일·`node_modules` 제외 |
| 클릭 | 새 탭으로 열기 (이미 열려 있으면 해당 탭 활성화) |
| 트리 갱신 | 파일 추가/삭제/이름변경 시 자동 재스캔 |
| 상태 기억 | 마지막 프로젝트 폴더를 localStorage에 저장, 재실행 시 복원 |

## 아키텍처 (접근 A: Rust 전체 스캔)

파일시스템 접근은 전부 Rust에 둔다(기존 원칙 — fs 플러그인/capability 스코핑 회피).
"md 있는 폴더만" 필터는 하위 트리 전체를 알아야 하므로 lazy 로드가 아닌
전체 스캔 1회로 처리한다.

### Rust (src-tauri/src/lib.rs)

- `scan_tree(root: String) -> Result<ScanResult, String>`
  - `ScanResult { tree: TreeNode, truncated: bool }`,
    `TreeNode { name, path, is_dir, children: Vec<TreeNode> }` (모두 Serialize)
  - 재귀 스캔. 파일은 `.md`/`.markdown`(대소문자 무시)만 수집.
  - 가지치기: 하위에 md가 하나도 없는 폴더는 결과에서 제거.
  - 제외: 이름이 `.`으로 시작하는 항목, `node_modules`.
  - 심볼릭 링크는 따라가지 않는다 (순환 방지).
  - 정렬: 폴더 먼저, 그 다음 이름순.
  - 안전 상한: 엔트리 10,000개 초과 시 스캔 중단하고 잘린 트리 + truncated 플래그 반환.
  - `root`가 디렉토리가 아니면 Err → 프론트 드롭 핸들러가 파일/폴더 판별에 활용.
- `watch_dir(root)` / `unwatch_dir(root)`
  - 기존 notify 디바운서 인프라 재활용. 재귀(RecursiveMode::Recursive) watch,
    500ms 디바운스, 변경 시 `tree-changed` 이벤트 emit (경로 무관 — 재스캔 트리거 용도).
  - 기존 파일 단위 watcher(`watch_file`)와 별도 맵으로 관리. 새 프로젝트를 열면
    이전 watch를 교체한다.

### 프론트 (src/main.ts, index.html, styles.css)

- `#sidebar`: 좌측 240px 고정. 헤더(폴더명 + 닫기 ×) + 트리 목록.
  프로젝트가 없으면 `hidden` — 기존 레이아웃 그대로.
- 툴바에 "폴더 열기" 버튼 추가 (`open({ directory: true })`).
- 드래그&드롭: 기존 `onDragDropEvent`에서 md 확장자가 아니면 `scan_tree` 시도 →
  성공하면 프로젝트로 오픈, 실패(파일 등)하면 무시.
- `openProject(root)`: scan → 트리 렌더 → `watch_dir` → `localStorage['mdview-project']` 저장.
- `closeProject()`: `unwatch_dir` → 사이드바 숨김 → localStorage 제거. 열린 탭 유지.
- `tree-changed` 수신 → `scan_tree` 재실행 → 재렌더. 펼침 상태는 `Set<path>`로 보존.
- 시작 시 localStorage에 프로젝트가 있으면 복원. 폴더가 사라졌으면 조용히 제거.

## 인터랙션

- 파일 클릭 → 기존 `openTabFromPath` 호출 (동작 변화 없음).
- 폴더 클릭 → 접기/펼치기. 초기 상태: 루트 직속만 펼침.
- 활성 탭의 파일을 트리에서 하이라이트, 탭 전환 시 동기화.

## 엣지 케이스

- 새 폴더를 열면 기존 프로젝트를 교체한다 (multi-root 없음).
- md가 하나도 없는 폴더: 빈 트리 + "md 파일 없음" 안내 문구.
- Chrome dev harness (`isTauri === false`): 폴더 열기 버튼·사이드바 숨김.
- 스캔 상한 초과: 잘린 트리 표시 + toast 안내.

## 테스트

- Rust 단위 테스트: tempdir 픽스처로 `scan_tree` 검증 —
  확장자 필터, 빈 폴더 가지치기, 닷파일/`node_modules` 제외, 정렬, 비-디렉토리 Err.
- 프론트: `tauri dev`로 실제 폴더 수동 검증
  (열기/드롭/클릭/자동갱신/복원/닫기). 기존 프로젝트에 프론트 자동화 없음 — 동일 유지.

## 릴리스

- 완료 후 버전 0.1.4로 bump (`tauri.conf.json`), macOS + Windows(cargo-xwin) 빌드.

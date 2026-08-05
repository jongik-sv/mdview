# 세션 복원 — 탭 + 창 크기/위치

## 문제

재시작 시 마지막 프로젝트 폴더만 복원되고, 열려 있던 탭들은 사라진다.
창도 기본 크기로 열려 종료 시점의 크기·위치·모니터를 잃는다.

## 결정

- 탭 세션: localStorage JSON (`mdview-session`). 기존 PROJECT_KEY·RECENTS와
  같은 패턴, Rust 변경 없음.
- 창 상태: 공식 `tauri-plugin-window-state` 플러그인. 종료 시 크기·위치·
  모니터 자동 저장, 시작 시 복원. JS 코드 불필요.
- .md 더블클릭 실행 시에도 세션 복원 + 해당 파일을 탭으로 얹어 활성화 (승인됨).

## 설계

### 탭 세션 저장

- 형식: `{ paths: string[], active: string | null, scroll: Record<string, number> }`
- 저장 훅: `renderTabBar()` 끝에서 `saveSession()` — 탭 추가/닫기/순서변경/
  활성화 전부 이 함수를 거친다. 활성 탭 scroll은 window scroll 이벤트
  debounce(500ms)로 갱신. 종료 이벤트(beforeunload)에 의존하지 않는다.
- 복원 중 저장 방지: 복원 루프 동안 플래그로 saveSession 무시.

### 복원 (startTauri)

1. 세션의 각 path: `read_file` → `_addTab` → mtime → `watch_file`.
   실패(삭제된 파일)는 조용히 스킵. pushRecent 하지 않는다(복원은 기록 아님).
2. scroll 값을 tab.scrollY에 주입 → 저장된 active 활성화(renderActive가
   scrollY 복원).
3. `get_initial_file`(더블클릭/CLI)은 그 뒤에 열어 활성화.
4. 탭 0개면 기존 placeholder. 프로젝트 폴더 복원은 기존 코드 유지.

### 창 상태

- Cargo: `tauri-plugin-window-state = "2"`,
  lib.rs: `.plugin(tauri_plugin_window_state::Builder::default().build())`
- 저장/복원 전부 플러그인 자동. 모니터 사라짐 등 엣지도 플러그인이 처리.

### 엣지

- 세션 JSON 파싱 실패 → 무시, 빈 시작.
- 브라우저 dev 하니스(비 Tauri): 복원 없음(sample.md 유지), 저장 훅은
  공용 경로라 동작 — Playwright로 저장 검증 가능.

## 검증

- Playwright(dev 하니스): 탭 조작 시 `mdview-session` 키 갱신 확인.
- 실앱: cargo/tsc 빌드 후 수동 — 탭 여러 개 + 창 이동/리사이즈 → 종료 →
  재실행 → 탭·활성·창 geometry 복원 확인.

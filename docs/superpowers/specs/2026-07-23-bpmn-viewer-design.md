# BPMN 파일 트리 노출 + 외부 열기 — 설계

- 날짜: 2026-07-23
- 대상 버전: 0.1.12
- 요구 출처: 사용자 요청. 초안은 bpmn-js `NavigatedViewer`로 앱 내부에 다이어그램을
  렌더링하는 것이었으나, 논의 중 "Camunda Modeler가 빠르니 안 해도 된다"로 방향 전환.
  최종 요구는 (1) 프로젝트 트리에 `.bpmn` 파일 노출, (2) 클릭 시 OS 기본 프로그램으로
  열기, (3) 트리 아이콘은 bpmn.io 표기법을 참고한 전용 아이콘.
  **이 문서는 이전 버전(NavigatedViewer 임베드안)을 완전히 대체한다.**

## 목표

mdview는 `.bpmn` 파일을 자체 렌더링하지 않는다. 대신 프로젝트 모드 파일트리에서
`.md`와 동급으로 보여주고, 클릭(또는 드래그&드롭)하면 OS에 등록된 기본 프로그램
(예: Camunda Modeler)으로 열어준다.

## 확정 요구사항

| 항목 | 결정 |
|---|---|
| 앱 내부 렌더링 | 하지 않음 — bpmn-js 의존성 추가 없음 |
| 프로젝트 트리 노출 | `.bpmn` 파일도 `.md`와 동급으로 트리에 표시 (하위에 bpmn만 있는 폴더도 이제 표시됨) |
| 트리 클릭 동작 | 탭으로 열지 않고 OS 기본 프로그램으로 실행 (`openPath`, 기존 문서 내 비-md 링크 클릭과 동일 메커니즘) |
| 창에 `.bpmn` 파일 단일 드래그&드롭 | 트리 클릭과 동일하게 OS 기본 프로그램으로 열기 (현재는 조용히 무시되던 경로) |
| 트리 아이콘 | 기존 파일/폴더 아이콘과 통일된 `currentColor` 선화 스타일. BPMN 표기법(원-사각형-원: 시작 이벤트-태스크-종료 이벤트) 모티프를 차용한 전용 글리프. bpmn.io 공식 컬러 로고(원+'B') 그대로 쓰지 않음 — 아이콘셋 시각 언어 통일 우선 |
| 파일 연결(더블클릭)/PDF 내보내기/소스뷰/문서 내 검색 | 변경 없음 — `.bpmn`은 애초에 탭으로 열리지 않으므로 해당 없음 |
| `tauri.conf.json` / `package.json` | 변경 없음 — mdview를 bpmn 기본 앱으로 등록하지 않음, 신규 의존성 없음 |

## 아키텍처

기존 markdown-only 게이트를 확장하는 것 외에는 새 인프라가 필요 없다. `.bpmn`은
"탭으로 열리는 문서"가 아니라 "트리에 보이지만 외부로 위임되는 항목"이라, 탭 시스템·
워처·최근파일·소스뷰·PDF 파이프라인 전부 손대지 않는다.

### 백엔드 (src-tauri/src/lib.rs)

- `is_markdown_name` → `is_viewable_name`으로 이름 변경, `.bpmn` 확장자도 인정하도록 확장.
  - 사용처 2곳: `scan_dir`의 파일 수집 게이트, 하위 트리 pruning("유효 파일이 하나도
    없는 폴더는 제거") 판단.
  - 주석("Files are markdown-only")도 실제 동작에 맞게 갱신.
- `read_file`/`watch_file`/`get_initial_file`: 확장자 무관 동작이라 변경 없음.

### 프론트 (src/main.ts)

- **트리 아이콘**: `SVG_FILE` 옆에 `SVG_BPMN` 상수 추가 (16x16 viewBox, `currentColor`
  stroke, 원-사각형-원 모티프). `buildTreeChildren`의 파일 분기에서 `n.path`가
  `.bpmn`(대소문자 무시)로 끝나면 `SVG_BPMN`, 아니면 기존 `SVG_FILE`.
- **트리 클릭 분기**: 같은 분기에서 `.bpmn`이면 `openTabFromPath` 대신
  `openPath(n.path)` 호출(이미 `@tauri-apps/plugin-opener`에서 import된 함수 —
  문서 내 비-md 링크 클릭 시 쓰는 것과 동일 패턴, 실패 시 `console.error` + `toast`).
- **드래그&드롭**: `onDragDropEvent` 핸들러의 판별 순서를 확장 —
  `.md`/`.markdown` → 탭으로 열기, `.bpmn` → `openPath`, 그 외 → 기존처럼
  `openProject` 시도(폴더 판별, 실패 시 무시).
- **빈 폴더 안내 문구**: "md 파일 없음" → "md/bpmn 파일 없음" (2곳: 즉시 펼침 시
  lazy 결과 없음, expanded 상태에서 children 없음).
- **변경 없음**: 탭 placeholder 문구("마크다운 파일을 열어주세요"), 열기 다이얼로그
  필터, 소스보기, PDF 버튼, 문서 내 검색 — `.bpmn`은 탭 시스템에 진입하지 않으므로
  해당 코드 경로를 타지 않는다.

## 에러 처리

`openPath` 실패(연결된 기본 프로그램 없음 등)는 기존 비-md 링크 클릭 케이스와 동일하게
`console.error` 로그 + `toast()` 안내로 처리. 앱 상태에 영향 없음(탭/트리 변화 없음).

## 테스트

- Rust 단위 테스트: 기존 `scan_dir` 관련 테스트 fixture에 `.bpmn` 파일 케이스 추가
  — md와 함께 수집되는지, bpmn만 있는 폴더가 더 이상 제거되지 않는지, 무관 확장자
  (`.txt` 등)는 여전히 제외되는지 확인. 기존 md 전용 테스트는 이름/동작 그대로 유지.
- 프론트: 자동화 인프라 없음(기존 컨벤션 동일) — `pnpm dev` + mocked-Tauri Playwright
  수동 확인:
  - `.bpmn`만 있는 폴더가 트리에 나타나는지
  - `.bpmn` 행 아이콘이 `SVG_BPMN`인지 (md 파일과 구분되는지)
  - `.bpmn` 클릭 → 탭이 생기지 않고 OS 기본 프로그램이 실행되는지
  - `.bpmn` 파일 하나만 드래그&드롭 → 동일하게 외부로 열리는지 (조용히 무시되지 않는지)

## 릴리스

- 구현 완료 후 `pnpm bump 0.1.12 --tag`, macOS 빌드 + `/Applications` 재설치 검증.

# BPMN 뷰어 지원 — 설계

- 날짜: 2026-07-23
- 대상 버전: 0.2.0
- 요구 출처: 사용자 요청 — bpmn.io 뷰어(읽기 전용) 추가, 파일 대상은 `.md`와 `.bpmn`

## 목표

`.bpmn` 파일을 `.md` 파일과 동일한 방식(탭/트리/드래그드롭/최근파일/워처)으로 열되,
렌더링만 bpmn-js `NavigatedViewer`로 전환해 다이어그램을 보여준다. 편집 기능(Modeler)은
포함하지 않는다 — 순수 읽기 전용 뷰어.

## 확정 요구사항

| 항목 | 결정 |
|---|---|
| 라이브러리 | `bpmn-js` 중 `NavigatedViewer`만 사용 (Modeler 제외) — 줌/팬 지원, 191KB min |
| 파일 대상 | `.bpmn` 확장자. 탭/프로젝트 트리/드래그드롭/열기 다이얼로그/파일연결(더블클릭) 모두 md와 동급 지원 |
| 다이어그램 배경 | 다크모드 무관 흰 배경 카드 고정 (bpmn.io 기본 스타일 그대로, 오버라이드 없음) |
| 소스뷰 | 지원 — 기존 소스보기 토글에서 `.bpmn` 탭은 Monaco `xml` 언어모드로 원본 표시 |
| 문서 내 검색(Ctrl+F) | `.bpmn` 탭에서 비활성 (텍스트 노드 없음) |
| PDF 내보내기 | 이번 버전 범위 제외 — `.bpmn` 탭에서 버튼 비활성화 (최근 markdown PDF 4건 버그 수정 회귀 위험 회피, 별도 과제로) |
| 잘못된 BPMN XML | 전체 앱을 깨뜨리지 않고 콘텐츠 영역에 에러 문구로 표시 |

## 아키텍처

기존 탭 인프라(읽기/워처/최근파일/프로젝트 트리)는 파일 확장자와 무관하게 그대로
재사용한다. `tab.content`는 지금처럼 원본 텍스트(BPMN이면 XML)를 그대로 보관하고,
**렌더링 단계에서만** 확장자로 분기한다.

### 프론트 (src/)

- **`src/bpmn-view.ts` (신규)**
  - `renderBpmn(container: HTMLElement, xml: string): Promise<{ ok: boolean; error?: string }>`
  - 내부에서 `NavigatedViewer` 인스턴스를 컨테이너에 붙이고 `importXML(xml)` 호출.
  - 성공 시 `viewer.get('canvas').zoom('fit-viewport')`로 전체 다이어그램이 보이게 맞춘다.
  - 실패(reject) 시 컨테이너를 지우지 않고 `{ ok: false, error }`를 반환 — 호출부(main.ts)가
    에러 placeholder를 그린다.
  - 탭 전환/재렌더마다 이전 viewer 인스턴스를 `destroy()`하고 새로 생성 (mermaid처럼
    상태 없는 1회성 렌더가 아니라 DOM에 지속되는 인스턴스이므로 누수 방지 필수).
- **`src/main.ts`**
  - `renderActive()`: `activePath`가 `.bpmn`으로 끝나면 `renderMarkdown` 대신
    `renderBpmn` 경로 사용. 실패 시 "유효한 BPMN 파일이 아닙니다" + 원본 에러 메시지를
    placeholder로 표시.
  - 드래그드롭 판별 정규식: `/\.(md|markdown)$/i` → `/\.(md|markdown|bpmn)$/i`.
  - "+" 열기 다이얼로그: 필터에 `{ name: 'BPMN', extensions: ['bpmn'] }` 추가(마크다운
    필터와 별도 항목 — 다이얼로그에서 파일 종류 드롭다운으로 선택).
  - 소스보기 토글: 활성 탭 확장자로 Monaco 언어를 `markdown`/`xml`로 스위치.
  - PDF 버튼: 활성 탭이 `.bpmn`이면 `disabled`.
  - 문서 내 검색 진입점: 활성 탭이 `.bpmn`이면 검색 단축키/버튼을 PDF 버튼과 동일하게
    비활성화 (별도 안내 문구 없음).
  - 플레이스홀더 문구("마크다운 파일을 열어주세요")는 "마크다운 또는 BPMN 파일을
    열어주세요"로 갱신.

### 백엔드 (src-tauri/src/lib.rs)

- `is_markdown_name` → `is_viewable_name`으로 이름 변경 + 확장, `.bpmn`도 인정.
  프로젝트 트리 스캔(`scan_dir`)의 파일 수집 게이트로 그대로 재사용 — 폴더 가지치기
  로직("하위에 유효 파일이 없으면 제거")도 자동으로 md+bpmn 기준이 된다.
- `read_file` / `watch_file` / `get_initial_file`: 확장자 무관 동작이라 변경 없음.

### 패키징 (src-tauri/tauri.conf.json)

- `fileAssociations`에 bpmn 항목 추가. 공식 Apple BPMN UTI가 없으므로
  `exportedTypeDeclarations`로 커스텀 UTI(`com.jji.mdview.bpmn`, `conformsTo: public.xml`)를
  선언하고 `contentTypes`에 연결. Windows는 확장자 기반이라 별도 처리 불요.
- `package.json` dependencies에 `bpmn-js` 추가.

## 데이터 흐름

1. 사용자가 `.bpmn` 파일을 열기(다이얼로그/드래그/더블클릭/트리클릭) →
   기존 `openTabFromPath` → `read_file`(Rust) → 원본 XML 문자열을 `tab.content`에 저장.
2. `activate(path)` → `renderActive()` → 확장자 분기 → `renderBpmn(container, tab.content)`.
3. `watch_file`이 외부 변경 감지 → `reloadTab` → `tab.content` 갱신 → `renderActive()` 재호출
   (기존 markdown 리프레시와 동일 경로).

## 에러 처리

- `importXML` reject(문법 오류, BPMN 아닌 XML 등) → 앱 크래시 없이 콘텐츠 영역에
  "유효한 BPMN 파일이 아닙니다" + reject된 에러 메시지 원문을 보여준다.
  (katex `throwOnError:false`와 동일한 원칙 — 부분 실패가 전체를 깨뜨리지 않음)

## 테스트

- Rust 단위 테스트: 기존 `scan_dir`/파일명 게이트 테스트에 `.bpmn` 케이스 추가
  (md만 있던 fixture에 `.bpmn` 파일 섞어 수집/가지치기 확인). 기존 md 테스트는 그대로 유지.
- 프론트: 자동화 테스트 인프라 없음(기존 프로젝트 컨벤션과 동일) — `pnpm dev` +
  mocked-Tauri Playwright 수동 시나리오로 검증:
  - 샘플 `.bpmn` 파일 열기 → 다이어그램 렌더 확인
  - 줌/팬 동작 확인
  - 소스보기 토글 → XML 원문 확인
  - 손상된 XML 파일 열기 → 에러 placeholder 확인 (앱 비정상 종료 없음)
  - 탭 전환(md ↔ bpmn) 반복 → 이전 viewer 인스턴스 정리(메모리 누수) 확인

## 릴리스

- 구현 완료 후 `pnpm bump minor --tag` (0.1.11 → 0.2.0), macOS 빌드 + 재설치 검증,
  Windows(cargo-xwin) 크로스빌드.

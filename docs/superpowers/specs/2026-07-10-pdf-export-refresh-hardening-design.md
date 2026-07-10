# PDF 출력 + 리프레시 보강 설계

날짜: 2026-07-10
상태: 승인됨 (사용자 확인)

## 배경

- idea.md 요청: PDF 출력, "소스가 변경되어도 리프레시 안됨" 보고 (김정진).
- 조사 결과: 자동 리프레시는 초기 커밋부터 구현돼 있음 (notify-debouncer 부모 디렉토리 감시
  → `file-changed` 이벤트 → `reloadTab`). macOS에서 append / atomic-rename / 삭제-재생성
  3종 시나리오 실증 테스트 전부 통과.
- 재현 불가 → 원인 후보: Windows 환경, 네트워크 드라이브(FSEvents/RDCW 이벤트 미발생),
  atomic save 순간 `read_file` 실패 시 미처리(현 코드는 promise reject 무시, 재시도 없음).
- 결론: 감시 이벤트가 안 오는 환경 대비 **폴링 폴백** + **수동 새로고침** 추가.

## 1. PDF 직접 저장

사용자 선택: 시스템 인쇄 다이얼로그가 아닌 **바로 .pdf 파일 저장**.

### 흐름

1. 툴바 PDF 버튼 또는 Cmd/Ctrl+P
2. 저장 다이얼로그 (tauri-plugin-dialog `save()`, 기본 파일명 = `<문서명>.pdf`,
   기본 위치 = 원본 .md 옆) — 취소 시 조용히 중단
3. (다크 모드였다면) mermaid 라이트 테마로 재렌더
4. Rust `export_pdf(dest: String)` invoke
5. 완료/실패 toast, mermaid 원복

### 플랫폼 구현

wry가 print-to-PDF를 노출하지 않으므로 `webview.with_webview()`로 네이티브 핸들 접근:

- **macOS**: `WKWebView.printOperation(with: NSPrintInfo)` —
  `showsPrintPanel=false`, `jobDisposition=.save`, `NSPrintJobSavingURL=dest`.
  다이얼로그 없이 페이지네이션된 PDF. crate: objc2, objc2-web-kit, objc2-app-kit
  (wry 의존성과 동일 계열). 메인 스레드에서 실행 (`with_webview` 보장).
- **Windows**: `ICoreWebView2_7::PrintToPdf(dest, settings, handler)` —
  crate: webview2-com, windows. 비동기 완료 → `pdf-exported` 이벤트로 프론트 통지.
- **Linux**: 이번 릴리스 미지원 — `Err("PDF export not supported on Linux yet")`.
  추후 webkit2gtk PrintOperation.

### 출력 품질

- `@media print` CSS:
  - 툴바 / 탭바 / 검색바 / 소스뷰 숨김, `#content`만 전체 폭
  - PDF는 항상 라이트: 흰 배경, github-markdown-css 라이트 변수 강제
  - `pre`, `.mermaid`, 표: `break-inside: avoid`
  - 적절한 페이지 여백
- 다크 모드 상태의 mermaid SVG는 다크 색으로 그려져 있으므로 export 전
  `renderAllMermaid(blocks, 'default')` → export → 현재 테마로 재렌더.

### 에러 처리

- 쓰기 실패(권한/경로): Rust에서 `Err(String)` → toast로 사유 표시
- 활성 탭 없음: 버튼 비활성 또는 no-op

## 2. 리프레시 보강 (기존 감시 유지 + 폴링 폴백 + 수동)

### Rust

- 신규 커맨드 `file_mtime(path: String) -> Result<u64, String>` (epoch millis).
- 기존 watch_file / unwatch_file / 디바운서 로직 변경 없음.

### 프론트

- `Tab`에 `mtime: number` 필드 추가. 열기/리로드 시 갱신.
- 2초 `setInterval`: 모든 열린 탭에 대해 `file_mtime` 조회, 저장된 값과 다르면
  `reloadTab`. watcher 경유 리로드도 mtime을 갱신하므로 이중 렌더 없음.
- `reloadTab`의 `read_file` 실패(atomic save 순간 파일 부재 등) 시 기존 내용 유지,
  다음 폴링에서 자연 재시도. (기존: promise reject 방치 — 간헐 실패 후보)
- `file_mtime` 실패(파일 삭제됨)는 무시 — 재생성되면 mtime 변화로 감지.
- Cmd/Ctrl+R: 활성 탭 즉시 `reloadTab`. (WebView 페이지 리로드 기본 동작은 차단)

## 3. 테스트 / 검증

- 실제 앱 구동 + 파일 조작 + screencapture로 검증 (기존 검증 방식).
- PDF: export 실행 → 산출 .pdf 열어 육안 확인 (페이지네이션, 라이트 테마, mermaid).
- 폴링: 감시가 살아있는 환경에선 폴링 트리거 자체를 격리 재현하기 어려움 —
  mtime 커맨드 단위 확인 + 코드 경로 리뷰로 갈음.
- Cmd+R 동작 확인.
- Windows는 크로스빌드만 (실기 미검증 — 기존 한계 동일).

## 구현 노트 (사후 기록)

- **macOS printOperation 폐기**: `runOperation()`은 130MB 손상 PDF(xref 깨짐),
  `runOperationModalForWindow`는 빈 1페이지 — WKWebView 인쇄 뷰가 페인트하지 않음.
  최종 구현은 `WKWebView.createPDF`(전체 문서 단일 긴 벡터 페이지) + lopdf로
  MediaBox 윈도잉하여 A4 비율 페이지 분할 (콘텐츠 스트림 공유, 벡터 보존).
- **분할 한계**: 화면 렌더의 기하학적 슬라이스라 페이지 경계에서 텍스트 한 줄이
  잘릴 수 있음 (내용 유실은 없음 — 다음 페이지 상단에 이어짐). Windows는
  PrintToPdf가 네이티브 페이지네이션이라 해당 없음.
- **createPDF는 화면 CSS 캡처**라 `@media print`가 안 먹음 → export 중
  `body.pdf-exporting` 클래스로 앱 크롬 숨김 (print CSS는 Windows용으로 유지).
- **MDVIEW_PDF_EXPORT_TEST=/path/out.pdf** env: 실행 5초 후 프론트 정식 플로우로
  자동 export하는 스모크 훅 (macOS TCC가 스크립트 키 입력을 막아서 도입; CI 스모크
  겸용).
- **빌드 함정**: raw `cargo build --release`는 `custom-protocol` feature가 빠져
  release 바이너리가 임베드 자산 대신 devUrl을 로드 → **빈 흰 창**. 반드시
  `tauri build` CLI 경유 (또는 `--features tauri/custom-protocol`).

## 범위 외

- idea.md의 "project 모드(파일 트리)" — 별도 작업.
- Linux PDF export.

# Mermaid 다이어그램 인라인 줌 + 스크롤

## 문제

큰 mermaid 다이어그램은 `.mermaid-block svg { max-width: 100% }`로 폭에 맞춰
축소되어 글자가 읽을 수 없게 작아진다. 확대 수단이 없다.

## 결정

인라인 줌 + 네이티브 스크롤 (승인됨). 기본 크기는 지금처럼 폭 맞춤(fit),
확대 시 블록 내부에 스크롤바.

## 설계

### 구조

`renderAllMermaid()`가 SVG 삽입 후 아래 구조로 래핑:

```
.mermaid-block
 ├─ .mermaid-zoom-controls   [+][−][⟳]  (hover 시 표시, 우상단 오버레이)
 └─ .mermaid-scroll          overflow: auto  ← 스크롤바 담당
     └─ svg
```

### 동작

- 기본: `max-width: 100%` 폭 맞춤 (현행 유지).
- `+` / `−`: 배율 스텝 1.25×, 범위 fit(1×)~4×.
- 줌인: svg inline `width = viewBox 폭 × 배율`, `max-width: none` →
  `.mermaid-scroll`에 가로/세로 스크롤바. SVG는 벡터라 글자 선명.
- `⟳`: fit 리셋 (inline width 제거).
- Ctrl/⌘+휠: 블록 위에서 줌. 일반 휠은 페이지 스크롤 그대로.
- 배율 상태는 블록별 임시 상태. 재렌더(테마 전환·문서 갱신) 시 리셋 — 허용.

### PDF export 보호

`body.pdf-exporting`에서:
- `.mermaid-zoom-controls { display: none }`
- `.mermaid-scroll { overflow: visible }`
- svg inline width 무시(`width: auto !important` 계열, 기존 pdf 축소 규칙 유지)

기존 페이지 분할/축소 로직은 svg rect 측정 기반 — 오버라이드로 원복되므로 영향 없음.

### 비채택 대안

- transform:scale + 드래그 팬: 스크롤바와 transform 조합 어긋남, 팬 직접 구현.
- svg-pan-zoom 라이브러리: 의존성 추가, 휠 이벤트가 페이지 스크롤과 충돌.

## 검증

vite dev + Playwright(모킹 Tauri internals)로 확인:
줌인 → svg width 증가·스크롤바 등장, 리셋 → 원복, Ctrl+휠 줌,
`body.pdf-exporting`에서 컨트롤 숨김·width 원복.

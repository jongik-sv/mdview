# mdview — 핸드오프 (구현 시작점)

> 이 폴더에서 새 Claude 세션을 시작하면 **이 문서를 먼저 읽고** 이어서 구현한다.
> 스택·설계는 이미 합의됨. 재논의하지 말고 구현부터.

## 목표
VSCode 마크다운 미리보기 룩을 그대로 내는 **경량 네이티브 md 뷰어**.
편집은 Zed에서, 이 앱은 **뷰어 전용**(읽기) + 저장 시 자동 리프레시.

동기: Readdown 등 기존 뷰어는 mermaid를 시스템 다크 따라 칙칙하게 렌더 →
VSCode preview처럼 **흰 배경·또렷한 선·노란 note**(mermaid default 테마)를 원함.

## 스택 (확정 — 재론 금지)
- **Tauri v2 + vanilla-ts** (프레임워크 없음, 최경량). 시스템 webview 사용.
- 렌더 의존성 3개: `markdown-it` + `mermaid` + `github-markdown-css` — **전부 로컬 번들(오프라인 동작)**.
- 맥 먼저. 윈도우(WebView2)·코드사인은 **나중으로 완전 보류**.

## 현재 상태 (DONE)
- `pnpm create tauri-app mdview --template vanilla-ts` 스캐폴드 완료
- `pnpm install` 완료 (Tauri 2.11.x, @tauri-apps/api 2.11.1, cli 2.11.3, vite 6, ts 5.6)
- `git init` + 초기 커밋 완료
- Rust toolchain cargo 1.94, node 26, pnpm 10 확인됨
- ⚠️ Xcode 없음(CommandLineTools만) — Tauri는 cargo 빌드라 무관

## 요구사항
1. `.md`/`.markdown` 파일을 받아 VSCode 룩으로 렌더 (markdown-it + github-markdown-css)
2. mermaid 코드펜스 → 다이어그램 렌더
3. **테마 토글 기능** (핵심): 라이트↔다크 (+ 시스템 따라가기). 버튼 + localStorage 상태 기억
4. 파일 변경 자동 리프레시 (Zed에서 저장하면 갱신)
5. `.md` 기본 앱으로 지정 가능 (더블클릭 / "Open in Default App" → 이 앱)

## advisor가 짚은 함정 (구현 시 반드시)
1. **맥 파일 오픈 = argv 아님.** Tauri v2는 `Opened` RunEvent + `tauri.conf.json`의 `bundle.fileAssociations`로 경로 전달. argv는 윈도우/리눅스 경로. argv로만 짜면 터미널 테스트는 통과하고 **더블클릭 시 빈 창**이 뜬다. 맥 경로를 먼저 검증할 것.
2. **single-instance 플러그인** 도입 — 두번째 `.md` 오픈을 새 프로세스/창이 아니라 **기존 창으로 라우팅**.
3. **fileAssociations + duti/lsregister는 `tauri build` 번들에만 적용**, `tauri dev`에는 안 됨. 테스트 2루프로 분리:
   - dev 루프: 렌더/테마/watch — 경로를 직접 주입해서 확인
   - build 루프: 기본앱 연결(association) 플로우는 빌드 후에만 확인

## 구현 디테일 (확정 결정)
- **파일 읽기 + watch는 Rust에서** (`notify` crate). fs 플러그인 안 씀 → capability 스코핑 회피. 변경 시 프론트로 이벤트 emit.
- **테마 토글**:
  - 본문: `github-markdown-light.css` / `github-markdown-dark.css` **명시 파일을 클래스로 스왑**.
    media-query 통합본(`github-markdown.css`)은 시스템 외관 따라가서 수동 토글을 무력화 → **쓰지 말 것**.
  - mermaid: CSS 스왑 안 됨. 토글 시 `mermaid.initialize({theme})` 후 **재렌더** 필요 (light=`default`, dark=`dark`).
- **솔직한 한계** (사용자에게 이미 고지): 토글은 mermaid·본문 색만 고침. 외부 `<img src=*.svg>`의 박힌 색은 안 따라온다.

## Done 기준 (토이 파일 말고 실제 파일로 검증)
테스트 파일: `/Users/jji/project/ddobakddobak/docs/회의록샘플/2026.0624_계량대_내부회의.md`
- mermaid 블록 2개: flowchart(~line 62), **sequence with `box rgb()`(~line 202) — 최난도**
- 완료 = 둘 다 다이어그램으로 렌더 + 라이트 테마가 VSCode 스샷과 일치(흰 배경/노란 note/또렷한 선) + 다크 토글 가독 + Zed에서 저장 → 자동 리프레시
- `box rgb()` sequence를 특히 집중 검증

## 다음 단계 (새 세션 첫 작업)
1. Tauri v2 `Opened` 이벤트 / `fileAssociations` / single-instance 플러그인 현행 API 확인 (버전 민감)
2. Rust: read_file command + notify watch + Opened 이벤트 → 프론트 전달 + single-instance
3. Front: markdown-it(+표/tasklist 플러그인) + mermaid + github light/dark css 번들, 렌더 파이프라인
4. 테마 토글 UI + localStorage + mermaid 재렌더
5. `tauri.conf.json`: productName, fileAssociations(.md/.markdown), 창 설정
6. dev 루프 검증(실제 파일) → build 루프(기본앱 연결 + duti) 검증

## 작업 방식
- 구현은 서브에이전트 주도(사용자 상시 선호). 필요 시 Workflow 병용.
- 이 폴더엔 ddobakddobak의 MultiAgent CLAUDE.md 규칙이 **적용 안 됨**(디렉토리 격리). 일반 개발로 진행.

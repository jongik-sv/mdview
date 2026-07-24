# 히스토리에 폴더(프로젝트) 추가 — 설계

**날짜**: 2026-07-24
**대상**: `src/main.ts` (프론트엔드 전용, Rust 변경 없음)

## 배경

사이드바 하단 "기록" 패널은 최근 연 **파일**만 보여준다 (`mdview-recents`, localStorage,
최신순 dedup, 상한 10). 최근 연 **폴더(프로젝트)** 는 어디에도 남지 않아서, 폴더를 다시
열려면 매번 파일 선택 다이얼로그를 거쳐야 한다.

## 목표

폴더도 같은 기록 목록에 남긴다. 파일과 폴더를 **한 목록에 최신순으로 섞어서** 보여주고,
폴더 항목을 클릭하면 그 프로젝트를 다시 연다.

명시적 비목표: 별도 "최근 폴더" 섹션, 폴더별 상한 분리.
(개별 삭제는 1차에서 제외했다가 v0.1.16에서 추가 — 아래 후속 절 참고.)

## 저장 포맷

`mdview-recents`의 값이 `string[]` → `RecentEntry[]`로 바뀐다.

```ts
type RecentKind = 'file' | 'folder';
interface RecentEntry {
  path: string;
  kind: RecentKind;
}
```

**마이그레이션**: 기존 사용자의 값은 문자열 배열이다. `loadRecents`는 두 형태를 모두 받아,
문자열 항목을 `{ path, kind: 'file' }`로 승격한다. 기존 기록을 버리지 않는다. 저장은 항상
새 형태로 하므로, 첫 `saveRecents` 호출 시점에 자연스럽게 갈아탄다.

파일과 폴더는 경로가 겹칠 수 없으므로 dedup·삭제는 `path` 단독 비교로 충분하다.
`RECENTS_MAX = 10` 상한은 파일·폴더가 **공유**한다.

```ts
function loadRecents(): RecentEntry[]
function saveRecents(list: RecentEntry[]): void          // 유일한 기록 변경 경로, renderHistory 호출
function pushRecent(path: string, kind?: RecentKind): void   // 기본값 'file'
function removeRecent(path: string): void                    // 시그니처 유지
```

## 기록 시점

| 호출 지점 | 기록 |
| --- | --- |
| `openTabFromPath` (파일 열기) | O — 기존 그대로 |
| `btnTree` / `sidebarOpenFolder` 폴더 선택 다이얼로그 | O |
| 드래그&드롭으로 떨어뜨린 폴더 | O |
| `project-open-test` 스모크 훅 | O (일반 열기와 동일 경로) |
| **시작 시 마지막 프로젝트 복원** | **X** |

복원은 사용자 행동이 아니다. 복원까지 기록하면 앱을 켤 때마다 그 폴더가 기록 최상단으로
올라가서, 사용자가 실제로 연 순서가 매 실행마다 뒤섞인다. `openProject`에 세 번째 인자
`record = true`를 추가하고, 시작 시 복원 경로만 `record: false`로 호출한다.

`silent` 플래그를 재사용하지 않는 이유: 드롭 경로도 `silent: true`(폴더인지 판별 실패해도
조용히 무시)인데 이건 명백한 사용자 행동이라 기록해야 한다. 두 관심사가 다르다.

## 실패 처리

`openTabFromPath`는 예외를 던지고 호출자(`renderHistory` 클릭 핸들러)가 `removeRecent`를
부른다. `openProject`는 에러를 삼키고 `void`를 반환하므로 같은 패턴을 쓸 수 없다. 대신
`openProject`의 `scanDir` 실패 catch 안에서 직접 `removeRecent(root)`를 호출한다.
`record` 값과 무관하게 제거한다 — 사라진 폴더는 기록에 남을 이유가 없다.

## 렌더링과 클릭

`renderHistory`가 `kind`로 분기한다.

- 아이콘: 폴더는 `SVG_FOLDER`, 파일은 기존 `SVG_FILE` (`.bpmn`은 현재도 `SVG_FILE`이며 변경 없음)
- 클릭: 폴더 → `openProject(path)`, 파일 → 기존 `openTabFromPath(path)`
  `openTabFromPath`는 비-md 경로에서 조용히 조기 return하므로, 폴더가 그쪽으로 새면
  클릭이 무반응이 된다. kind 분기가 이 버그를 막는 유일한 방어선이다.
- active 강조: 파일은 `path === activePath`, 폴더는 `path === projectRoot`

`record: false` 경로에서는 `saveRecents`가 호출되지 않아 `renderHistory`도 안 불린다.
그래서 `openProject`와 `closeProject` 끝에서 `renderHistory()`를 명시적으로 호출해
폴더 active 강조를 동기화한다.

## 검증

프론트엔드 단위 테스트 인프라가 없다(vitest 없음). Playwright도 상설 스펙이 아니라
`.playwright-mcp/*.js` 애드혹 하네스뿐이다. 따라서:

1. `pnpm build`(= `tsc && vite build`) 타입체크 통과
2. 애드혹 하네스로 확인:
   - 레거시 `["/a.md","/b.md"]` 값이 마이그레이션되어 그대로 렌더되는지
   - 파일·폴더가 한 목록에 최신순으로 섞이는지
   - 폴더 항목 클릭이 `openProject`로 가는지 (`openTabFromPath` 아님)
   - 없는 폴더를 열면 기록에서 빠지는지
3. 실제 앱에서 수동 확인 — 폴더 열기 → 기록에 뜸 → 재시작 후 순서 유지 → 클릭 시 재오픈

## 후속: 탭 분리와 지우기 버튼 (v0.1.14)

한 목록에 섞어 본 결과, 파일 기록이 많으면 폴더가 상한 10에 밀려 잘 안 보였다.
저장소는 그대로 두고 **보기만** 탭으로 나눈다.

- `#history-head`의 "히스토리" 라벨을 `파일` / `폴더` 탭으로 교체. 선택 탭은
  `mdview-history-tab`에 저장하고, 기본값은 `file`.
- `renderHistory`가 `kind === historyTab`로 필터. 상한·최신순·dedup은 여전히
  파일·폴더가 한 저장소를 공유한다 — 탭은 필터일 뿐이다.
- 빈 목록 문구도 탭에 맞춰 "파일 기록 없음" / "폴더 기록 없음".
- 지우기 버튼 아이콘을 X → 휴지통으로 교체. X는 "패널 닫기"로 읽혀 의미가 어긋났다.
- 지우기 동작도 **보고 있는 탭만** 삭제로 축소. 안 보이는 쪽까지 날아가면
  되돌릴 방법이 없다. `title`도 탭에 따라 바뀐다.

## 후속: 항목 개별 삭제 (v0.1.16)

전체 지우기밖에 없어서 잘못 들어간 항목 하나를 빼려면 전부 날려야 했다.

- 항목 한 줄을 `.history-row` 래퍼로 감싸고 `[열기 버튼][제거 ✕]` 형제 구조로 둔다.
  `<button>` 안에 `<button>`을 넣는 건 무효 마크업이라 클릭 판정이 브라우저마다 갈린다.
- ✕는 평소 `opacity: 0`, 행 hover 또는 `:focus-visible`에서만 드러난다 —
  10줄 목록에 ✕가 상시 노출되면 시끄럽다. 클릭은 `removeRecent` →
  `saveRecents` → `renderHistory`의 기존 경로를 그대로 탄다.
- hover 배경은 `.history-row:hover .history-item`으로 옮겼다(✕ 위에서도 행 전체가
  hover로 보이게). 활성 항목 규칙은 특이도를 맞춰 hover 중에도 활성색이 유지된다.
- 휴지통 툴팁을 "파일/폴더 기록 **전체** 지우기"로 바꿔 항목별 ✕와 구분한다.
  지우는 범위는 여전히 보고 있는 탭뿐이다.

## 영향 범위

1차(폴더 기록)는 `src/main.ts`만 수정. 후속(탭·휴지통)에서 `index.html`(헤더 마크업)과
`src/styles.css`(`.history-tab`)가 추가로 바뀐다. Rust 쪽 커맨드 변경은 없다.

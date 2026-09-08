// CHANGELOG.md를 앱에 그대로 묶어 두고 버전별로 잘라 쓴다.
//
// 네트워크로 릴리스 노트를 받아오지 않는 이유는, 업데이트 직후 오프라인이어도
// "방금 무엇이 바뀌었는지"는 반드시 보여야 하기 때문이다. 빌드에 들어간
// CHANGELOG.md는 그 빌드의 버전까지를 담고 있으므로 이 조건을 항상 만족한다.
// 더 오래된 기록과 설치 파일은 GitHub 릴리스 링크로 넘긴다.
import changelogSource from '../CHANGELOG.md?raw';

export const RELEASES_URL = 'https://github.com/jongik-sv/mdview/releases';

/// 특정 버전의 릴리스 페이지 주소. 태그는 `v` 접두어를 쓴다.
export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

export type ReleaseNote = {
  /// `0.1.34` — 접두어 `v` 없이.
  version: string;
  /// 제목에 적힌 날짜. 없으면 빈 문자열.
  date: string;
  /// 그 버전 항목의 마크다운 본문 (제목 줄은 뺀다).
  body: string;
};

/// `## v0.1.34 — 2026-09-08` 형태의 제목마다 한 항목으로 쪼갠다. 제목이 버전
/// 형식이 아닌 절(예: "v0.1.33 이전")은 version이 비므로 목록에서 걸러진다.
const HEADING = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:[—-]\s*(.*))?$/;

export function parseChangelog(source: string = changelogSource): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  let current: ReleaseNote | null = null;
  for (const line of source.split('\n')) {
    const m = HEADING.exec(line.trim());
    if (m) {
      current = { version: m[1], date: (m[2] ?? '').trim(), body: '' };
      notes.push(current);
      continue;
    }
    // 버전 제목 다음이 아닌 줄(문서 머리말, 버전 형식이 아닌 절)은 버린다.
    if (line.startsWith('## ')) current = null;
    if (current) current.body += line + '\n';
  }
  for (const n of notes) n.body = n.body.trim();
  return notes;
}

/// 해당 버전의 항목. 없으면 null (개발 중 버전 등 — 호출 측이 전체 목록으로 넘어간다).
export function noteFor(version: string, notes = parseChangelog()): ReleaseNote | null {
  return notes.find((n) => n.version === version) ?? null;
}

/// 문서 전체 원본. 모달이 전체 변경 내역을 보여줄 때 쓴다.
export const changelogMarkdown = changelogSource;

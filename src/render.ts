import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import katex from '@vscode/markdown-it-katex';

/**
 * GitHub-ish heading slug: lowercase, drop punctuation (keep unicode letters,
 * digits, spaces, hyphens), spaces → hyphens. Lets in-document `#anchor` links
 * (TOCs) resolve to a heading element.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} \-]/gu, '')
    .replace(/\s+/g, '-');
}

/**
 * Renders markdown to HTML, extracting mermaid fenced code blocks as RAW
 * sources (NOT html-escaped) so that inline HTML such as <br/> in mermaid
 * labels survives for mermaid.render(). Each mermaid block becomes a
 * placeholder <div class="mermaid-block" data-mermaid-idx="i"> that main.ts
 * later fills with the rendered SVG.
 */
export function renderMarkdown(src: string): {
  html: string;
  blocks: string[];
  formBlocks: string[];
} {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    breaks: false,
  });
  md.use(taskLists, { enabled: true });
  // 수식: $$...$$ 블록 + 인라인 $...$ (닫는 $가 있을 때만 매칭). throwOnError:false →
  // 잘못된 LaTeX는 전체 렌더를 깨뜨리지 않고 해당 수식만 빨간 에러 텍스트로 표시.
  md.use(katex, { throwOnError: false });

  // Assign unique slug ids to headings so `#anchor` links resolve.
  md.core.ruler.push('heading_ids', (state) => {
    const seen: Record<string, number> = {};
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'heading_open') continue;
      const inline = toks[i + 1];
      let slug = slugify(inline && inline.type === 'inline' ? inline.content : '');
      if (!slug) continue;
      if (seen[slug] === undefined) seen[slug] = 0;
      else slug = `${slug}-${++seen[slug]}`;
      toks[i].attrSet('id', slug);
    }
  });

  const blocks: string[] = [];
  const formBlocks: string[] = [];
  const defaultFence = md.renderer.rules.fence!.bind(md.renderer.rules);
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const info = tokens[idx].info.trim().split(/\s+/)[0];
    if (info === 'mermaid') {
      const i = blocks.length;
      // RAW content — escape 절대 금지(<br/> 보존)
      blocks.push(tokens[idx].content);
      return `<div class="mermaid-block" data-mermaid-idx="${i}"></div>`;
    }
    if (info === 'form-js') {
      const i = formBlocks.length;
      // RAW JSON — main.ts의 renderAllFormJs가 파싱·마운트
      formBlocks.push(tokens[idx].content);
      return `<div class="form-js-block" data-formjs-idx="${i}"></div>`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };

  return { html: md.render(src), blocks, formBlocks };
}

/**
 * 마크다운 원본에서 blockIdx번째 ```form-js 펜스의 본문만 newBody로 교체한다.
 * 펜스 문자(`/~)·길이·들여쓰기는 보존. 대상 블록을 못 찾거나 펜스가 닫히지
 * 않았으면 null (원본 손상 방지 — 저장 측이 에러 처리).
 * renderMarkdown의 fence 매칭(info 첫 단어 === 'form-js')과 동일 순서로 센다.
 */
export function replaceFormFence(
  src: string,
  blockIdx: number,
  newBody: string,
): string | null {
  const lines = src.split('\n');
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
    if (!open) continue;
    const fence = open[2];
    const info = open[3].trim().split(/\s+/)[0] ?? '';
    // 닫는 펜스: 같은 문자, 길이 이상, 내용 없음
    const closeRe = new RegExp(`^\\s{0,3}${fence[0] === '~' ? '~' : '\`'}{${fence.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) j++;
    if (info === 'form-js') {
      found++;
      if (found === blockIdx) {
        if (j >= lines.length) return null; // 닫히지 않은 펜스
        const indent = open[1];
        const body = newBody.split('\n').map((l) => (l ? indent + l : l));
        return [...lines.slice(0, i + 1), ...body, ...lines.slice(j)].join('\n');
      }
    }
    // 펜스 본문은 통째로 건너뜀 (본문 안 텍스트를 펜스로 오인 방지) —
    // info 없는 플레인 펜스도 동일하게 스킵해야 renderMarkdown과 카운트가 맞는다.
    i = j;
  }
  return null;
}

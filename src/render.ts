import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';

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
export function renderMarkdown(src: string): { html: string; blocks: string[] } {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    breaks: false,
  });
  md.use(taskLists, { enabled: true });

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
  const defaultFence = md.renderer.rules.fence!.bind(md.renderer.rules);
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const info = tokens[idx].info.trim().split(/\s+/)[0];
    if (info === 'mermaid') {
      const i = blocks.length;
      // RAW content — escape 절대 금지(<br/> 보존)
      blocks.push(tokens[idx].content);
      return `<div class="mermaid-block" data-mermaid-idx="${i}"></div>`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };

  return { html: md.render(src), blocks };
}

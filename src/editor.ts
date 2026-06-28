/**
 * editor.ts — highlight.js source view (lazy-loaded, read-only).
 * Monaco is gone. Source view is a <pre><code class="hljs language-markdown"> inside #editor,
 * with a sticky line-number gutter.
 */

import type { HLJSApi } from 'highlight.js';
// Vite resolves `?url` at build time into cache-busted asset paths.
import githubLightUrl from 'highlight.js/styles/github.css?url';
import githubDarkUrl from 'highlight.js/styles/github-dark.css?url';

// Lazy singleton: resolved once, shared forever.
let hljsP: Promise<HLJSApi> | null = null;

async function loadHljs(): Promise<HLJSApi> {
  if (!hljsP) {
    hljsP = (async () => {
      const core = (await import('highlight.js/lib/core')).default;
      const md = (await import('highlight.js/lib/languages/markdown')).default;
      core.registerLanguage('markdown', md);
      return core;
    })();
  }
  return hljsP;
}

// Lazy <link> elements for hljs themes.
let linkLight: HTMLLinkElement | null = null;
let linkDark: HTMLLinkElement | null = null;

function ensureThemeLinks(): void {
  if (linkLight && linkDark) return;
  linkLight = document.createElement('link');
  linkLight.rel = 'stylesheet';
  linkLight.href = githubLightUrl;
  document.head.appendChild(linkLight);

  linkDark = document.createElement('link');
  linkDark.rel = 'stylesheet';
  linkDark.href = githubDarkUrl;
  document.head.appendChild(linkDark);
}

/** Toggle which hljs theme sheet is active via the `media` attribute. */
export function setSourceTheme(effective: 'light' | 'dark'): void {
  ensureThemeLinks();
  if (linkLight && linkDark) {
    linkLight.media = effective === 'light' ? 'all' : 'not all';
    linkDark.media = effective === 'dark' ? 'all' : 'not all';
  }
}

// Track current font size so renderSource and setSourceFontSize can apply it.
let currentFontPx = 16;

/** Update font size on both the gutter and the code element. */
export function setSourceFontSize(px: number): void {
  currentFontPx = px;
  const pre = document.querySelector<HTMLElement>('#editor .src-pre');
  if (pre) pre.style.fontSize = px + 'px';
  const gutter = document.querySelector<HTMLElement>('#editor .src-gutter');
  if (gutter) gutter.style.fontSize = px + 'px';
}

/**
 * Lazy-load highlight.js, syntax-highlight `code` as Markdown, and inject
 * a flex wrapper with a sticky line-number gutter and a <pre><code> into `container`.
 *
 * Structure:
 *   <div class="src-wrap">
 *     <div class="src-gutter" aria-hidden="true">…line numbers…</div>
 *     <pre class="src-pre"><code class="hljs language-markdown">…</code></pre>
 *   </div>
 *
 * `white-space: pre` (no wrap) keeps line numbers 1:1 with visual lines.
 * Vertical scroll is on #editor; the gutter is sticky-left so it stays
 * in place during horizontal scroll.
 */
export async function renderSource(container: HTMLElement, code: string): Promise<void> {
  const hljs = await loadHljs();
  const { value } = hljs.highlight(code, { language: 'markdown' });

  // Build line number string: one number per line, right-aligned via text-align.
  // Count lines based on the raw source (not the highlighted HTML).
  const lineCount = code.split('\n').length;
  const gutterLines = Array.from({ length: lineCount }, (_, i) => String(i + 1)).join('\n');

  container.innerHTML = `<div class="src-wrap"><div class="src-gutter" aria-hidden="true"></div><pre class="src-pre"><code class="hljs language-markdown"></code></pre></div>`;

  const gutterEl = container.querySelector<HTMLElement>('.src-gutter')!;
  gutterEl.textContent = gutterLines;
  gutterEl.style.fontSize = currentFontPx + 'px';

  const codeEl = container.querySelector<HTMLElement>('code')!;
  codeEl.innerHTML = value;

  const preEl = container.querySelector<HTMLElement>('.src-pre')!;
  preEl.style.fontSize = currentFontPx + 'px';
}

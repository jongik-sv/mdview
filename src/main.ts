import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { open, save, ask } from '@tauri-apps/plugin-dialog';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { openUrl, openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import mermaid from 'mermaid';
import 'katex/dist/katex.min.css';
import sample from './fixtures/sample.md?raw';
import { renderMarkdown, replaceFormFence } from './render';
import { renderAllFormJs, setFormBlockSaveHandler } from './formjs';
import {
  initTheme,
  setMode,
  getMode,
  setExportOverride,
  type EffectiveTheme,
  type ThemeMode,
} from './theme';
import { renderSource, setSourceTheme, setSourceFontSize } from './editor';

const isTauri = '__TAURI_INTERNALS__' in window;

// ── Context menu: disable globally ───────────────────────────────────────────
window.addEventListener('contextmenu', (e) => e.preventDefault());

// ── DOM refs ──────────────────────────────────────────────────────────────────
const content = document.querySelector<HTMLElement>('#content')!;
const editorContainer = document.querySelector<HTMLElement>('#editor')!;
const tabBar = document.querySelector<HTMLElement>('#tab-bar')!;
const themeToggle = document.querySelector<HTMLElement>('#theme-toggle')!;
const sourceToggle = document.querySelector<HTMLButtonElement>('#source-toggle')!;
const btnFontDec = document.querySelector<HTMLButtonElement>('#btn-font-dec')!;
const btnFontInc = document.querySelector<HTMLButtonElement>('#btn-font-inc')!;
const fontReadout = document.querySelector<HTMLButtonElement>('#font-readout')!;
const btnOpen = document.querySelector<HTMLButtonElement>('#btn-open')!;
const btnPdf = document.querySelector<HTMLButtonElement>('#btn-pdf')!;
const searchToggle = document.querySelector<HTMLButtonElement>('#search-toggle')!;

// ── Link clicks (rendered view) ────────────────────────────────────────────────
// A raw <a> click navigates the webview away from index.html, blanking the
// whole app. Intercept every link inside #content and route it instead:
//   #anchor      → smooth-scroll to that heading within the document
//   scheme URL   → open in the default browser (never in-app)
//   relative .md → open as a new tab (resolved against the active file's dir)
//   other file   → hand to the OS default app
//
// Cross-platform note: on Windows `activePath` is a native drive path
// (`C:\Users\me\doc.md`). resolveRelative must accept drive-letter absolutes
// and backslash separators, and the scheme test must NOT treat a single-letter
// drive prefix (`C:`) as a URL scheme — both broke link handling on Windows.

/** Briefly show a message at the bottom of the window (visible error feedback). */
function toast(msg: string): void {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText =
    'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;' +
    'max-width:80vw;padding:8px 14px;border-radius:8px;white-space:pre-wrap;' +
    'background:rgba(33,33,33,0.96);color:#fff;font-size:13px;' +
    'box-shadow:0 2px 12px rgba(0,0,0,0.45);';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

/**
 * Resolve a relative href against the active file's directory. Returns a path
 * in the OS-native separator (backslashes on Windows) so it matches the paths
 * the backend reports (dedup) and is accepted by ShellExecute/std::fs. Returns
 * null if `base` is not an absolute path (POSIX `/…` or Windows `C:\…`).
 */
function resolveRelative(base: string | null, rel: string): string | null {
  if (!base) return null;
  const win = /\\/.test(base) || /^[a-zA-Z]:/.test(base);
  const b = base.replace(/\\/g, '/');
  const isAbs = b.startsWith('/') || /^[a-zA-Z]:\//.test(b);
  if (!isAbs) return null;
  // Markdown encodes spaces/etc. in link hrefs (e.g. `my%20doc.md`); decode so
  // the resolved path matches the real file name.
  try {
    rel = decodeURIComponent(rel);
  } catch {
    /* leave rel as-is on malformed escapes */
  }
  const stack = b.slice(0, b.lastIndexOf('/')).split('/');
  for (const part of rel.replace(/\\/g, '/').replace(/[?#].*$/, '').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  const joined = stack.join('/');
  return win ? joined.replace(/\//g, '\\') : joined;
}

/**
 * Rewrite relative `<img src>` to a Tauri asset URL so local images render.
 * Markdown emits `<img src="rel/path.png">`, which the WKWebView resolves
 * against the `tauri://localhost` origin (a 404). Resolve each relative src
 * against the active file's directory and convert it via the asset protocol.
 * Absolute URLs (http:, https:, data:, asset:) are left untouched.
 */
function rewriteAssetSrcs(root: HTMLElement): void {
  if (!isTauri) return;
  root.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src) return;
    // Real URL scheme (not a `C:\` drive prefix) → already loadable, skip.
    if (/^[a-z][a-z0-9+.\-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return;
    const isAbs = src.startsWith('/') || /^[a-z]:[\\/]/i.test(src);
    const resolved = isAbs ? src : resolveRelative(activePath, src);
    if (!resolved) return;
    img.src = convertFileSrc(resolved);
  });
}

content.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href) return;
  e.preventDefault();

  // In-page anchor → scroll to the heading (ids assigned in render.ts).
  if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1));
    const target =
      content.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`) ??
      content.querySelector<HTMLElement>(`[name="${CSS.escape(id)}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // Real URL scheme (http:, https:, mailto:, …) → external browser. The scheme
  // must be 2+ chars and not a `C:\`/`c:/` drive prefix, else a Windows path
  // gets misrouted here and silently rejected by the opener scope.
  if (/^[a-z][a-z0-9+.\-]+:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
    if (isTauri)
      openUrl(href).catch((err) => {
        console.error('openUrl failed:', href, err);
        toast(`링크 열기 실패: ${err}`);
      });
    else window.open(href, '_blank');
    return;
  }

  // Relative path within the document tree.
  const resolved = resolveRelative(activePath, href);
  if (!resolved) return;
  if (/\.(md|markdown|form)$/i.test(resolved)) {
    openTabFromPath(resolved).catch((err) => {
      console.error('openTabFromPath failed:', resolved, err);
      toast(`파일 열기 실패: ${err}`);
    });
  } else if (isTauri) {
    openPath(resolved).catch((err) => {
      console.error('openPath failed:', resolved, err);
      toast(`열기 실패: ${err}`);
    });
  }
});

// Tab bar: translate a vertical mouse wheel into horizontal scroll so a long
// tab strip stays reachable with a plain mouse (Windows has no trackpad
// horizontal swipe). The strip itself is overflow-x:auto.
tabBar.addEventListener(
  'wheel',
  (e) => {
    if (e.deltaY === 0) return;
    tabBar.scrollLeft += e.deltaY;
    e.preventDefault();
  },
  { passive: false }
);

// ── Tab state ─────────────────────────────────────────────────────────────────
interface Tab {
  path: string;
  title: string;
  content: string;
  blocks: string[];
  formBlocks: string[];
  scrollY: number;
  mtime?: number;
}

let tabs: Tab[] = [];
let activePath: string | null = null;

// ── View mode (rendered | source) ─────────────────────────────────────────────
let viewMode: 'rendered' | 'source' = 'rendered';

async function applyViewMode(): Promise<void> {
  if (viewMode === 'source') {
    content.hidden = true;
    editorContainer.hidden = false;
    const activeTab = activePath ? findTab(activePath) : null;
    await renderSource(editorContainer, activeTab ? activeTab.content : '');
    setSourceTheme(effectiveTheme);
    setSourceFontSize(fontPx);
    // If the search bar is open, re-run against the new source content.
    if (searchOpen) {
      runSearch(true);
    }
  } else {
    editorContainer.hidden = true;
    content.hidden = false;
    // If the search bar is open, re-run against #content.
    if (searchOpen) {
      runSearch(true);
    }
  }
  sourceToggle.classList.toggle('active', viewMode === 'source');
}

sourceToggle.addEventListener('click', () => {
  viewMode = viewMode === 'rendered' ? 'source' : 'rendered';
  void applyViewMode();
});

// ── Find / Search ─────────────────────────────────────────────────────────────
// Unified find widget — works in both rendered (#content) and source (#editor code) views.
// Highlights via CSS Custom Highlight API (no DOM mutation).

const searchBar = document.querySelector<HTMLElement>('#search-bar')!;
const searchInput = document.querySelector<HTMLInputElement>('#search-input')!;
const searchCounter = document.querySelector<HTMLElement>('#search-counter')!;
const searchPrev = document.querySelector<HTMLButtonElement>('#search-prev')!;
const searchNext = document.querySelector<HTMLButtonElement>('#search-next')!;
const searchClose = document.querySelector<HTMLButtonElement>('#search-close')!;

const highlightApiAvailable =
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

let searchOpen = false;
let searchMatches: Range[] = [];
let searchCurrentIdx = -1;

/** Return the element whose text nodes we search: #content or the hljs <code> in #editor. */
function getActiveSearchRoot(): HTMLElement | null {
  if (viewMode === 'rendered') {
    return content;
  }
  // Source view: the <code> element injected by renderSource.
  return editorContainer.querySelector<HTMLElement>('code') ?? null;
}

function clearHighlights(): void {
  if (!highlightApiAvailable) return;
  CSS.highlights.delete('search-all');
  CSS.highlights.delete('search-current');
}

function updateCounter(): void {
  if (searchInput.value === '') {
    searchCounter.textContent = '';
  } else if (searchMatches.length === 0) {
    searchCounter.textContent = '결과 없음';
  } else {
    searchCounter.textContent = `${searchCurrentIdx + 1}/${searchMatches.length}`;
  }
}

/** Build a fresh list of match Ranges by walking text nodes under `root`. */
function computeMatches(query: string, root: HTMLElement): Range[] {
  const ranges: Range[] = [];
  if (query === '') return ranges;
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      // Skip text inside mermaid SVGs (only relevant in rendered view).
      if (node.parentElement?.closest('.mermaid-block')) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue && node.nodeValue.length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let textNode: Node | null;
  while ((textNode = walker.nextNode())) {
    const haystack = (textNode.nodeValue ?? '').toLowerCase();
    let from = 0;
    let at = haystack.indexOf(needle, from);
    while (at !== -1) {
      const range = document.createRange();
      range.setStart(textNode, at);
      range.setEnd(textNode, at + needle.length);
      ranges.push(range);
      from = at + needle.length;
      at = haystack.indexOf(needle, from);
    }
  }
  return ranges;
}

function paintHighlights(): void {
  if (!highlightApiAvailable) return;
  clearHighlights();
  if (searchMatches.length === 0) return;
  // All matches.
  const allHighlight = new Highlight(...searchMatches);
  CSS.highlights.set('search-all', allHighlight);
  // Current match (painted over the all set via higher priority).
  if (searchCurrentIdx >= 0 && searchCurrentIdx < searchMatches.length) {
    const currentHighlight = new Highlight(searchMatches[searchCurrentIdx]);
    currentHighlight.priority = 1;
    CSS.highlights.set('search-current', currentHighlight);
  }
}

/**
 * Scroll the current match into view. Works for both view modes:
 * - rendered: window scroll (normal document flow)
 * - source: scrolls within .src-pre (overflow:auto)
 * Uses scrollIntoView on the match's parent element to let the browser pick
 * the right scroll container automatically.
 */
function scrollCurrentIntoView(): void {
  if (searchCurrentIdx < 0 || searchCurrentIdx >= searchMatches.length) return;
  const node = searchMatches[searchCurrentIdx].startContainer;
  const el = node.nodeType === Node.TEXT_NODE
    ? (node as Text).parentElement
    : node as Element;
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** Recompute matches for current query; keep/clamp current index; repaint. */
function runSearch(resetToFirst: boolean): void {
  if (!highlightApiAvailable) {
    console.warn('CSS Custom Highlight API unavailable — search highlighting disabled.');
    searchMatches = [];
    searchCurrentIdx = -1;
    updateCounter();
    return;
  }
  const root = getActiveSearchRoot();
  if (!root) {
    searchMatches = [];
    searchCurrentIdx = -1;
    updateCounter();
    return;
  }
  searchMatches = computeMatches(searchInput.value, root);
  if (searchMatches.length === 0) {
    searchCurrentIdx = -1;
  } else if (resetToFirst || searchCurrentIdx < 0) {
    searchCurrentIdx = 0;
  } else if (searchCurrentIdx >= searchMatches.length) {
    searchCurrentIdx = searchMatches.length - 1;
  }
  paintHighlights();
  updateCounter();
  if (resetToFirst) scrollCurrentIntoView();
}

function gotoMatch(delta: number): void {
  if (searchMatches.length === 0) return;
  searchCurrentIdx =
    (searchCurrentIdx + delta + searchMatches.length) % searchMatches.length;
  paintHighlights();
  updateCounter();
  scrollCurrentIntoView();
}

function openSearchBar(): void {
  searchOpen = true;
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
  runSearch(true);
}

function closeSearchBar(): void {
  searchOpen = false;
  searchBar.hidden = true;
  clearHighlights();
  searchMatches = [];
  searchCurrentIdx = -1;
}

function triggerFind(): void {
  if (activePath === null) return;
  openSearchBar();
}

searchToggle.addEventListener('click', triggerFind);
searchClose.addEventListener('click', closeSearchBar);
searchNext.addEventListener('click', () => gotoMatch(1));
searchPrev.addEventListener('click', () => gotoMatch(-1));

searchInput.addEventListener('input', () => runSearch(true));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    gotoMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearchBar();
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    triggerFind();
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
    // Manual reload of the active tab — NOT a webview page reload.
    e.preventDefault();
    if (activePath) void reloadTab(activePath);
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
    e.preventDefault();
    void exportPdf();
  } else if (e.key === 'F3') {
    // 사이드바 검색 탭으로 이동. 프로젝트가 없으면 preventDefault도 하지
    // 않는다 — 브라우저 하네스에서 F3 기본 동작(찾기)을 삼키지 않게.
    if (!projectRoot) return;
    e.preventDefault();
    if (sidebar.hidden) showSidebar();
    showSearchTab();
  } else if (e.key === 'Escape' && searchOpen) {
    e.preventDefault();
    closeSearchBar();
  }
});

/**
 * Called after #content innerHTML is replaced (tab switch / reload) in rendered mode.
 * In source mode, the caller is responsible for re-running search after renderSource resolves.
 */
function refreshSearchAfterRenderedRender(): void {
  if (searchOpen && viewMode === 'rendered') {
    // Content nodes are brand-new — old match index is meaningless, reset to first.
    // Do NOT auto-scroll: a background file reload shouldn't yank the viewport.
    searchCurrentIdx = -1;
    runSearch(false);
  }
  // Source mode: search re-run happens explicitly after renderSource() in the callers.
}

// ── Mermaid ───────────────────────────────────────────────────────────────────
let effectiveTheme: EffectiveTheme = 'light';
let mmdSeq = 0;

async function renderAllMermaid(blocks: string[], theme: 'default' | 'dark'): Promise<void> {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme });
  const els = document.querySelectorAll<HTMLElement>('.mermaid-block');
  for (const el of els) {
    const idx = Number(el.dataset.mermaidIdx);
    const src = blocks[idx];
    try {
      const { svg } = await mermaid.render('mmd-' + mmdSeq++, src);
      el.innerHTML = svg;
      setupMermaidZoom(el);
    } catch (e) {
      el.innerHTML = `<pre class="mermaid-error">mermaid error: ${String(e)}</pre>`;
    }
  }
}

const MMD_ZOOM_STEP = 1.25;
const MMD_ZOOM_MAX = 4;

/**
 * 큰 다이어그램은 max-width:100%로 폭에 맞춰 축소되어 글자가 안 보인다 —
 * 렌더된 SVG를 스크롤 컨테이너로 감싸고 [+][−][⟳] 오버레이와 Ctrl/⌘+휠 줌을
 * 단다. 배율은 svg inline width(viewBox 폭 × scale)로만 표현해 글자가 벡터로
 * 선명하게 커지고, 스크롤은 네이티브 overflow가 담당한다. 재렌더(테마 전환·
 * 문서 갱신·PDF export)는 innerHTML을 통째로 갈아 상태가 자연 리셋된다.
 */
function setupMermaidZoom(block: HTMLElement): void {
  const svgEl = block.querySelector('svg');
  if (!svgEl) return;
  const naturalW = svgEl.viewBox.baseVal.width || svgEl.getBoundingClientRect().width;
  if (!naturalW) return;
  // mermaid는 svg에 inline `style="max-width: NNNpx"`를 직접 박는다(작은
  // 다이어그램이 컨테이너 폭으로 늘어나지 않게). 줌이 이 값을 덮으므로 리셋
  // 때 원복할 수 있게 보관한다 — ''로 지우면 width:100% svg가 컨테이너 폭으로
  // 부풀어 "축소하다 갑자기 커지는" 점프가 생긴다.
  const origMaxW = svgEl.style.maxWidth;

  const scroll = document.createElement('div');
  scroll.className = 'mermaid-scroll';
  scroll.appendChild(svgEl);
  const controls = document.createElement('div');
  controls.className = 'mermaid-zoom-controls';
  // 전체화면 뷰어 안에서는 ⛶(또 여는 재귀)를 달지 않는다.
  const inViewer = block.closest('.mermaid-viewer') !== null;
  const buttons: Array<[string, string, string]> = [
    ['in', '+', '확대'],
    ['out', '−', '축소'],
    ['reset', '⟳', '원래 크기'],
  ];
  if (!inViewer) buttons.push(['view', '⛶', '자세히 보기 — 전체 화면']);
  for (const [act, txt, title] of buttons) {
    const b = document.createElement('button');
    b.dataset.zoom = act;
    b.textContent = txt;
    b.title = title;
    controls.appendChild(b);
  }
  block.append(controls, scroll);

  let scale = 0; // 0 = fit(폭 맞춤, inline width 없음)
  const apply = (): void => {
    block.classList.toggle('zoomed', scale > 0);
    if (scale > 0) {
      svgEl.style.width = `${Math.round(naturalW * scale)}px`;
      svgEl.style.maxWidth = 'none';
    } else {
      svgEl.style.width = '';
      svgEl.style.maxWidth = origMaxW;
    }
  };
  const zoom = (dir: 1 | -1): void => {
    if (dir === 1) {
      // fit에서 시작하는 확대는 현재 표시 배율 기준 — 첫 클릭이 튀지 않게.
      const cur = scale > 0 ? scale : svgEl.getBoundingClientRect().width / naturalW;
      scale = Math.min(MMD_ZOOM_MAX, cur * MMD_ZOOM_STEP);
    } else if (scale > 0) {
      scale /= MMD_ZOOM_STEP;
      // fit 폭 이하로 내려가면 fit 복귀(fit보다 작게 볼 이유가 없다).
      const fitW = Math.min(scroll.clientWidth, naturalW);
      if (naturalW * scale <= fitW + 1) scale = 0;
    }
    apply();
  };
  controls.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest('button')?.dataset.zoom;
    if (act === 'in') zoom(1);
    else if (act === 'out') zoom(-1);
    else if (act === 'reset') {
      scale = 0;
      apply();
    } else if (act === 'view') openMermaidViewer(svgEl);
  });
  scroll.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false }
  );

  // 휠클릭(중버튼) 드래그 팬. mousedown preventDefault가 브라우저 오토스크롤을
  // 막는다(pointerdown만으론 부족).
  scroll.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  scroll.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  scroll.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    try {
      scroll.setPointerCapture(e.pointerId);
    } catch {
      // 합성 이벤트 등 캡처 불가 — 캡처 없이도 팬은 동작한다
    }
    const sx = e.clientX;
    const sy = e.clientY;
    const sl = scroll.scrollLeft;
    const st = scroll.scrollTop;
    scroll.classList.add('panning');
    const move = (ev: PointerEvent): void => {
      scroll.scrollLeft = sl - (ev.clientX - sx);
      scroll.scrollTop = st - (ev.clientY - sy);
    };
    const up = (): void => {
      scroll.removeEventListener('pointermove', move);
      scroll.removeEventListener('pointerup', up);
      scroll.removeEventListener('pointercancel', up);
      scroll.classList.remove('panning');
    };
    scroll.addEventListener('pointermove', move);
    scroll.addEventListener('pointerup', up);
    scroll.addEventListener('pointercancel', up);
  });
}

/**
 * "자세히 보기" — 다이어그램 하나만 전체 화면 오버레이로. SVG를 복제해
 * setupMermaidZoom을 다시 태우므로 줌/휠/팬이 인라인과 동일하게 동작한다.
 * (복제라 본문 쪽 줌 상태는 건드리지 않는다.) Esc 또는 ✕로 닫기.
 */
function openMermaidViewer(srcSvg: SVGSVGElement): void {
  const overlay = document.createElement('div');
  overlay.className = 'mermaid-viewer';
  const block = document.createElement('div');
  block.className = 'mermaid-block';
  const clone = srcSvg.cloneNode(true) as SVGSVGElement;
  const oldId = srcSvg.id;
  clone.id = oldId + '-viewer'; // 문서 내 id 중복 방지
  // mermaid는 스타일을 svg 내부 <style>에 `#<id> .node ...` 식으로 스코프한다
  // — id만 바꾸면 스타일이 전부 풀려 검정 덩어리로 렌더된다. 셀렉터도 치환.
  clone.querySelectorAll('style').forEach((s) => {
    s.textContent = (s.textContent ?? '').split(`#${oldId}`).join(`#${clone.id}`);
  });
  // 인라인 줌 상태는 가져오지 않는다 — fit으로 시작. max-width는 mermaid
  // 기본값(자연 폭)으로 되돌린다(원본이 줌 중이면 'none'이 복제되어 있다).
  clone.style.width = '';
  const vbW = clone.viewBox.baseVal.width;
  if (vbW) clone.style.maxWidth = `${vbW}px`;
  block.appendChild(clone);
  const close = document.createElement('button');
  close.className = 'mermaid-viewer-close';
  close.textContent = '✕';
  close.title = '닫기 (Esc)';
  overlay.append(block, close);
  document.body.appendChild(overlay);
  setupMermaidZoom(block);

  const closeViewer = (): void => {
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeViewer();
    }
  };
  close.addEventListener('click', closeViewer);
  window.addEventListener('keydown', onKey, true);
}

// ── PDF export ────────────────────────────────────────────────────────────────
let pdfExporting = false;

// macOS export path: the PDF is a geometric slice of the SCREEN layout, so
// page composition must be prepared in the DOM. Windows (PrintToPdf) runs a
// real print pipeline and gets native pagination + header/footer instead.
const isMacLayout = navigator.userAgent.includes('Mac');

/**
 * Prepare the DOM for A4 slicing (macOS only):
 * - reserve a header/footer band on every page and absolutely position the
 *   document title (header) and "n / N" (footer) into those bands
 * - insert spacers before blocks that would straddle a page's usable area,
 *   pushing them to the next page — no more mid-line cuts
 * Every added node carries .pdf-decoration; finishPdfExport removes them.
 * Page height mirrors the Rust slicer: width × 842/595 (A4 ratio) — uniform
 * scale keeps both boundary grids identical.
 */
function decorateForPdf(title: string): void {
  const docW = document.documentElement.scrollWidth;
  const pageH = docW * (842 / 595);
  const band = Math.round(pageH * 0.045);
  const usableH = pageH - band * 2;

  // 페이지보다 큰 mermaid를 사용 영역 높이로 축소(styles.css의
  // body.pdf-exporting .mermaid-block svg가 소비). 아래 rect 측정들이 축소된
  // 레이아웃을 보도록 가장 먼저 설정한다.
  document.documentElement.style.setProperty('--pdf-usable-h', `${Math.floor(usableH)}px`);

  // Page 1's content must start below its header band.
  content.style.paddingTop = `${band}px`;

  // Push blocks out of footer/header bands (recurse into too-tall blocks).
  const pushBlocks = (parent: HTMLElement): void => {
    for (
      let el = parent.firstElementChild as HTMLElement | null;
      el;
      el = el.nextElementSibling as HTMLElement | null
    ) {
      if (el.classList.contains('pdf-decoration')) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      const top = r.top + window.scrollY;
      const bottom = r.bottom + window.scrollY;
      const page = Math.floor(top / pageH);
      if (bottom <= (page + 1) * pageH - band) continue; // fits in usable area
      // 리프(자식 element 없는 pre/code·img)와 mermaid는 재귀로 쪼갤 수 없다
      // — SVG 내부의 HTML 스페이서는 레이아웃 무효, 리프는 재귀할 자식이
      // 없다. 페이지보다 커도 통째로 다음 페이지 머리에 정렬해 절단이 밴드
      // 경계에 오게 한다.
      const atomic =
        el.firstElementChild === null ||
        el.classList.contains('mermaid-block') ||
        // KaTeX 수식은 내부 span 구조가 정밀 배치 — 스페이서를 끼우면 깨진다.
        // 통째로 다음 페이지로 밀어 절단이 밴드 경계에 오게 한다.
        el.classList.contains('katex-display') ||
        el.classList.contains('katex') ||
        el.tagName === 'PRE';
      // 페이지보다 큰 atomic이 이미 페이지 머리에 있으면 밀어도 이득이 없다
      // (빈 페이지만 한 장 생김) — 그대로 두고 내부 절단을 감수한다.
      const atPageHead = top - (page * pageH + band) <= 1;
      if (r.height <= usableH || (atomic && !atPageHead)) {
        const sp = document.createElement('div');
        sp.className = 'pdf-decoration';
        sp.style.height = `${(page + 1) * pageH + band - top}px`;
        el.parentElement!.insertBefore(sp, el);
      } else if (!atomic) {
        pushBlocks(el); // taller than a page: try its children
      }
    }
  };
  pushBlocks(content);

  // 스페이서로 못 민 초대형 블록(사용영역보다 큰 pre/img 등)은 여전히 페이지
  // 경계에 걸쳐 있다. 그 구간에 밴드를 그리면 배경이 본문 줄을 통째로 덮어
  // 내용이 사라지므로(겹침보다 나쁨), 걸친 구간의 밴드는 생략한다.
  // EPS: 서브픽셀 rect·스페이서 반올림 오차로 경계에 정확히 맞닿은 블록이
  // 걸침으로 오판되면 멀쩡한 밴드까지 사라진다 — 몇 px 는 맞닿음으로 취급.
  const EPS = 3;
  const straddling: Array<[number, number]> = [];
  content.querySelectorAll<HTMLElement>('pre, img, table, .mermaid-block').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.height <= usableH + EPS) return;
    straddling.push([r.top + window.scrollY, r.bottom + window.scrollY]);
  });
  const bandClear = (top: number): boolean =>
    straddling.every(([s, e]) => top + band <= s + EPS || top >= e - EPS);

  // Header (title) + footer (page number) bands, absolutely positioned in
  // document coordinates — they land exactly inside each sliced page.
  const docH = document.documentElement.scrollHeight;
  const pages = Math.max(1, Math.ceil(docH / pageH));
  for (let k = 0; k < pages; k++) {
    if (bandClear(k * pageH)) {
      const header = document.createElement('div');
      header.className = 'pdf-decoration pdf-page-band';
      header.style.top = `${k * pageH}px`;
      header.style.height = `${band}px`;
      header.textContent = title;
      document.body.append(header);
    }
    if (bandClear((k + 1) * pageH - band)) {
      const footer = document.createElement('div');
      footer.className = 'pdf-decoration pdf-page-band';
      footer.style.top = `${(k + 1) * pageH - band}px`;
      footer.style.height = `${band}px`;
      footer.textContent = `${k + 1} / ${pages}`;
      document.body.append(footer);
    }
  }
}

function removePdfDecorations(): void {
  document.querySelectorAll('.pdf-decoration').forEach((el) => el.remove());
  content.style.paddingTop = '';
  document.documentElement.style.removeProperty('--pdf-usable-h');
}

/**
 * Save the active document as PDF: pick destination, force light theme
 * (mermaid re-rendered light), let Rust drive the native print-to-PDF, then
 * restore the current theme. Completion arrives via the `pdf-exported` event.
 */
/**
 * `destOverride` skips the save dialog (used by the MDVIEW_PDF_EXPORT_TEST
 * smoke hook); normal UI flows leave it undefined.
 */
async function exportPdf(destOverride?: string): Promise<void> {
  if (!isTauri || pdfExporting || activePath === null) return;
  const tab = findTab(activePath);
  if (!tab) return;
  let dest = destOverride ?? null;
  if (dest === null) {
    const defaultName = tab.title.replace(/\.(md|markdown|form)$/i, '') + '.pdf';
    const sep = activePath.includes('\\') ? '\\' : '/';
    const dir = activePath.slice(0, activePath.lastIndexOf(sep));
    dest = await save({
      defaultPath: dir + sep + defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
  }
  if (dest === null) return; // user cancelled
  pdfExporting = true;
  try {
    // macOS captures screen CSS (not print media): hide app chrome via class,
    // force light. setExportOverride triggers the theme onChange, but that
    // mermaid re-render is fire-and-forget — await one explicitly. Decoration
    // (page bands + spacers) must run AFTER mermaid settles the layout.
    document.body.classList.add('pdf-exporting');
    setExportOverride(true);
    await renderAllMermaid(tab.blocks, 'default');
    if (isMacLayout) {
      decorateForPdf(tab.title);
    }
    await invoke('export_pdf', { dest, title: tab.title });
  } catch (err) {
    finishPdfExport(false, dest, String(err));
  }
}

function finishPdfExport(ok: boolean, path: string, error: string | null): void {
  removePdfDecorations();
  document.body.classList.remove('pdf-exporting');
  setExportOverride(false);
  pdfExporting = false;
  if (ok) {
    toast(`PDF 저장됨: ${path}`);
  } else {
    toast(`PDF 저장 실패: ${error ?? '알 수 없는 오류'}`);
  }
}

btnPdf.addEventListener('click', () => void exportPdf());

// ── Font size ─────────────────────────────────────────────────────────────────
const FONT_KEY = 'mdview-fontsize';
const FONT_DEFAULT = 16;
const FONT_MIN = 11;
const FONT_MAX = 28;
const FONT_STEP = 2;

let fontPx: number = (() => {
  const stored = parseInt(localStorage.getItem(FONT_KEY) ?? '', 10);
  return isNaN(stored) ? FONT_DEFAULT : Math.min(FONT_MAX, Math.max(FONT_MIN, stored));
})();

function applyFontSize(): void {
  content.style.fontSize = fontPx + 'px';
  fontReadout.textContent = String(fontPx);
  fontReadout.title = `${fontPx}px · 클릭하면 기본(${FONT_DEFAULT}px)으로`;
}

function setFontSize(px: number): void {
  fontPx = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
  localStorage.setItem(FONT_KEY, String(fontPx));
  applyFontSize();
  setSourceFontSize(fontPx);
}

// NOTE: no dblclick-to-reset here. A dblclick reset on the SAME button is the
// same event sequence as two fast single-clicks, so rapid clicking fired a
// reset-to-default mid-stream ("shrinks, then jumps back to 16, then shrinks").
// Stepping must be the only thing these buttons do.
btnFontDec.addEventListener('click', () => setFontSize(fontPx - FONT_STEP));
btnFontInc.addEventListener('click', () => setFontSize(fontPx + FONT_STEP));
// Click the numeric readout to reset to default. Separate element from the
// steppers, so it never collides with rapid +/- clicking.
fontReadout.addEventListener('click', () => setFontSize(FONT_DEFAULT));

// ── 보기 옵션 (여유 간격 · 폭 제한) ───────────────────────────────────────────
// 독립 토글 2개. html[data-*] 속성만 바꾸고 실제 스타일은 styles.css 담당.
const VIEW_STYLE_KEY = 'mdview-view-style';
const VIEW_WIDTH_KEY = 'mdview-view-width';
const styleToggle = document.querySelector<HTMLButtonElement>('#style-toggle')!;
const widthToggle = document.querySelector<HTMLButtonElement>('#width-toggle')!;

let viewRelaxed = localStorage.getItem(VIEW_STYLE_KEY) === 'relaxed';
let viewLimited = localStorage.getItem(VIEW_WIDTH_KEY) === 'limited';

function applyViewOptions(): void {
  document.documentElement.setAttribute('data-mdview-style', viewRelaxed ? 'relaxed' : 'default');
  document.documentElement.setAttribute('data-mdview-width', viewLimited ? 'limited' : 'full');
  styleToggle.classList.toggle('active', viewRelaxed);
  widthToggle.classList.toggle('active', viewLimited);
}

styleToggle.addEventListener('click', () => {
  viewRelaxed = !viewRelaxed;
  localStorage.setItem(VIEW_STYLE_KEY, viewRelaxed ? 'relaxed' : 'default');
  applyViewOptions();
});
widthToggle.addEventListener('click', () => {
  viewLimited = !viewLimited;
  localStorage.setItem(VIEW_WIDTH_KEY, viewLimited ? 'limited' : 'full');
  applyViewOptions();
});
applyViewOptions();

// ── 커스텀 툴팁 ───────────────────────────────────────────────────────────────
// macOS WKWebView는 title 네이티브 툴팁을 그리지 않는다 — 전역 mouseover 위임으로
// 직접 그린다. 최초 hover 시 title → data-tip 이관(브라우저 네이티브 툴팁과의
// 중복 방지). 이후 코드가 title을 다시 세팅해도 다음 hover에서 재이관된다.
const tooltipEl = document.createElement('div');
tooltipEl.id = 'tooltip';
document.body.append(tooltipEl);
let tooltipTimer = 0;

function hideTooltip(): void {
  clearTimeout(tooltipTimer);
  tooltipEl.classList.remove('show');
}

document.addEventListener('mouseover', (e) => {
  hideTooltip();
  const target = (e.target as Element | null)?.closest<HTMLElement>('[title], [data-tip]');
  if (!target) return;
  if (target.title) {
    target.dataset.tip = target.title;
    target.removeAttribute('title');
  }
  const text = target.dataset.tip;
  if (!text) return;
  tooltipTimer = window.setTimeout(() => {
    const PAD = 4;
    tooltipEl.textContent = text;
    const tw = tooltipEl.offsetWidth;
    const th = tooltipEl.offsetHeight;
    const r = target.getBoundingClientRect();
    const left = Math.min(Math.max(r.left + r.width / 2 - tw / 2, PAD), window.innerWidth - tw - PAD);
    let top = r.bottom + 6;
    if (top + th > window.innerHeight - PAD) top = r.top - th - 6;
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top = top + 'px';
    tooltipEl.classList.add('show');
  }, 350);
});
document.addEventListener('scroll', hideTooltip, true);
document.addEventListener('mousedown', hideTooltip, true);
window.addEventListener('blur', hideTooltip);

// ── 자동 업데이트 ─────────────────────────────────────────────────────────────
// 시작 3초 후 + 4시간마다 GitHub Releases의 latest.json을 확인한다
// (tauri-plugin-updater, 엔드포인트/공개키는 tauri.conf.json). 자동 체크의
// 실패(오프라인 등)는 조용히 무시하고, 버전 뱃지 클릭(수동)일 때만 결과를
// 토스트로 알린다.
const versionReadout = document.querySelector<HTMLButtonElement>('#version-readout')!;

// 중복 실행 가드 — 시작 체크·주기 체크·뱃지 연타가 겹치면 같은 다이얼로그가
// 여러 장 쌓여 "나중에를 눌러도 안 닫히는" 것처럼 보인다.
let updateCheckBusy = false;

async function checkForUpdates(manual = false): Promise<void> {
  if (updateCheckBusy) return;
  updateCheckBusy = true;
  try {
    const update = await check();
    if (!update) {
      if (manual) toast('최신 버전입니다.');
      return;
    }
    const yes = await ask(
      `새 버전 ${update.version}이 있습니다 (현재 ${update.currentVersion}).\n지금 업데이트할까요?`,
      { title: 'mdview 업데이트', kind: 'info', okLabel: '업데이트', cancelLabel: '나중에' },
    );
    if (!yes) return;
    toast('업데이트 다운로드 중…');
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    // 네트워크 없음/릴리스에 latest.json 없음 등 — 뷰어 동작에 영향 주지 않는다.
    console.error('update check failed:', err);
    if (manual) toast('업데이트 확인 실패: ' + err);
  } finally {
    updateCheckBusy = false;
  }
}
if (isTauri) {
  versionReadout.hidden = false;
  void getVersion().then((v) => {
    versionReadout.textContent = 'v' + v;
  });
  versionReadout.addEventListener('click', () => void checkForUpdates(true));
  window.setTimeout(() => void checkForUpdates(), 3000);
  window.setInterval(() => void checkForUpdates(), 4 * 60 * 60 * 1000);
}

// ── OS 연동 (기본 앱 / 파일 관리자 / 터미널 / 경로 복사) ─────────────────────
// 실행 중인 플랫폼. 파일 관리자 메뉴 항목의 이름을 고르는 데만 쓴다. WebView의
// user agent를 파싱하는 대신 Rust에게 물어본다 (WKWebView와 WebView2가 서로
// 다른 문자열을 주기 때문에 파싱은 깨지기 쉽다). 메뉴는 열릴 때마다 새로
// 만들어지므로 이 값이 비동기로 채워져도 문제가 없다.
let platformName = 'macos';
if (isTauri) {
  invoke<string>('platform_name')
    .then((p) => {
      platformName = p;
    })
    .catch(() => {
      /* 값을 못 얻으면 기본값 그대로 — 라벨만 달라진다. */
    });
}

/// 플랫폼별 파일 관리자 이름 (메뉴 라벨용).
function fileManagerName(): string {
  if (platformName === 'windows') return '탐색기';
  if (platformName === 'macos') return 'Finder';
  return '파일 관리자';
}

/// OS 기본 앱으로 연다 — mdview가 렌더하지 않는 종류의 파일에 쓴다.
async function openWithDefaultApp(path: string): Promise<void> {
  try {
    await openPath(path);
  } catch (err) {
    console.error('openPath failed:', path, err);
    toast(`열기 실패: ${err}`);
  }
}

/// 파일 관리자에서 해당 항목을 선택된 상태로 보여준다.
async function revealInFileManager(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (err) {
    console.error('revealItemInDir failed:', path, err);
    toast(`${fileManagerName()}에서 열기 실패: ${err}`);
  }
}

/// 해당 경로(파일이면 그 상위 폴더)에서 터미널을 연다.
async function openInTerminal(path: string): Promise<void> {
  try {
    await invoke('open_terminal', { path });
  } catch (err) {
    console.error('open_terminal failed:', path, err);
    toast(`터미널 열기 실패: ${err}`);
  }
}

async function copyPathToClipboard(path: string): Promise<void> {
  try {
    // Under Tauri use the clipboard-manager plugin: navigator.clipboard.writeText
    // resolves but silently fails to write in WKWebView, so the path never lands
    // on the system clipboard. Fall back to the web API in the browser harness.
    if (isTauri) {
      await clipboardWriteText(path);
    } else {
      await navigator.clipboard.writeText(path);
    }
    toast('경로 복사됨: ' + path);
  } catch (err) {
    console.error('clipboard write failed:', err);
    toast('경로 복사 실패: ' + err);
  }
}

// ── Recent files & folders ────────────────────────────────────────────────────
// Persist the most-recently-opened paths in localStorage (most-recent first,
// deduped, capped). Only meaningful under Tauri where paths are real files.
// 파일과 폴더(프로젝트)가 한 목록에 저장되지만 상한은 종류별로 따로 적용한다 —
// 상한을 공유하면 파일을 10개만 열어도 폴더 기록이 전부 밀려나 사라진다.
// 경로가 겹칠 수 없으므로 dedup/삭제는 path 단독 비교로 충분하다.
const RECENTS_KEY = 'mdview-recents';
/** 종류별 최대 보관 개수 — 파일은 자주 오가므로 넉넉히, 폴더는 적게. */
const RECENTS_MAX: Record<RecentKind, number> = { file: 30, folder: 10 };

type RecentKind = 'file' | 'folder';
interface RecentEntry {
  path: string;
  kind: RecentKind;
}

/// 저장값은 원래 string[]이었다 — 옛 항목은 파일로 승격해서 살린다(버리지 않음).
function loadRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    const out: RecentEntry[] = [];
    for (const e of arr) {
      if (typeof e === 'string') {
        out.push({ path: e, kind: 'file' });
      } else if (e && typeof e.path === 'string') {
        out.push({ path: e.path, kind: e.kind === 'folder' ? 'folder' : 'file' });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function saveRecents(list: RecentEntry[]): void {
  // 종류별로 최신 RECENTS_MAX[kind]개만 남기되, 목록 전체의 최신순은 그대로 유지한다.
  const counts: Record<RecentKind, number> = { file: 0, folder: 0 };
  const kept = list.filter((e) => counts[e.kind]++ < RECENTS_MAX[e.kind]);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(kept));
  renderHistory(); // 기록 변경의 단일 경로 — 목록 UI도 여기서 항상 동기화
}

/** Record `path` in recents (dedup, cap). 이미 목록에 있으면 자리를 유지한다 —
    재선택할 때마다 맨 앞으로 끌어올리면 히스토리 순서가 계속 뒤섞여
    같은 항목을 다시 찾기 어렵다. 새 항목만 맨 앞에 들어간다. */
function pushRecent(path: string, kind: RecentKind = 'file'): void {
  const list = loadRecents();
  if (list.some((e) => e.path === path)) return;
  list.unshift({ path, kind });
  saveRecents(list);
}

/** Drop `path` from the recents list (e.g. it no longer exists). */
function removeRecent(path: string): void {
  saveRecents(loadRecents().filter((e) => e.path !== path));
}

// ── 히스토리 (사이드바 트리/검색 아래 최근 연 파일/폴더 목록) ────────────────
// 저장소는 하나(mdview-recents)이고 탭이 kind 필터 역할만 한다 — 최신순은
// 공유하지만 상한(RECENTS_MAX)은 종류별로 따로 적용된다.
const historyList = document.querySelector<HTMLElement>('#history-list')!;
const historyClear = document.querySelector<HTMLButtonElement>('#history-clear')!;
const historyTabs = document.querySelectorAll<HTMLButtonElement>('#history-tabs .history-tab');

const HISTORY_TAB_KEY = 'mdview-history-tab';
let historyTab: RecentKind =
  localStorage.getItem(HISTORY_TAB_KEY) === 'folder' ? 'folder' : 'file';

/// 히스토리 목록 재구축. saveRecents(모든 기록 변경의 단일 경로)와
/// renderTabBar(활성 파일 표시 갱신)가 호출한다. 항목 수는 종류별 RECENTS_MAX 이하.
function renderHistory(): void {
  // 전체 재구축이라 스크롤이 0으로 튄다 — 보던 위치 저장/복원 (renderTree와 동일).
  const scrollTop = historyList.scrollTop;
  historyList.textContent = '';
  for (const tab of historyTabs) {
    const on = tab.dataset.kind === historyTab;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  // 항목별 ✕와 구분되게 "전체"를 밝힌다 — 다만 지우는 범위는 보고 있는 탭뿐.
  historyClear.title = historyTab === 'folder' ? '폴더 기록 전체 지우기' : '파일 기록 전체 지우기';
  const list = loadRecents().filter((e) => e.kind === historyTab);
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = historyTab === 'folder' ? '폴더 기록 없음' : '파일 기록 없음';
    historyList.appendChild(empty);
    return;
  }
  for (const { path, kind } of list) {
    const isFolder = kind === 'folder';
    // 활성 표시 기준이 다르다 — 파일은 보고 있는 탭, 폴더는 현재 열린 프로젝트.
    const isActive = isFolder ? path === projectRoot : path === activePath;
    const item = document.createElement('button');
    item.className = 'history-item' + (isActive ? ' active' : '');
    item.title = path;

    const icon = document.createElement('span');
    icon.className = 'history-icon';
    icon.innerHTML = isFolder ? SVG_FOLDER : SVG_FILE;
    const name = document.createElement('span');
    name.className = 'history-name';
    name.textContent = path.split(/[/\\]/).pop() || path;

    // 제거 버튼은 item(<button>) 안이 아니라 형제로 둔다 — 버튼 중첩은 무효
    // 마크업이라 클릭 판정이 브라우저마다 갈린다.
    const row = document.createElement('div');
    row.className = 'history-row';
    const remove = document.createElement('button');
    remove.className = 'history-remove';
    remove.textContent = '✕';
    remove.title = '기록에서 제거';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRecent(path); // saveRecents → renderHistory로 목록이 다시 그려진다
    });

    item.appendChild(icon);
    item.appendChild(name);
    item.addEventListener('click', () => {
      // 폴더를 openTabFromPath로 보내면 비-md 조기 return에 걸려 무반응이 된다.
      // 실패 시 기록 제거는 openProject가 자체 catch에서 처리한다.
      if (isFolder) {
        void openProject(path);
        return;
      }
      openTabFromPath(path).catch((err) => {
        console.error('open history failed:', path, err);
        toast('파일 열기 실패 (목록서 제거): ' + path);
        removeRecent(path);
      });
    });
    row.appendChild(item);
    row.appendChild(remove);
    historyList.appendChild(row);
  }
  historyList.scrollTop = scrollTop;
}

// 보고 있는 탭의 기록만 지운다 — 안 보이는 쪽까지 날아가면 되돌릴 방법이 없다.
historyClear.addEventListener('click', () =>
  saveRecents(loadRecents().filter((e) => e.kind !== historyTab)),
);

for (const tab of historyTabs) {
  tab.addEventListener('click', () => {
    historyTab = tab.dataset.kind === 'folder' ? 'folder' : 'file';
    localStorage.setItem(HISTORY_TAB_KEY, historyTab);
    renderHistory();
  });
}

// ── 히스토리 높이 리사이즈 (트리/검색과의 경계 드래그) ──────────────────────
// 최소 2행(48px) ~ 최대 사이드바 높이의 절반. --history-h는 #history-list의
// 고정 height라 항목이 적거나 없어도 패널 크기가 유지된다. 사이드바 폭
// 리사이즈와 동일하게 pointer 이벤트 사용 (HTML5 DnD는 dragDropEnabled가 삼킨다).
const HISTORY_H_KEY = 'mdview-history-h';
const HISTORY_H_MIN = 48; // 2행
const HISTORY_H_DEFAULT = 240; // 10행 (CSS var 기본값과 동일)
const historyResize = document.querySelector<HTMLElement>('#history-resize')!;

/// 드래그 시점 전용 — 상한(사이드바 절반)은 그때의 실제 높이로 계산한다.
/// (시작 시 저장값 복원은 사이드바가 아직 hidden이라 CSS 50vh 가드에 맡긴다)
function applyHistoryHeight(px: number): void {
  const half = Math.floor(sidebar.clientHeight / 2);
  const max = Math.max(HISTORY_H_MIN, half);
  const h = Math.min(max, Math.max(HISTORY_H_MIN, Math.round(px)));
  document.documentElement.style.setProperty('--history-h', `${h}px`);
}

const savedHistoryH = Number(localStorage.getItem(HISTORY_H_KEY));
if (savedHistoryH) {
  document.documentElement.style.setProperty(
    '--history-h',
    `${Math.max(HISTORY_H_MIN, Math.round(savedHistoryH))}px`,
  );
}

historyResize.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  historyResize.setPointerCapture(e.pointerId);
  document.body.classList.add('history-resizing');
  const startY = e.clientY;
  const startH = historyList.getBoundingClientRect().height;
  const onMove = (ev: PointerEvent) => applyHistoryHeight(startH + (startY - ev.clientY));
  const cleanup = () => {
    historyResize.removeEventListener('pointermove', onMove);
    historyResize.removeEventListener('pointerup', onUp);
    historyResize.removeEventListener('pointercancel', onCancel);
    document.body.classList.remove('history-resizing');
  };
  const persist = () => {
    const cur = getComputedStyle(document.documentElement).getPropertyValue('--history-h');
    localStorage.setItem(HISTORY_H_KEY, String(parseInt(cur, 10) || HISTORY_H_DEFAULT));
  };
  const onUp = (ev: PointerEvent) => {
    cleanup();
    applyHistoryHeight(startH + (startY - ev.clientY));
    persist();
  };
  // 드래그 중 취소(제스처 인터럽트 등) 시에도 리스너·클래스가 남지 않게 정리.
  const onCancel = () => {
    cleanup();
    persist();
  };
  historyResize.addEventListener('pointermove', onMove);
  historyResize.addEventListener('pointerup', onUp);
  historyResize.addEventListener('pointercancel', onCancel);
});

// ── Theme toggle ──────────────────────────────────────────────────────────────
function updateThemeButtons(): void {
  const current = getMode();
  themeToggle.querySelectorAll<HTMLElement>('[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === current);
  });
}

themeToggle.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]');
  const mode = btn?.dataset.mode as ThemeMode | undefined;
  if (mode === 'light' || mode === 'dark' || mode === 'system') {
    setMode(mode);
    updateThemeButtons();
  }
});

// ── Tab helpers ───────────────────────────────────────────────────────────────
function findTab(path: string): Tab | undefined {
  return tabs.find((t) => t.path === path);
}

// Drag-to-reorder state (pointer-based, see note where pointerdown is wired).
let tabDrag: {
  path: string; // tab being dragged
  startX: number; // pointer x at pointerdown
  moved: boolean; // crossed the drag threshold?
} | null = null;
// True right after a drag so the trailing click doesn't also activate the tab.
let tabDragSuppressClick = false;
const TAB_DRAG_THRESHOLD = 4; // px before a press becomes a drag

function startTabDrag(e: PointerEvent, path: string): void {
  // Fresh press: clear any stale suppress flag from a prior drag whose click
  // never fired (pointerup landed on a different tab than pointerdown).
  tabDragSuppressClick = false;
  if (e.button !== 0) return; // left button only
  // Let the close button handle its own clicks.
  if ((e.target as HTMLElement).closest('.tab-close')) return;
  tabDrag = { path, startX: e.clientX, moved: false };
  window.addEventListener('pointermove', onTabDragMove);
  window.addEventListener('pointerup', onTabDragEnd);
}

function onTabDragMove(e: PointerEvent): void {
  if (!tabDrag) return;
  if (!tabDrag.moved) {
    if (Math.abs(e.clientX - tabDrag.startX) < TAB_DRAG_THRESHOLD) return;
    tabDrag.moved = true;
    const srcEl = tabBar.querySelector<HTMLElement>(
      `.tab[data-path="${CSS.escape(tabDrag.path)}"]`,
    );
    srcEl?.classList.add('tab-dragging');
  }
  const hit = tabElAtX(e.clientX);
  clearDropMarkers();
  if (hit && hit.path !== tabDrag.path) {
    const rect = hit.el.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    hit.el.classList.toggle('tab-drop-after', after);
    hit.el.classList.toggle('tab-drop-before', !after);
  }
}

function onTabDragEnd(e: PointerEvent): void {
  window.removeEventListener('pointermove', onTabDragMove);
  window.removeEventListener('pointerup', onTabDragEnd);
  const drag = tabDrag;
  tabDrag = null;
  clearDropMarkers();
  tabBar
    .querySelector('.tab-dragging')
    ?.classList.remove('tab-dragging');
  if (!drag || !drag.moved) return; // was a plain click, not a drag
  tabDragSuppressClick = true;
  const hit = tabElAtX(e.clientX);
  if (hit && hit.path !== drag.path) {
    const rect = hit.el.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    reorderTabs(drag.path, hit.path, after);
  }
}

// The tab element whose horizontal extent contains `clientX` (clamped to the
// ends of the strip so dropping past the last tab lands at the edge).
function tabElAtX(clientX: number): { path: string; el: HTMLElement } | null {
  const els = Array.from(tabBar.querySelectorAll<HTMLElement>('.tab'));
  if (els.length === 0) return null;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right) {
      return { path: el.dataset.path!, el };
    }
  }
  const first = els[0];
  if (clientX < first.getBoundingClientRect().left) {
    return { path: first.dataset.path!, el: first };
  }
  const last = els[els.length - 1];
  return { path: last.dataset.path!, el: last };
}

function clearDropMarkers(): void {
  for (const el of tabBar.querySelectorAll('.tab-drop-before, .tab-drop-after')) {
    el.classList.remove('tab-drop-before', 'tab-drop-after');
  }
}

// Move `fromPath` so it lands relative to `toPath`. `insertAfter` decides which
// side of the target it drops on (based on where in the target the cursor was).
function reorderTabs(fromPath: string, toPath: string, insertAfter: boolean): void {
  if (fromPath === toPath) return;
  const fromIdx = tabs.findIndex((t) => t.path === fromPath);
  if (fromIdx === -1) return;
  const [moved] = tabs.splice(fromIdx, 1);
  let toIdx = tabs.findIndex((t) => t.path === toPath);
  if (toIdx === -1) {
    // Target vanished mid-drag: put it back where it was.
    tabs.splice(fromIdx, 0, moved);
    return;
  }
  if (insertAfter) toIdx += 1;
  tabs.splice(toIdx, 0, moved);
  renderTabBar();
}

function renderTabBar(): void {
  tabBar.innerHTML = '';
  let activeEl: HTMLElement | null = null;
  for (const tab of tabs) {
    const el = document.createElement('div');
    const isActive = tab.path === activePath;
    el.className = 'tab' + (isActive ? ' tab-active' : '');
    if (isActive) activeEl = el;
    el.title = tab.path;
    el.dataset.path = tab.path;
    // Pointer-based drag-to-reorder. We deliberately avoid HTML5 draggable/DnD:
    // the window has `dragDropEnabled` (OS-level file drop for opening .md), which
    // swallows in-page HTML5 drag events on some platforms (notably Windows).
    el.addEventListener('pointerdown', (e) => startTabDrag(e, tab.path));
    // stopPropagation: window의 contextmenu 리스너(열린 메뉴 정리)가 bubble로
    // 나중에 실행돼 방금 연 메뉴를 도로 닫는 것을 막는다.
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTabMenu(e, tab.path);
    });

    // 프로젝트가 열려 있는데 그 밖의 파일이면 탭에 외부 표시를 단다 — 안 그러면
    // 트리에 보이는 문서와 구분이 안 된다. 프로젝트가 없을 땐 모든 탭이 "밖"이라
    // 표시가 소음이 되므로 달지 않는다.
    if (projectRoot && !isUnderDir(projectRoot, tab.path)) {
      el.classList.add('tab-external');
      const target = bestFolderFor(tab.path);
      const badge = document.createElement('button');
      badge.className = 'tab-external-badge';
      badge.innerHTML = SVG_EXTERNAL;
      // 열릴 폴더를 미리 알려준다 — 직속 폴더가 아닐 수 있어서(히스토리의 상위
      // 프로젝트를 고른다) 이름을 안 밝히면 어디로 가는지 예측이 안 된다.
      badge.title = `프로젝트 폴더 밖의 문서 — 클릭하면 "${target.split(/[/\\]/).pop() || target}" 폴더를 엽니다`;
      badge.addEventListener('pointerdown', (e) => e.stopPropagation()); // 탭 드래그 방지
      badge.addEventListener('click', (e) => {
        e.stopPropagation(); // 탭 활성화로 새지 않게
        void openProject(target);
      });
      el.appendChild(badge);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.title = '닫기';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      void closeTab(tab.path);
    });

    el.appendChild(title);
    el.appendChild(close);
    el.addEventListener('click', () => {
      if (tabDragSuppressClick) {
        tabDragSuppressClick = false;
        return; // this click is the tail of a drag — don't activate
      }
      void activate(tab.path);
    });
    tabBar.appendChild(el);
  }
  // Keep the active tab visible when the strip overflows (open/switch scrolls to it).
  activeEl?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  btnReveal.disabled = activePath === null; // 문서 없으면 과녁 비활성
  renderHistory(); // 히스토리의 활성 파일 표시 갱신
  updateTreeHighlight(true); // 탭 전환은 트리도 활성 파일 위치로 따라간다
  // 탭 추가/닫기/순서변경/활성화 전부 여기를 지난다 — 세션 저장 단일 훅.
  saveSession();
}

// ── Session restore (재시작 시 열린 탭 복원) ─────────────────────────────────
const SESSION_KEY = 'mdview-session';
interface SavedSession {
  paths: string[];
  active: string | null;
  scroll: Record<string, number>;
}
let restoringSession = false;

function saveSession(): void {
  // 복원 루프 중간 상태나 PDF export의 일시적 레이아웃을 세션으로 남기지 않는다.
  if (restoringSession || pdfExporting) return;
  const scroll: Record<string, number> = {};
  for (const t of tabs) scroll[t.path] = t.path === activePath ? window.scrollY : t.scrollY;
  const s: SavedSession = { paths: tabs.map((t) => t.path), active: activePath, scroll };
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<SavedSession>;
    if (!Array.isArray(s.paths)) return null;
    return {
      paths: s.paths.filter((p): p is string => typeof p === 'string'),
      active: typeof s.active === 'string' ? s.active : null,
      scroll: s.scroll && typeof s.scroll === 'object' ? s.scroll : {},
    };
  } catch {
    return null;
  }
}

/**
 * 저장된 세션의 탭들을 다시 연다. 삭제된 파일은 조용히 스킵. 복원은 열람
 * 기록이 아니므로 pushRecent 하지 않는다(openTabFromPath를 안 쓰는 이유).
 */
async function restoreSession(): Promise<void> {
  const s = loadSession();
  if (!s || s.paths.length === 0) return;
  restoringSession = true;
  try {
    for (const p of s.paths) {
      if (findTab(p)) continue;
      try {
        const c = await invoke<string>('read_file', { path: p });
        const t = _addTab(p, c);
        t.scrollY = s.scroll[p] ?? 0;
        t.mtime = (await fetchMtime(p)) ?? 0;
        await invoke('watch_file', { path: p });
      } catch {
        // 파일이 사라짐 — 세션에서 자연 탈락
      }
    }
  } finally {
    restoringSession = false;
  }
  if (tabs.length > 0) {
    const target = s.active !== null && findTab(s.active) ? s.active : tabs[tabs.length - 1].path;
    await activate(target);
  }
  saveSession(); // 탈락분 반영
}

// 활성 탭의 스크롤 위치도 세션에 유지 — 종료 이벤트(beforeunload)는 WKWebView
// 에서 신뢰할 수 없어 수시 저장한다.
let scrollSaveTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener(
  'scroll',
  () => {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(saveSession, 500);
  },
  { passive: true },
);

async function renderActive(): Promise<void> {
  if (activePath === null) {
    content.innerHTML =
      '<p class="placeholder">' +
      (isTauri
        ? '마크다운 파일을 열어주세요 — 드래그하거나 + 버튼'
        : '파일이 없습니다.') +
      '</p>';
    applyFontSize();
    refreshSearchAfterRenderedRender();
    return;
  }
  const tab = findTab(activePath);
  if (!tab) return;
  if (/\.form$/i.test(tab.path)) {
    // .form 파일: 내용 전체가 form-js 스키마 JSON — 뷰어 블록 하나로 마운트.
    content.innerHTML = '<div class="form-js-block" data-formjs-idx="0"></div>';
    tab.blocks = [];
    tab.formBlocks = [tab.content];
    applyFontSize();
    await renderAllFormJs(tab.formBlocks);
    window.scrollTo(0, tab.scrollY);
    refreshSearchAfterRenderedRender();
    return;
  }
  const { html, blocks, formBlocks } = renderMarkdown(tab.content);
  content.innerHTML = html;
  rewriteAssetSrcs(content);
  tab.blocks = blocks;
  tab.formBlocks = formBlocks;
  applyFontSize();
  await renderAllMermaid(blocks, effectiveTheme === 'dark' ? 'dark' : 'default');
  await renderAllFormJs(formBlocks);
  // Restore scroll AFTER mermaid (mermaid changes document height)
  window.scrollTo(0, tab.scrollY);
  // Re-run search (or clear) now that #content has new nodes.
  refreshSearchAfterRenderedRender();
}

function _addTab(path: string, tabContent: string): Tab {
  const existing = findTab(path);
  if (existing) return existing;
  // basename: split on BOTH separators — Windows paths use `\`, POSIX uses `/`.
  const title = path.split(/[/\\]/).pop() || path;
  const tab: Tab = { path, title, content: tabContent, blocks: [], formBlocks: [], scrollY: 0, mtime: 0 };
  tabs.push(tab);
  renderTabBar();
  return tab;
}

async function activate(path: string): Promise<void> {
  if (path === activePath) return;
  // Save outgoing tab's scroll position BEFORE changing activePath
  if (activePath !== null) {
    const outgoing = findTab(activePath);
    if (outgoing) outgoing.scrollY = window.scrollY;
  }
  activePath = path;
  await renderActive();
  if (viewMode === 'source') {
    const tab = findTab(path);
    await renderSource(editorContainer, tab ? tab.content : '');
    setSourceTheme(effectiveTheme);
    setSourceFontSize(fontPx);
    if (searchOpen) {
      runSearch(true);
    }
  }
  renderTabBar();
}

async function closeTab(path: string): Promise<void> {
  if (isTauri) {
    await invoke('unwatch_file', { path });
  }
  const idx = tabs.findIndex((t) => t.path === path);
  if (idx === -1) return;
  tabs.splice(idx, 1);
  if (path === activePath) {
    if (tabs.length === 0) {
      activePath = null;
      await renderActive();
    } else {
      const nextIdx = Math.min(idx, tabs.length - 1);
      const nextPath = tabs[nextIdx].path;
      activePath = null; // reset so activate doesn't short-circuit
      await activate(nextPath);
    }
  }
  renderTabBar();
}

/** Close several tabs at once (context menu bulk actions). */
async function closeTabs(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const closing = new Set(paths);
  if (isTauri) {
    await Promise.all(paths.map((p) => invoke('unwatch_file', { path: p })));
  }
  const oldIdx = activePath ? tabs.findIndex((t) => t.path === activePath) : -1;
  const closingActive = activePath !== null && closing.has(activePath);
  tabs = tabs.filter((t) => !closing.has(t.path));
  if (closingActive) {
    if (tabs.length === 0) {
      activePath = null;
      await renderActive();
    } else {
      const nextIdx = Math.min(Math.max(oldIdx, 0), tabs.length - 1);
      const nextPath = tabs[nextIdx].path;
      activePath = null; // reset so activate doesn't short-circuit
      await activate(nextPath);
    }
  }
  renderTabBar();
}

// ── Context menu (shared: tabs, tree dirs) ───────────────────────────────────
// Custom right-click menu. Inapplicable items are disabled (greyed), not hidden.
type CtxEntry = { label: string; enabled?: boolean; action: () => void } | 'sep';

const ctxMenu = document.createElement('div');
ctxMenu.className = 'ctx-menu';
ctxMenu.hidden = true;
document.body.appendChild(ctxMenu);
let ctxMenuOpen = false;

function closeCtxMenu(): void {
  ctxMenuOpen = false;
  ctxMenu.hidden = true;
}

function openCtxMenu(e: MouseEvent, entries: CtxEntry[]): void {
  ctxMenu.innerHTML = '';
  for (const entry of entries) {
    if (entry === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      ctxMenu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-item';
    btn.textContent = entry.label;
    btn.disabled = entry.enabled === false;
    btn.addEventListener('click', () => {
      closeCtxMenu();
      entry.action();
    });
    ctxMenu.appendChild(btn);
  }
  // Show first so offsetWidth/Height are measurable, then clamp to viewport.
  ctxMenu.hidden = false;
  ctxMenuOpen = true;
  ctxMenu.style.left = Math.max(0, Math.min(e.clientX, window.innerWidth - ctxMenu.offsetWidth - 4)) + 'px';
  ctxMenu.style.top = Math.max(0, Math.min(e.clientY, window.innerHeight - ctxMenu.offsetHeight - 4)) + 'px';
}

function openTabMenu(e: MouseEvent, path: string): void {
  const idx = tabs.findIndex((t) => t.path === path);
  if (idx === -1) return;
  const left = tabs.slice(0, idx).map((t) => t.path);
  const right = tabs.slice(idx + 1).map((t) => t.path);
  openCtxMenu(e, [
    { label: '닫기', action: () => void closeTab(path) },
    {
      label: '다른 탭 닫기',
      enabled: left.length + right.length > 0,
      action: () => void closeTabs([...left, ...right]),
    },
    'sep',
    { label: '왼쪽 탭 닫기', enabled: left.length > 0, action: () => void closeTabs(left) },
    { label: '오른쪽 탭 닫기', enabled: right.length > 0, action: () => void closeTabs(right) },
    'sep',
    { label: '모든 탭 닫기', action: () => void closeTabs(tabs.map((t) => t.path)) },
    'sep',
    {
      // 이미 그 폴더가 루트면 할 일이 없다.
      label: '이 파일의 폴더 열기',
      enabled: projectRoot !== parentDir(path),
      action: () => void openProject(parentDir(path)),
    },
    { label: '경로 복사', action: () => void copyPathToClipboard(path) },
  ]);
}

document.addEventListener('click', (e) => {
  if (ctxMenuOpen && !ctxMenu.contains(e.target as Node)) closeCtxMenu();
});
// capture + stopImmediatePropagation: 메뉴가 열린 상태의 Esc는 메뉴만 닫아야
// 한다 — 먼저 등록된 bubble 핸들러(문서 내 찾기 닫기)까지 내려가면 안 됨.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && ctxMenuOpen) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeCtxMenu();
    }
  },
  { capture: true },
);
// 다른 곳 우클릭 시 열린 메뉴 정리 (탭/트리 위 우클릭은 이후 리스너가 다시 연다).
window.addEventListener('contextmenu', () => {
  if (ctxMenuOpen) closeCtxMenu();
});

/** Fetch mtime for a path; null when unavailable (deleted, briefly missing). */
async function fetchMtime(path: string): Promise<number | null> {
  try {
    return await invoke<number>('file_mtime', { path });
  } catch {
    return null;
  }
}

async function reloadTab(path: string): Promise<void> {
  const tab = findTab(path);
  if (!tab) return;
  // If it's the active tab, save scroll before re-render
  if (path === activePath) {
    tab.scrollY = window.scrollY;
  }
  // Atomic saves briefly remove the file; on read failure keep the current
  // content — the watcher's next event or the mtime poll retries naturally.
  let next: string;
  try {
    next = await invoke<string>('read_file', { path });
  } catch {
    return;
  }
  tab.content = next;
  tab.mtime = (await fetchMtime(path)) ?? tab.mtime;
  if (path === activePath) {
    await renderActive(); // renderActive restores scrollY after mermaid
    if (viewMode === 'source') {
      await renderSource(editorContainer, tab.content);
      setSourceTheme(effectiveTheme);
      setSourceFontSize(fontPx);
      if (searchOpen) {
        // Background reload: reset index to first but don't scroll (preserve viewport).
        searchCurrentIdx = -1;
        runSearch(false);
      }
    }
  }
}

async function openTabFromPath(path: string): Promise<void> {
  if (!/\.(md|markdown|form)$/i.test(path)) return;
  const existing = findTab(path);
  if (existing) {
    pushRecent(path);
    await activate(path);
    return;
  }
  const c = await invoke<string>('read_file', { path });
  pushRecent(path);
  _addTab(path, c);
  const t = findTab(path);
  if (t) t.mtime = (await fetchMtime(path)) ?? 0;
  await invoke('watch_file', { path });
  await activate(path);
}

// ── Project mode (md-only file tree sidebar) ─────────────────────────────────
const SVG_CHEVRON =
  '<svg width="10" height="10" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SVG_FOLDER =
  '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M1.75 3.5A1.75 1.75 0 0 1 3.5 1.75h2.1c.47 0 .92.19 1.25.52l.88.88h4.77A1.75 1.75 0 0 1 14.25 4.9v7.35a1.75 1.75 0 0 1-1.75 1.75h-9a1.75 1.75 0 0 1-1.75-1.75z" fill="currentColor"/></svg>';
const SVG_FILE =
  '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M3.75 1.75h5.5l3 3v9a.75.75 0 0 1-.75.75h-7.75a.75.75 0 0 1-.75-.75v-11.25a.75.75 0 0 1 .75-.75z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.25 1.75v3h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5 11.2V8l1.6 1.9L8.2 8v3.2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// 상자 밖으로 나가는 화살표 — "프로젝트 폴더 밖" 표시 (탭 배지).
const SVG_EXTERNAL =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3H3.6A1.6 1.6 0 0 0 2 4.6v7.8A1.6 1.6 0 0 0 3.6 14h7.8a1.6 1.6 0 0 0 1.6-1.6V9"/><path d="M9.8 2.2H14v4.2"/><path d="M14 2.2 7.8 8.4"/></svg>';
// 원(시작 이벤트)-사각형(태스크)-원(종료 이벤트) — BPMN 표기법을 참고한 파일 아이콘.
// 폴더/파일 아이콘과 동일하게 currentColor 선화 스타일로 통일.
// 입력 필드 두 개가 쌓인 폼 모양 — form-js(.form) 파일 아이콘.
const SVG_FORM =
  '<svg width="15" height="15" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="4.2" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M4 5.1h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><rect x="2" y="9" width="12" height="4.2" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M4 11.1h6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
const SVG_BPMN =
  '<svg width="15" height="15" viewBox="0 0 16 16"><circle cx="2.6" cy="8" r="1.5" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M4.1 8h2.3" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="6.6" y="5.7" width="4.3" height="4.6" rx="0.9" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M10.9 8h2.1" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="13.5" cy="8" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

// ── 확장자별 파일 아이콘 ─────────────────────────────────────────────────────
// 외부 아이콘 패키지를 쓰지 않고 인라인 SVG로 둔다 (아이콘 테마 패키지는 수천
// 개의 SVG를 통째로 끌고 와 배포본이 MB 단위로 커진다). 모양은 카테고리가,
// 색은 `.tree-icon--<카테고리>` CSS 클래스가 담당한다.
type FileIconKind =
  | 'md'
  | 'bpmn'
  | 'form'
  | 'sheet'
  | 'word'
  | 'slide'
  | 'pdf'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'code'
  | 'data'
  | 'text'
  | 'file';

/// 모서리가 접힌 종이 — 확장자별 아이콘이 공유하는 바탕 도형.
const DOC_OUTLINE =
  '<path d="M3.75 1.75h5.5l3 3v9a.75.75 0 0 1-.75.75h-7.75a.75.75 0 0 1-.75-.75v-11.25a.75.75 0 0 1 .75-.75z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.25 1.75v3h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>';

/// 문서 바탕 위에 `inner` 글리프를 얹은 15px 아이콘을 만든다.
function docIcon(inner: string): string {
  return `<svg width="15" height="15" viewBox="0 0 16 16">${DOC_OUTLINE}${inner}</svg>`;
}

const FILE_ICON_SVG: Record<FileIconKind, string> = {
  md: SVG_FILE,
  bpmn: SVG_BPMN,
  form: SVG_FORM,
  // 표 격자 — 스프레드시트.
  sheet: docIcon(
    '<rect x="4.4" y="7.7" width="7.2" height="4.9" rx="0.5" fill="none" stroke="currentColor" stroke-width="1"/><path d="M4.4 10.15h7.2M8 7.7v4.9" stroke="currentColor" stroke-width="1"/>',
  ),
  // 문단 줄 — 워드프로세서 문서.
  word: docIcon(
    '<path d="M4.8 8.3h6.4M4.8 10.4h6.4M4.8 12.5h4.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  ),
  // 막대가 선 화면 — 프레젠테이션.
  slide: docIcon(
    '<rect x="4.4" y="7.8" width="7.2" height="4.8" rx="0.6" fill="none" stroke="currentColor" stroke-width="1"/><path d="M6.1 11.5V9.7M8 11.5V8.7M9.9 11.5v-1.3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>',
  ),
  // 채워진 띠 — PDF (적색과 함께 읽힌다).
  pdf: docIcon('<rect x="3.3" y="8.5" width="9.4" height="3.7" rx="0.8" fill="currentColor"/>'),
  // 해와 능선 — 이미지.
  image: docIcon(
    '<circle cx="6.1" cy="8.4" r="1" fill="currentColor"/><path d="M4.3 12.6l2.4-2.9 1.5 1.8 1.3-1.5 2.2 2.6z" fill="currentColor"/>',
  ),
  // 재생 삼각형 — 동영상.
  video: docIcon('<path d="M6.4 8.1l4.2 2.7-4.2 2.7z" fill="currentColor"/>'),
  // 음표 — 오디오.
  audio: docIcon(
    '<path d="M10.5 7.6v4.3" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/><path d="M10.5 7.6l1.4.5" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/><circle cx="9.2" cy="11.9" r="1.3" fill="currentColor"/>',
  ),
  // 지퍼 — 압축 파일.
  archive: docIcon(
    '<path d="M8 5.4v1.3M8 7.7v1.3M8 10v1.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><rect x="6.85" y="11.3" width="2.3" height="2.3" rx="0.6" fill="none" stroke="currentColor" stroke-width="1"/>',
  ),
  // 꺾쇠 — 소스 코드.
  code: docIcon(
    '<path d="M6.6 8.5L4.9 10.4l1.7 1.9M9.4 8.5l1.7 1.9-1.7 1.9" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/>',
  ),
  // 중괄호 — 구조화된 데이터.
  data: docIcon(
    '<path d="M6.8 7.9c-1 0-1 1.2-1 1.7s0 1.1-.8 1.1c.8 0 .8.6.8 1.1s0 1.7 1 1.7M9.2 7.9c1 0 1 1.2 1 1.7s0 1.1.8 1.1c-.8 0-.8.6-.8 1.1s0 1.7-1 1.7" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linecap="round"/>',
  ),
  // 가는 줄 — 서식 없는 텍스트.
  text: docIcon(
    '<path d="M4.9 8.5h6.2M4.9 10.5h6.2M4.9 12.5h3.4" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>',
  ),
  file: docIcon(''),
};

const FILE_ICON_BY_EXT: Record<string, FileIconKind> = {
  md: 'md',
  markdown: 'md',
  bpmn: 'bpmn',
  form: 'form',
  xls: 'sheet',
  xlsx: 'sheet',
  xlsm: 'sheet',
  ods: 'sheet',
  numbers: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  doc: 'word',
  docx: 'word',
  odt: 'word',
  rtf: 'word',
  hwp: 'word',
  hwpx: 'word',
  pages: 'word',
  ppt: 'slide',
  pptx: 'slide',
  odp: 'slide',
  key: 'slide',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  bmp: 'image',
  webp: 'image',
  svg: 'image',
  ico: 'image',
  heic: 'image',
  tif: 'image',
  tiff: 'image',
  psd: 'image',
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  webm: 'video',
  wmv: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  aac: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  '7z': 'archive',
  rar: 'archive',
  js: 'code',
  mjs: 'code',
  cjs: 'code',
  jsx: 'code',
  ts: 'code',
  tsx: 'code',
  py: 'code',
  rs: 'code',
  go: 'code',
  java: 'code',
  kt: 'code',
  swift: 'code',
  c: 'code',
  h: 'code',
  cpp: 'code',
  hpp: 'code',
  cs: 'code',
  rb: 'code',
  php: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  ps1: 'code',
  sql: 'code',
  html: 'code',
  htm: 'code',
  css: 'code',
  scss: 'code',
  vue: 'code',
  json: 'data',
  jsonc: 'data',
  yaml: 'data',
  yml: 'data',
  toml: 'data',
  xml: 'data',
  ini: 'data',
  env: 'data',
  lock: 'data',
  txt: 'text',
  log: 'text',
  rst: 'text',
  adoc: 'text',
};

/// 파일명 → 아이콘 카테고리. 확장자가 없거나 표에 없으면 기본 문서 아이콘.
function fileIconKind(name: string): FileIconKind {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'file';
  return FILE_ICON_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? 'file';
}

interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  /// mdview가 기본으로 다루는 종류인가 (md/markdown/bpmn/form). Rust
  /// `is_viewable_name`이 유일한 판정 기준이며, false면 트리에서 흐리게
  /// 표시하고 OS 기본 앱으로 넘긴다.
  viewable: boolean;
}
interface ScanDirResult {
  children: TreeNode[];
  truncated: boolean;
}
interface DeepDir {
  path: string;
  children: TreeNode[];
}
interface DeepScanResult {
  dirs: DeepDir[];
  truncated: boolean;
}
interface SearchMatch {
  line: number;
  text: string;
}
interface SearchFile {
  path: string;
  name: string;
  name_match: boolean;
  matches: SearchMatch[];
}
interface SearchResult {
  files: SearchFile[];
  truncated: boolean;
}

const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
const sidebarTitle = document.querySelector<HTMLElement>('#sidebar-title')!;
const treeEl = document.querySelector<HTMLElement>('#tree')!;
const btnTree = document.querySelector<HTMLButtonElement>('#btn-tree')!;
const sidebarOpenFolder = document.querySelector<HTMLButtonElement>('#sidebar-open-folder')!;
const btnReveal = document.querySelector<HTMLButtonElement>('#btn-reveal')!;
const btnHidden = document.querySelector<HTMLButtonElement>('#btn-hidden')!;

const PROJECT_KEY = 'mdview-project';
// 눈 아이콘 토글 — 두 축을 함께 넓힌다: 숨김(.으로 시작) 항목과, mdview가
// 직접 렌더하지 못하는 종류의 파일이 함께 트리에 나타난다. 트리 스캔·전체
// 펼치기·검색에 모두 적용된다 (검색은 md 본문만 뒤지므로 숨김 축만 반응).
// 키를 예전 'mdview-show-hidden'에서 바꾼 것은 의도적이다 — 의미가 넓어졌으니
// 기존 사용자가 갑자기 모든 파일을 보게 되는 대신 꺼진 상태로 시작한다.
const SHOW_ALL_KEY = 'mdview-show-all';
let showAll = localStorage.getItem(SHOW_ALL_KEY) === '1';
const SIDEBAR_HIDDEN_KEY = 'mdview-sidebar-hidden';
let projectRoot: string | null = null;
const expandedPaths = new Set<string>();
// Lazy tree: children are fetched per directory on expand (scan_dir), keyed by
// dir path (project root included). Entries persist across collapse so nested
// expand state survives; refreshTree rebuilds the map from root+expandedPaths.
const loadedChildren = new Map<string, TreeNode[]>();
// refreshTree/refreshDir 겹침 가드: await 후 세대가 바뀌었으면 결과를 버린다.
// (openProject/closeProject/각 refresh 시작이 세대를 올린다)
let treeRefreshSeq = 0;

async function scanDir(dir: string): Promise<ScanDirResult> {
  return await invoke<ScanDirResult>('scan_dir', { dir, showAll });
}

/// 사이드바만 숨긴다 — 프로젝트·watcher는 유지되어 트리는 계속 갱신된다.
function hideSidebar(): void {
  sidebar.hidden = true;
  document.body.classList.remove('project-open');
  localStorage.setItem(SIDEBAR_HIDDEN_KEY, '1');
}

function showSidebar(): void {
  if (!projectRoot) return;
  sidebar.hidden = false;
  document.body.classList.add('project-open');
  localStorage.removeItem(SIDEBAR_HIDDEN_KEY);
  updateTreeHighlight(true); // 다시 연 사이드바는 활성 파일이 보이게
}

/// silent: 시작 시 복원/드롭 판별 경로 — 실패해도 toast 없이 조용히 넘어간다.
/// record: 히스토리에 기록할지. 시작 시 복원만 false — 사용자가 연 게 아니라서
///   기록하면 앱을 켤 때마다 그 폴더가 최상단으로 튀어 실제 연 순서가 뒤섞인다.
///   (드롭은 silent지만 사용자 행동이라 기록한다 — 두 플래그는 관심사가 다르다)
/// lazy: 루트 한 단계만 스캔하고, 하위는 펼칠 때 scan_dir로 가져온다.
async function openProject(root: string, silent = false, record = true): Promise<void> {
  let res: ScanDirResult;
  try {
    res = await scanDir(root);
  } catch (e) {
    // 열 수 없는 폴더는 기록에 남길 이유가 없다 (record 여부와 무관).
    removeRecent(root);
    if (silent) {
      // 복원 대상 폴더가 사라진 경우: 기억을 지운다.
      if (localStorage.getItem(PROJECT_KEY) === root) {
        localStorage.removeItem(PROJECT_KEY);
      }
    } else {
      toast(`폴더 열기 실패: ${String(e)}`);
    }
    return;
  }
  if (projectRoot !== root) {
    // 새 프로젝트: 펼침 상태·로드 캐시 초기화.
    expandedPaths.clear();
    loadedChildren.clear();
  }
  projectRoot = root;
  treeRefreshSeq++; // 이전 프로젝트 대상 in-flight 갱신 무효화
  closeSearchPanel(); // 이전 범위로 열려 있던 검색 패널 정리 (트리 복귀)
  loadedChildren.set(root, res.children);
  if (res.truncated) toast('항목이 많아 트리를 일부만 표시합니다');
  sidebarTitle.textContent = root.split(/[/\\]/).pop() || root;
  sidebarTitle.title = root;
  showSidebar();
  renderTree();
  renderTabBar(); // 루트가 바뀌면 탭의 "폴더 밖" 배지도 다시 판정해야 한다
  localStorage.setItem(PROJECT_KEY, root);
  // pushRecent→saveRecents가 renderHistory를 부르지만, record=false 경로에선
  // 안 불리므로 폴더 active 강조를 위해 여기서도 명시적으로 갱신한다.
  if (record) pushRecent(root, 'folder');
  else renderHistory();
  try {
    await invoke('watch_dir', { root });
  } catch (e) {
    if (!silent) toast(`폴더 감시 실패: ${String(e)}`);
  }
}

function closeProject(): void {
  if (projectRoot) void invoke('unwatch_dir', { root: projectRoot });
  projectRoot = null;
  treeRefreshSeq++; // in-flight 갱신 무효화
  closeSearchPanel();
  expandedPaths.clear();
  loadedChildren.clear();
  treeEl.textContent = '';
  sidebar.hidden = true;
  document.body.classList.remove('project-open');
  localStorage.removeItem(PROJECT_KEY);
  localStorage.removeItem(SIDEBAR_HIDDEN_KEY);
  renderTabBar(); // 배지 제거 (프로젝트가 없으면 "밖"이 의미 없다) + 히스토리 갱신
}

/// tree-changed 수신 시 재스캔: 루트 + 펼쳐진 dir들만 병렬로 다시 읽는다.
/// 펼침 상태(expandedPaths)는 유지, 사라진 dir는 펼침에서 제거.
async function refreshTree(): Promise<void> {
  const root = projectRoot;
  if (!root) return;
  const seq = ++treeRefreshSeq;
  let rootRes: ScanDirResult;
  try {
    rootRes = await scanDir(root);
  } catch {
    if (seq !== treeRefreshSeq || projectRoot !== root) return;
    // 프로젝트 폴더 자체가 사라짐
    closeProject();
    return;
  }
  if (seq !== treeRefreshSeq || projectRoot !== root) return; // 갱신 겹침/교체
  // 보이는 펼침만 재스캔 — 접힌 조상 아래 펼침(딥 펼치기 잔존물 포함)은
  // 캐시를 유지한 채 미룬다.
  const dirs = [...expandedPaths].filter((d) => isVisiblyExpanded(root, d));
  const results = await Promise.all(
    dirs.map((d) => scanDir(d).catch(() => null)),
  );
  if (seq !== treeRefreshSeq || projectRoot !== root) return;
  const fresh = new Map<string, TreeNode[]>();
  fresh.set(root, rootRes.children);
  dirs.forEach((d, i) => {
    const r = results[i];
    if (r) fresh.set(d, r.children);
    else expandedPaths.delete(d); // dir가 사라짐
  });
  // 스캔 도중 toggleDir가 새로 펼쳐 로드한 dir는 스냅샷에 없다 — 지우면
  // "펼쳐졌는데 영영 빈" 상태가 되므로 그대로 살린다.
  for (const [k, v] of loadedChildren) {
    if (!fresh.has(k) && expandedPaths.has(k)) fresh.set(k, v);
  }
  loadedChildren.clear();
  for (const [k, v] of fresh) loadedChildren.set(k, v);
  renderTree();
}

/// `p`가 `base` 디렉토리의 (엄격한) 하위 경로인지. base의 뒤 구분자를 벗겨
/// 드라이브 루트(C:\)나 파일시스템 루트(/)도 맞고, 구분자 문자를 추측하지
/// 않아 POSIX에서 이름에 \가 든 폴더도 오판하지 않는다.
function isUnderDir(base: string, p: string): boolean {
  const b = base.replace(/[/\\]+$/, '');
  return p.startsWith(b) && /[/\\]/.test(p.charAt(b.length));
}

/// 탭의 외부 마커를 눌렀을 때 열 폴더. 파일의 직속 폴더보다, 히스토리에 남은
/// "이전에 열었던 프로젝트" 중 그 파일을 품는 것을 우선한다 — 하위 폴더의 문서
/// 하나를 열었다고 프로젝트 루트가 그 하위로 좁혀지면 트리가 쓸모없어진다.
/// 후보가 여럿이면 히스토리 순서(최신순) 첫 번째 = 가장 최근에 쓰던 프로젝트.
function bestFolderFor(path: string): string {
  const recent = loadRecents().find((e) => e.kind === 'folder' && isUnderDir(e.path, path));
  return recent ? recent.path : parentDir(path);
}

/// 경로의 상위 디렉토리. 구분자는 경로에서 판별한다(플랫폼 추측 금지).
/// 최상위(구분자가 하나뿐)면 루트를 그대로 돌려준다.
function parentDir(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const trimmed = p.replace(/[/\\]+$/, '');
  const i = trimmed.lastIndexOf(sep);
  if (i <= 0) return sep;
  return trimmed.slice(0, i);
}

/// d의 펼침이 화면에 실제로 보이는지: base(항상 표시)에 닿기까지의 모든 조상이
/// 펼쳐져 있어야 한다. 접힌 조상 아래는 렌더되지 않으니 재스캔도 미뤄서,
/// "하위 전체 펼치기" 후 접어둔 대형 서브트리가 tree-changed마다 전부
/// 재스캔되는 폭주를 막는다. (보이지 않는 펼침의 캐시는 유지 — 다시 보이면
/// 다음 tree-changed 때 재스캔으로 수렴한다.)
function isVisiblyExpanded(base: string, d: string): boolean {
  const baseN = base.replace(/[/\\]+$/, '');
  let cur = d;
  for (;;) {
    const next = cur
      .replace(/[/\\]+$/, '')
      .replace(/[^/\\]*$/, '')
      .replace(/[/\\]+$/, '');
    // base 도달(혹은 경계 밖/최상위 — 보수적으로 보임 취급)
    if (next === baseN || next === '' || next === cur) return true;
    if (!expandedPaths.has(next)) return false;
    cur = next;
  }
}

/// 컨텍스트 메뉴 "다시 읽기": 해당 dir + 그 아래 펼쳐진 dir만 재스캔.
/// 접힌 하위 dir 캐시는 버려서 다음 펼침 때 새로 읽게 한다.
async function refreshDir(path: string): Promise<void> {
  if (!projectRoot) return;
  if (path === projectRoot) {
    await refreshTree();
    return;
  }
  const seq = ++treeRefreshSeq;
  let res: ScanDirResult;
  try {
    res = await scanDir(path);
  } catch {
    if (seq !== treeRefreshSeq || !projectRoot) return;
    // dir 자체가 사라짐 — 부모까지 정리되도록 전체 갱신.
    await refreshTree();
    return;
  }
  if (seq !== treeRefreshSeq || !projectRoot) return;
  loadedChildren.set(path, res.children);
  const under = (p: string) => isUnderDir(path, p);
  for (const key of [...loadedChildren.keys()]) {
    if (under(key)) loadedChildren.delete(key);
  }
  // 보이는 펼침만 재스캔 (접힌 하위 캐시는 위에서 이미 버렸다).
  const subs = [...expandedPaths].filter((d) => under(d) && isVisiblyExpanded(path, d));
  const results = await Promise.all(subs.map((d) => scanDir(d).catch(() => null)));
  if (seq !== treeRefreshSeq || !projectRoot) return;
  subs.forEach((d, i) => {
    const r = results[i];
    if (r) loadedChildren.set(d, r.children);
    else expandedPaths.delete(d);
  });
  // 캐시가 사라졌는데 펼침으로 남은 dir(안 보여서 재스캔을 미룬 것들)는
  // "펼쳤는데 영영 빈" 행이 되지 않게 접어 둔다.
  for (const d of [...expandedPaths]) {
    if (under(d) && !loadedChildren.has(d)) expandedPaths.delete(d);
  }
  renderTree();
}

/// 컨텍스트 메뉴 "하위 전체 펼치기": lazy가 아니라 eager로 하위 전체를 한 번에
/// 재귀 스캔(scan_dir_deep)해 트리를 미리 완성한다. md 없는 폴더는 Rust가
/// prune해서 보낸다(미스캔 경계는 남김). 렌더 폭주를 막기 위해 펼침은 행
/// 예산까지만 — 나머지는 캐시만 채워 이후 수동 펼침이 즉시 되게 한다.
const EXPAND_ROW_MAX = 10_000;

async function expandDirDeep(path: string, retried = false): Promise<void> {
  if (!projectRoot) return;
  const seq = ++treeRefreshSeq;
  let res: DeepScanResult;
  try {
    res = await invoke<DeepScanResult>('scan_dir_deep', { dir: path, showAll });
  } catch {
    if (seq !== treeRefreshSeq || !projectRoot) return;
    // dir 자체가 사라짐 — 부모까지 정리되도록 전체 갱신.
    await refreshTree();
    return;
  }
  if (seq !== treeRefreshSeq || !projectRoot) {
    // 긴 스캔 동안 watcher 갱신과 겹쳐 무효화됨 — 사용자 명령이 소리 없이
    // 사라지지 않게 한 번만 재시도.
    if (!retried && projectRoot) void expandDirDeep(path, true);
    return;
  }
  // 기존 하위 캐시는 이번 스냅샷으로 통째로 교체 (사라진 dir 캐시 정리 겸).
  for (const key of [...loadedChildren.keys()]) {
    if (isUnderDir(path, key)) loadedChildren.delete(key);
  }
  // 클릭한 폴더는 무조건 펼친다 — 유효 파일이 없어도 "md/bpmn 파일 없음"으로 응답이 보이게.
  if (path !== projectRoot) expandedPaths.add(path);
  let rows = 0;
  let expandSkipped = false;
  for (const d of res.dirs) {
    loadedChildren.set(d.path, d.children);
    if (d.path === path || d.path === projectRoot) {
      rows += d.children.length;
      continue;
    }
    // BFS(얕은 곳 우선) 순서로 행 예산까지만 펼친다.
    if (rows + d.children.length > EXPAND_ROW_MAX) {
      expandSkipped = true;
      continue;
    }
    rows += d.children.length;
    if (d.children.length > 0) expandedPaths.add(d.path);
  }
  // 캐시 없는 펼침 상태는 "펼쳤는데 영영 빈" 행이 되므로 접어 둔다
  // (잘린 스캔 경계 밖이거나 prune으로 사라진, 이전에 펼쳐뒀던 dir).
  for (const d of [...expandedPaths]) {
    if (isUnderDir(path, d) && !loadedChildren.has(d)) expandedPaths.delete(d);
  }
  if (res.truncated) toast('항목이 많아 하위 일부만 읽었습니다');
  else if (expandSkipped) toast('항목이 많아 일부만 펼쳤습니다');
  renderTree();
}

/// 빈 폴더 안내 문구. 눈 아이콘이 켜져 있으면 종류로 거른 것이 없으므로
/// 정말로 파일이 하나도 없다는 뜻이 된다.
function emptyTreeText(): string {
  return showAll ? '파일 없음' : 'md/bpmn/form 파일 없음';
}

/// 파일·폴더 우클릭 메뉴가 공유하는 OS 연동 항목들.
function osMenuEntries(path: string): CtxEntry[] {
  return [
    { label: `${fileManagerName()}에서 보기`, action: () => void revealInFileManager(path) },
    { label: '터미널에서 열기', action: () => void openInTerminal(path) },
    { label: '경로 복사', action: () => void copyPathToClipboard(path) },
  ];
}

function openDirMenu(e: MouseEvent, path: string): void {
  openCtxMenu(e, [
    { label: '이 폴더에서 검색', action: () => openSearchPanel(path) },
    'sep',
    { label: '하위 전체 펼치기', action: () => void expandDirDeep(path) },
    { label: '다시 읽기', action: () => void refreshDir(path) },
    'sep',
    ...osMenuEntries(path),
  ]);
}

/// 트리의 파일 행 우클릭 메뉴. `inApp`이 false면 mdview 안에서 렌더할 수 없는
/// 파일이므로 "mdview로 열기"는 비활성으로 남겨 둔다 (숨기지 않는 것은 이
/// 메뉴 전체의 관례를 따른 것이다).
function openFileMenu(e: MouseEvent, path: string, inApp: boolean): void {
  openCtxMenu(e, [
    { label: 'mdview로 열기', enabled: inApp, action: () => void openTabFromPath(path) },
    { label: '기본 앱으로 열기', action: () => void openWithDefaultApp(path) },
    'sep',
    ...osMenuEntries(path),
  ]);
}

function renderTree(): void {
  // 전체 재구축이라 내용이 비는 순간 scrollTop이 0으로 클램프된다 —
  // 보던 위치를 저장했다가 복원 (폴더 토글 때 시점이 튀지 않게).
  const scrollTop = treeEl.scrollTop;
  treeEl.textContent = '';
  if (!projectRoot) return;
  const rootChildren = loadedChildren.get(projectRoot);
  if (!rootChildren || rootChildren.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = emptyTreeText();
    treeEl.appendChild(empty);
    return;
  }
  treeEl.appendChild(buildTreeChildren(rootChildren));
  updateTreeHighlight(); // 스크롤 없이 하이라이트만
  treeEl.scrollTop = scrollTop;
}

/// dir 펼침 토글. 접힘→펼침에서 자식이 아직 없으면 scan_dir로 lazy 로드.
async function toggleDir(path: string): Promise<void> {
  if (expandedPaths.has(path)) {
    expandedPaths.delete(path);
    renderTree();
    return;
  }
  expandedPaths.add(path);
  renderTree(); // 즉시 chevron 회전 (자식은 로드 후 표시)
  if (!loadedChildren.has(path)) {
    let res: ScanDirResult;
    try {
      res = await scanDir(path);
    } catch {
      // dir가 사라졌거나 읽기 실패 — 펼침 취소.
      expandedPaths.delete(path);
      renderTree();
      return;
    }
    // 로드 중 프로젝트가 닫혔거나 다시 접힌 경우는 버린다.
    if (!projectRoot || !expandedPaths.has(path)) return;
    loadedChildren.set(path, res.children);
    if (res.truncated) toast('항목이 많아 트리를 일부만 표시합니다');
  }
  renderTree();
}

function buildTreeChildren(nodes: TreeNode[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'tree-children';
  for (const n of nodes) {
    const row = document.createElement('div');
    row.className = 'tree-row ' + (n.is_dir ? 'tree-dir' : 'tree-file');
    row.dataset.path = n.path;
    row.title = n.path;

    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron';
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = n.name;
    row.appendChild(chevron);
    row.appendChild(icon);
    row.appendChild(label);
    wrap.appendChild(row);

    if (n.is_dir) {
      const expanded = expandedPaths.has(n.path);
      chevron.innerHTML = SVG_CHEVRON;
      icon.innerHTML = SVG_FOLDER;
      if (expanded) row.classList.add('expanded');
      row.addEventListener('click', () => {
        void toggleDir(n.path);
      });
      // stopPropagation: window의 contextmenu 정리 리스너가 메뉴를 도로 닫는 것 방지.
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openDirMenu(e, n.path);
      });
      if (expanded) {
        const kids = loadedChildren.get(n.path);
        if (kids && kids.length > 0) {
          wrap.appendChild(buildTreeChildren(kids));
        } else if (kids) {
          // lazy 스캔은 pruning이 없어 md 없는 폴더도 열린다 — 빈 표시.
          const emptyWrap = document.createElement('div');
          emptyWrap.className = 'tree-children';
          const empty = document.createElement('div');
          empty.className = 'tree-empty';
          empty.textContent = emptyTreeText();
          emptyWrap.appendChild(empty);
          wrap.appendChild(emptyWrap);
        }
        // kids 미로드(로딩 중)면 chevron만 회전한 상태로 대기.
      }
    } else {
      const kind = fileIconKind(n.name);
      icon.className = 'tree-icon tree-icon--' + kind;
      icon.innerHTML = FILE_ICON_SVG[kind];
      // 앱 안에서 렌더되는가. .bpmn은 정식으로 나열되는 종류(viewable)지만
      // 전용 뷰어가 없어 OS 기본 앱으로 넘기므로 여기서만 예외로 뺀다.
      const inApp = n.viewable && kind !== 'bpmn';
      // mdview가 다루지 않는 종류는 흐리게 — 트리에서 한눈에 구분된다.
      if (!n.viewable) row.classList.add('tree-row--external');
      row.addEventListener('click', () => {
        if (inApp) void openTabFromPath(n.path);
        else void openWithDefaultApp(n.path);
      });
      // stopPropagation: window의 contextmenu 정리 리스너가 메뉴를 도로 닫는 것 방지.
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFileMenu(e, n.path, inApp);
      });
    }
  }
  return wrap;
}

/// 활성 탭 파일을 트리에서 하이라이트. renderTabBar()가 탭 변화마다 호출.
/// scroll: 활성 행으로 스크롤할지 — 탭 전환/사이드바 재표시처럼 "활성 파일을
/// 보여줘야 하는" 경우만 true. 폴더 토글 등 일반 재렌더에서 true면 사용자가
/// 보던 위치가 활성 파일로 끌려가 시점이 왔다갔다한다.
function updateTreeHighlight(scroll = false): void {
  if (sidebar.hidden) return;
  for (const el of treeEl.querySelectorAll<HTMLElement>('.tree-row.active')) {
    el.classList.remove('active');
  }
  if (!activePath) return;
  const row = treeEl.querySelector<HTMLElement>(
    `.tree-file[data-path="${CSS.escape(activePath)}"]`,
  );
  if (row) {
    row.classList.add('active');
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }
}

/// 과녁 버튼: 활성 문서를 트리에서 드러낸다 — 루트까지의 조상 dir를 모두
/// 펼치고(미로드분은 scan_dir로 lazy 로드) 트리 탭으로 전환, 해당 행으로 스크롤.
/// retried: 로드 중 refreshTree가 캐시를 갈아엎어(세대 변경) 조상 캐시가
/// 증발한 경우 한 번만 재시도 (expandDirDeep과 동일한 패턴).
async function revealActiveInTree(retried = false): Promise<void> {
  const path = activePath;
  const root = projectRoot;
  if (!path || !root) return;
  if (!isUnderDir(root, path)) {
    toast('현재 문서가 프로젝트 폴더 밖에 있습니다');
    return;
  }
  if (sidebar.hidden) showSidebar();
  showTreeTab();
  // 파일 → 루트 직전까지의 조상 dir 체인 (경로 문자열로 계산, 구분자 무추측).
  const rootN = root.replace(/[/\\]+$/, '');
  const dirs: string[] = [];
  let cur = path;
  for (;;) {
    const parent = cur
      .replace(/[/\\]+$/, '')
      .replace(/[^/\\]*$/, '')
      .replace(/[/\\]+$/, '');
    if (parent === rootN || parent === '' || parent === cur) break;
    dirs.unshift(parent);
    cur = parent;
  }
  const seq = treeRefreshSeq;
  const missing = dirs.filter((d) => !loadedChildren.has(d));
  if (missing.length > 0) {
    const results = await Promise.all(missing.map((d) => scanDir(d).catch(() => null)));
    // 로드 중 프로젝트 교체/닫힘, 활성 탭 변경, 검색 탭 전환 — 이 reveal은 무효.
    if (projectRoot !== root || activePath !== path || treeEl.hidden) return;
    let truncated = false;
    missing.forEach((d, i) => {
      const r = results[i];
      if (r) {
        loadedChildren.set(d, r.children);
        if (r.truncated) truncated = true;
      }
    });
    if (truncated) toast('항목이 많아 트리를 일부만 표시합니다');
  }
  // 로드 중 refreshTree/refreshDir가 겹쳐 조상 캐시가 증발했을 수 있다
  // (expanded도 아니고 보이지도 않던 dir는 스냅샷에서 빠진다) — 재시도.
  if (treeRefreshSeq !== seq && dirs.some((d) => !loadedChildren.has(d))) {
    if (!retried) void revealActiveInTree(true);
    return;
  }
  // 캐시가 확보된 dir만 펼친다 (스캔 실패 dir를 펼치면 "영영 빈" 행이 된다).
  for (const d of dirs) {
    if (loadedChildren.has(d)) expandedPaths.add(d);
  }
  renderTree();
  updateTreeHighlight(true);
  flashTreeRow(path); // 이미 다 펼쳐져 있던 경우에도 "찾았다"는 피드백
}

/// reveal 피드백: 대상 행을 잠깐 펄스시킨다 (클릭해도 변화가 안 보이는
/// "이미 보이던 파일" 케이스에서 특히 필요).
function flashTreeRow(path: string): void {
  const row = treeEl.querySelector<HTMLElement>(
    `.tree-file[data-path="${CSS.escape(path)}"]`,
  );
  if (!row) return;
  row.classList.remove('reveal-flash');
  void row.offsetWidth; // 연타 시 애니메이션 재시작을 위한 리플로우
  row.classList.add('reveal-flash');
  row.addEventListener('animationend', () => row.classList.remove('reveal-flash'), {
    once: true,
  });
}

btnReveal.addEventListener('click', () => void revealActiveInTree());

// 모든 파일 표시 토글 — 상태를 저장하고 트리를 다시 스캔하며, 열려 있던
// 검색 결과도 새 기준으로 다시 실행한다.
btnHidden.classList.toggle('active', showAll);
btnHidden.addEventListener('click', () => {
  showAll = !showAll;
  if (showAll) localStorage.setItem(SHOW_ALL_KEY, '1');
  else localStorage.removeItem(SHOW_ALL_KEY);
  btnHidden.classList.toggle('active', showAll);
  if (projectRoot) void refreshTree();
  void runPanelSearch();
});

// ☰ 하나로 통합: 프로젝트 없으면 폴더 선택, 있으면 트리 토글.
btnTree.addEventListener('click', async () => {
  if (projectRoot) {
    if (sidebar.hidden) showSidebar();
    else hideSidebar();
    return;
  }
  const sel = await open({ directory: true });
  if (typeof sel === 'string') {
    await openProject(sel);
  }
});

sidebarOpenFolder.addEventListener('click', async () => {
  const sel = await open({ directory: true });
  if (typeof sel === 'string') {
    await openProject(sel);
  }
});

// 사이드바 타이틀(프로젝트 루트) 우클릭 → 루트 범위 검색/다시 읽기.
sidebarTitle.addEventListener('contextmenu', (e) => {
  if (!projectRoot) return;
  e.preventDefault();
  e.stopPropagation();
  openDirMenu(e, projectRoot);
});

// ── 폴더 하위 전체 검색 패널 ──────────────────────────────────────────────────
// 트리 dir 우클릭 "이 폴더에서 검색" → #tree 자리를 패널이 대신한다.
// 검색은 Rust search_dir(재귀, 대소문자 무시)로 하고, 결과 클릭 시 탭을 열며
// 문서 내 찾기(⌘F 위젯)를 같은 질의어로 열어 하이라이트한다.
const searchPanel = document.querySelector<HTMLElement>('#search-panel')!;
const spScopeEl = document.querySelector<HTMLElement>('#sp-scope')!;
const stabTree = document.querySelector<HTMLButtonElement>('#stab-tree')!;
const stabSearch = document.querySelector<HTMLButtonElement>('#stab-search')!;
const spInput = document.querySelector<HTMLInputElement>('#sp-input')!;
const spStatus = document.querySelector<HTMLElement>('#sp-status')!;
const spResults = document.querySelector<HTMLElement>('#sp-results')!;

let spScope: string | null = null;
let spSeq = 0; // 응답 역전 가드: 마지막 질의의 응답만 반영
let spTimer: number | undefined;

function updateSidebarTabs(searchActive: boolean): void {
  stabTree.classList.toggle('active', !searchActive);
  stabSearch.classList.toggle('active', searchActive);
  stabTree.setAttribute('aria-selected', String(!searchActive));
  stabSearch.setAttribute('aria-selected', String(searchActive));
}

function openSearchPanel(scope: string): void {
  spScope = scope;
  spSeq++; // 같은 scope 재열기 시 in-flight 응답이 빈 입력 위에 그려지는 것 방지
  clearTimeout(spTimer);
  spScopeEl.textContent = scope.split(/[/\\]/).pop() || scope;
  spScopeEl.title = scope;
  spInput.value = '';
  spStatus.textContent = '';
  showSpHint('2자 이상 입력하세요');
  treeEl.hidden = true;
  searchPanel.hidden = false;
  updateSidebarTabs(true);
  spInput.focus();
}

/// 검색 상태(범위·질의·결과)까지 완전히 버린다 — 프로젝트 전환/닫기 전용.
/// 단순 탭 전환은 showTreeTab()로: 상태를 유지한 채 표시만 바꾼다.
function closeSearchPanel(): void {
  if (spScope === null) {
    showTreeTab();
    return;
  }
  spScope = null;
  spSeq++; // 진행 중인 응답 무효화
  clearTimeout(spTimer);
  showTreeTab();
}

function showTreeTab(): void {
  searchPanel.hidden = true;
  treeEl.hidden = false;
  updateSidebarTabs(false);
  updateTreeHighlight();
}

function showSearchTab(): void {
  if (!projectRoot) return;
  if (spScope === null) {
    // 첫 열기: 기본 범위는 프로젝트 루트.
    openSearchPanel(projectRoot);
    return;
  }
  treeEl.hidden = true;
  searchPanel.hidden = false;
  updateSidebarTabs(true);
  spInput.focus();
}

stabTree.addEventListener('click', showTreeTab);
stabSearch.addEventListener('click', showSearchTab);

function showSpHint(msg: string): void {
  spResults.textContent = '';
  const hint = document.createElement('div');
  hint.className = 'sp-empty';
  hint.textContent = msg;
  spResults.appendChild(hint);
}

/** 텍스트에서 질의어를 <mark>로 감싼 fragment 생성 (텍스트 노드 기반 — 주입 안전). */
function buildHighlighted(text: string, query: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  let at = lower.indexOf(needle);
  while (at !== -1) {
    if (at > from) frag.appendChild(document.createTextNode(text.slice(from, at)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + needle.length);
    frag.appendChild(mark);
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }
  if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
  return frag;
}

/** 결과 클릭: 파일 열고 문서 내 찾기를 같은 질의어로 연다. */
async function openSearchHit(path: string, query: string): Promise<void> {
  try {
    await openTabFromPath(path);
  } catch (err) {
    console.error('openSearchHit failed:', path, err);
    toast(`파일 열기 실패: ${err}`);
    return;
  }
  searchInput.value = query;
  openSearchBar();
}

function renderSearchResults(res: SearchResult, query: string, scope: string): void {
  spResults.textContent = '';
  if (res.files.length === 0) {
    spStatus.textContent = '';
    showSpHint('결과 없음');
    return;
  }
  const totalHits = res.files.reduce((n, f) => n + f.matches.length, 0);
  spStatus.textContent =
    `파일 ${res.files.length}개 · 매치 ${totalHits}개` +
    (res.truncated ? ' — 일부만 표시' : '');
  const scopeBase = scope.replace(/[/\\]+$/, '');
  for (const f of res.files) {
    const fileEl = document.createElement('div');
    fileEl.className = 'sp-file';

    const head = document.createElement('button');
    head.className = 'sp-file-head';
    head.title = f.path;
    const name = document.createElement('span');
    name.className = 'sp-file-name';
    if (f.name_match) name.appendChild(buildHighlighted(f.name, query));
    else name.textContent = f.name;
    const dir = document.createElement('span');
    dir.className = 'sp-file-dir';
    // scope 아래 상대 디렉토리 (파일명 제외). scope 직속이면 빈 문자열.
    // 구분자 추측 없이 원 경로의 구분자를 보존한다 (드라이브 루트 C:\, / 포함).
    const rel = isUnderDir(scopeBase, f.path) ? f.path.slice(scopeBase.length + 1) : f.path;
    dir.textContent = rel.replace(/[^/\\]+$/, '').replace(/[/\\]+$/, '');
    head.appendChild(name);
    head.appendChild(dir);
    head.addEventListener('click', () => void openSearchHit(f.path, query));
    fileEl.appendChild(head);

    for (const m of f.matches) {
      const hit = document.createElement('button');
      hit.className = 'sp-hit';
      const line = document.createElement('span');
      line.className = 'sp-line';
      line.textContent = String(m.line);
      const text = document.createElement('span');
      text.className = 'sp-text';
      text.appendChild(buildHighlighted(m.text, query));
      hit.appendChild(line);
      hit.appendChild(text);
      hit.addEventListener('click', () => void openSearchHit(f.path, query));
      fileEl.appendChild(hit);
    }
    spResults.appendChild(fileEl);
  }
}

async function runPanelSearch(): Promise<void> {
  const scope = spScope;
  if (!scope) return;
  const q = spInput.value.trim();
  if (q.length < 2) {
    spStatus.textContent = '';
    showSpHint('2자 이상 입력하세요');
    return;
  }
  const seq = ++spSeq;
  spStatus.textContent = '검색 중…';
  let res: SearchResult;
  try {
    res = await invoke<SearchResult>('search_dir', { root: scope, query: q, showAll });
  } catch (e) {
    if (seq !== spSeq || spScope !== scope) return;
    spStatus.textContent = '';
    showSpHint(`검색 실패: ${String(e)}`);
    return;
  }
  if (seq !== spSeq || spScope !== scope) return; // 늦게 온 옛 응답은 버린다
  renderSearchResults(res, q, scope);
}

spInput.addEventListener('input', () => {
  clearTimeout(spTimer);
  spTimer = window.setTimeout(() => void runPanelSearch(), 250);
});
spInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation(); // 전역 Esc 핸들러(문서 내 찾기 닫기)와 충돌 방지
    showTreeTab(); // 검색 상태는 유지 — 검색 탭으로 돌아오면 그대로
  } else if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(spTimer);
    void runPanelSearch();
  }
});

// ── 사이드바 리사이즈 (드래그) ─────────────────────────────────────────────────
const SIDEBAR_W_KEY = 'mdview-sidebar-width';
const SIDEBAR_W_MIN = 160;
const SIDEBAR_W_MAX = 480;
const sidebarResize = document.querySelector<HTMLElement>('#sidebar-resize')!;

function applySidebarWidth(px: number): void {
  const w = Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, Math.round(px)));
  document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
}

// 저장된 폭 복원 (프로젝트 여부와 무관 — CSS 변수만 세팅)
const savedW = Number(localStorage.getItem(SIDEBAR_W_KEY));
if (savedW) applySidebarWidth(savedW);

// 우측 엣지 드래그 리사이즈 — HTML5 DnD는 dragDropEnabled가 삼키므로 pointer 이벤트 사용
sidebarResize.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sidebarResize.setPointerCapture(e.pointerId);
  document.body.classList.add('sidebar-resizing');
  const onMove = (ev: PointerEvent) => applySidebarWidth(ev.clientX);
  const cleanup = () => {
    sidebarResize.removeEventListener('pointermove', onMove);
    sidebarResize.removeEventListener('pointerup', onUp);
    sidebarResize.removeEventListener('pointercancel', onCancel);
    document.body.classList.remove('sidebar-resizing');
  };
  const persistWidth = () => {
    const cur = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w');
    localStorage.setItem(SIDEBAR_W_KEY, String(parseInt(cur, 10) || 240));
  };
  const onUp = (ev: PointerEvent) => {
    cleanup();
    applySidebarWidth(ev.clientX);
    persistWidth();
  };
  // 드래그 중 취소(제스처 인터럽트 등) 시에도 리스너·클래스가 남지 않도록 정리한다.
  const onCancel = () => {
    cleanup();
    persistWidth();
  };
  sidebarResize.addEventListener('pointermove', onMove);
  sidebarResize.addEventListener('pointerup', onUp);
  sidebarResize.addEventListener('pointercancel', onCancel);
});

// ── Theme init (before first render) ─────────────────────────────────────────
function onThemeChange(effective: EffectiveTheme): void {
  effectiveTheme = effective;
  // Re-render mermaid from active tab's stored blocks; HTML stays
  const activeTab = activePath ? findTab(activePath) : null;
  const blocks = activeTab ? activeTab.blocks : [];
  void renderAllMermaid(blocks, effective === 'dark' ? 'dark' : 'default');
  setSourceTheme(effective);
}

effectiveTheme = initTheme(onThemeChange);
updateThemeButtons();
applyFontSize();
renderHistory();

// ── Startup ───────────────────────────────────────────────────────────────────
async function startTauri(): Promise<void> {
  // Register listeners before querying initial file
  await listen<{ path: string }>('file-opened', (e) => {
    void openTabFromPath(e.payload.path);
  });
  await listen<{ path: string }>('file-changed', (e) => {
    void reloadTab(e.payload.path);
  });
  await listen<{ ok: boolean; path: string; error: string | null }>('pdf-exported', (e) => {
    finishPdfExport(e.payload.ok, e.payload.path, e.payload.error);
  });
  // Scripted smoke hook (MDVIEW_PDF_EXPORT_TEST) — full export flow, no dialog.
  await listen<{ path: string }>('pdf-export-test', (e) => {
    void exportPdf(e.payload.path);
  });
  // Scripted smoke hook (MDVIEW_PROJECT_TEST) — open a folder as project, no dialog.
  await listen<{ path: string }>('project-open-test', (e) => {
    void openProject(e.payload.path);
  });
  await listen('tree-changed', () => {
    void refreshTree();
  });

  // Polling fallback: environments where the notify watcher delivers no
  // events (network drives, some Windows setups). mtime comparison keeps it
  // idempotent with watcher-driven reloads (reloadTab refreshes tab.mtime).
  const POLL_MS = 2000;
  setInterval(() => {
    for (const tab of tabs) {
      void fetchMtime(tab.path).then((m) => {
        if (m !== null && tab.mtime !== undefined && m !== tab.mtime) {
          void reloadTab(tab.path);
        }
      });
    }
  }, POLL_MS);

  // Drag-drop
  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'drop') {
      for (const p of event.payload.paths) {
        if (/\.(md|markdown|form)$/i.test(p)) {
          void openTabFromPath(p);
        } else if (/\.bpmn$/i.test(p)) {
          openPath(p).catch((err) => {
            console.error('openPath failed:', p, err);
            toast(`열기 실패: ${err}`);
          });
        } else {
          // md/bpmn이 아니면 폴더로 시도 — scan_dir가 디렉토리 판별.
          // 파일 등 실패 케이스는 조용히 무시(silent).
          void openProject(p, true);
        }
      }
    }
  });

  // "+" open button → dialog
  btnOpen.addEventListener('click', async () => {
    const sel = await open({
      multiple: true,
      filters: [{ name: 'Markdown / Form', extensions: ['md', 'markdown', 'form'] }],
    });
    if (sel === null) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    for (const p of paths) {
      await openTabFromPath(p);
    }
  });

  // 이전 세션의 탭 복원 → 더블클릭/CLI로 넘어온 파일은 그 위에 얹어 활성화.
  await restoreSession();
  const initial = await invoke<string[]>('get_initial_file');
  for (const p of initial) {
    await openTabFromPath(p);
  }
  if (tabs.length === 0) {
    await renderActive(); // show placeholder
  }

  // 마지막 프로젝트 복원 (폴더가 사라졌으면 openProject가 조용히 기억을 지움)
  const savedProject = localStorage.getItem(PROJECT_KEY);
  if (savedProject) {
    // openProject의 showSidebar()가 플래그를 지우므로 호출 전에 스냅샷
    const wasHidden = localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1';
    await openProject(savedProject, true, false); // 복원은 기록하지 않는다
    if (wasHidden) hideSidebar();
  }
}

// form-js 블록 편집 저장: fence 본문 교체 → 파일 쓰기 → 재렌더.
// 파일 쓰기가 watcher를 깨우지만 reload 내용이 tab.content와 같아 무해(중복 렌더 1회).
setFormBlockSaveHandler(async (blockIdx, newJson) => {
  if (activePath === null) return;
  const tab = findTab(activePath);
  if (!tab) return;
  const updated = replaceFormFence(tab.content, blockIdx, newJson);
  if (updated === null) {
    toast('form-js 블록 저장 실패: 원본에서 블록을 찾지 못했습니다');
    return;
  }
  tab.content = updated;
  if (isTauri) {
    try {
      await invoke('write_file', { path: activePath, content: updated });
      tab.mtime = (await fetchMtime(activePath)) ?? tab.mtime;
    } catch (e) {
      toast(`form-js 블록 저장 실패: ${String(e)}`);
      return;
    }
  }
  await renderActive();
  toast('form-js 블록 저장됨');
});

if (isTauri) {
  void startTauri();
} else {
  // Chrome dev harness: hide + button, load fixture
  btnOpen.style.display = 'none';
  btnTree.style.display = 'none';
  _addTab('sample.md', sample);
  void activate('sample.md');
}


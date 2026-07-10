import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl, openPath } from '@tauri-apps/plugin-opener';
import { writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import mermaid from 'mermaid';
import sample from './fixtures/sample.md?raw';
import { renderMarkdown } from './render';
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
const btnCopyPath = document.querySelector<HTMLButtonElement>('#btn-copy-path')!;
const btnPdf = document.querySelector<HTMLButtonElement>('#btn-pdf')!;
const btnRecent = document.querySelector<HTMLButtonElement>('#btn-recent')!;
const recentMenu = document.querySelector<HTMLElement>('#recent-menu')!;
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
  if (/\.(md|markdown)$/i.test(resolved)) {
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
    } catch (e) {
      el.innerHTML = `<pre class="mermaid-error">mermaid error: ${String(e)}</pre>`;
    }
  }
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

  // Page 1's content must start below its header band.
  content.style.paddingTop = `${band}px`;

  // Push blocks out of footer/header bands (recurse into too-tall blocks).
  const usableH = pageH - band * 2;
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
      if (r.height <= usableH) {
        const sp = document.createElement('div');
        sp.className = 'pdf-decoration';
        sp.style.height = `${(page + 1) * pageH + band - top}px`;
        el.parentElement!.insertBefore(sp, el);
      } else {
        pushBlocks(el); // taller than a page: try its children
      }
    }
  };
  pushBlocks(content);

  // Header (title) + footer (page number) bands, absolutely positioned in
  // document coordinates — they land exactly inside each sliced page.
  const docH = document.documentElement.scrollHeight;
  const pages = Math.max(1, Math.ceil(docH / pageH));
  for (let k = 0; k < pages; k++) {
    const header = document.createElement('div');
    header.className = 'pdf-decoration pdf-page-band';
    header.style.top = `${k * pageH}px`;
    header.style.height = `${band}px`;
    header.textContent = title;
    const footer = document.createElement('div');
    footer.className = 'pdf-decoration pdf-page-band';
    footer.style.top = `${(k + 1) * pageH - band}px`;
    footer.style.height = `${band}px`;
    footer.textContent = `${k + 1} / ${pages}`;
    document.body.append(header, footer);
  }
}

function removePdfDecorations(): void {
  document.querySelectorAll('.pdf-decoration').forEach((el) => el.remove());
  content.style.paddingTop = '';
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
    const defaultName = tab.title.replace(/\.(md|markdown)$/i, '') + '.pdf';
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

// ── Copy full path ────────────────────────────────────────────────────────────
/** Enable the copy-path button only when a document is open. */
function updateCopyPathBtn(): void {
  btnCopyPath.disabled = activePath === null;
}

btnCopyPath.addEventListener('click', async () => {
  if (activePath === null) return;
  try {
    // Under Tauri use the clipboard-manager plugin: navigator.clipboard.writeText
    // resolves but silently fails to write in WKWebView, so the path never lands
    // on the system clipboard. Fall back to the web API in the browser harness.
    if (isTauri) {
      await clipboardWriteText(activePath);
    } else {
      await navigator.clipboard.writeText(activePath);
    }
    toast('경로 복사됨: ' + activePath);
  } catch (err) {
    console.error('clipboard write failed:', err);
    toast('경로 복사 실패: ' + err);
  }
});

// ── Recent files ──────────────────────────────────────────────────────────────
// Persist the most-recently-opened paths in localStorage (most-recent first,
// deduped, capped). Only meaningful under Tauri where paths are real files.
const RECENTS_KEY = 'mdview-recents';
const RECENTS_MAX = 10;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecents(list: string[]): void {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
}

/** Record `path` as the most-recent entry (dedup, cap). */
function pushRecent(path: string): void {
  const list = loadRecents().filter((p) => p !== path);
  list.unshift(path);
  saveRecents(list);
}

/** Drop `path` from the recents list (e.g. it no longer exists). */
function removeRecent(path: string): void {
  saveRecents(loadRecents().filter((p) => p !== path));
}

let recentOpen = false;

function closeRecentMenu(): void {
  recentOpen = false;
  recentMenu.hidden = true;
  btnRecent.classList.remove('active');
}

function buildRecentMenu(): void {
  recentMenu.innerHTML = '';
  const list = loadRecents();
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.textContent = '최근 항목 없음';
    recentMenu.appendChild(empty);
    return;
  }
  for (const path of list) {
    const item = document.createElement('button');
    item.className = 'recent-item';
    item.title = path;

    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = path.split(/[/\\]/).pop() || path;

    const dir = document.createElement('span');
    dir.className = 'recent-path';
    dir.textContent = path;

    item.appendChild(name);
    item.appendChild(dir);
    item.addEventListener('click', () => {
      closeRecentMenu();
      openTabFromPath(path).catch((err) => {
        console.error('open recent failed:', path, err);
        toast('파일 열기 실패 (목록서 제거): ' + path);
        removeRecent(path);
      });
    });
    recentMenu.appendChild(item);
  }

  const clear = document.createElement('button');
  clear.className = 'recent-clear';
  clear.textContent = '목록 지우기';
  clear.addEventListener('click', () => {
    saveRecents([]);
    buildRecentMenu();
  });
  recentMenu.appendChild(clear);
}

function openRecentMenu(): void {
  buildRecentMenu();
  // Anchor under the button, right edge aligned to the button's right edge
  // (the button sits at the far right of the toolbar, so a left-anchored menu
  // would overflow off the right side of the window).
  const r = btnRecent.getBoundingClientRect();
  recentMenu.style.top = r.bottom + 4 + 'px';
  recentMenu.style.left = 'auto';
  recentMenu.style.right = window.innerWidth - r.right + 'px';
  recentMenu.hidden = false;
  recentOpen = true;
  btnRecent.classList.add('active');
}

btnRecent.addEventListener('click', (e) => {
  e.stopPropagation();
  if (recentOpen) closeRecentMenu();
  else openRecentMenu();
});

// Close on outside click / Esc.
document.addEventListener('click', (e) => {
  if (recentOpen && !recentMenu.contains(e.target as Node)) closeRecentMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recentOpen) closeRecentMenu();
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
  updateCopyPathBtn();
  updateTreeHighlight();
}

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
  const { html, blocks } = renderMarkdown(tab.content);
  content.innerHTML = html;
  rewriteAssetSrcs(content);
  tab.blocks = blocks;
  applyFontSize();
  await renderAllMermaid(blocks, effectiveTheme === 'dark' ? 'dark' : 'default');
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
  const tab: Tab = { path, title, content: tabContent, blocks: [], scrollY: 0, mtime: 0 };
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
  if (!/\.(md|markdown)$/i.test(path)) return;
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

interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeNode[];
}
interface ScanResult {
  tree: TreeNode;
  truncated: boolean;
}

const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
const sidebarTitle = document.querySelector<HTMLElement>('#sidebar-title')!;
const sidebarClose = document.querySelector<HTMLButtonElement>('#sidebar-close')!;
const treeEl = document.querySelector<HTMLElement>('#tree')!;
const btnOpenFolder = document.querySelector<HTMLButtonElement>('#btn-open-folder')!;

const PROJECT_KEY = 'mdview-project';
const SIDEBAR_HIDDEN_KEY = 'mdview-sidebar-hidden';
let projectRoot: string | null = null;
let projectTree: TreeNode | null = null;
const expandedPaths = new Set<string>();

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
}

/// silent: 시작 시 복원/드롭 판별 경로 — 실패해도 toast 없이 조용히 넘어간다.
async function openProject(root: string, silent = false): Promise<void> {
  let res: ScanResult;
  try {
    res = await invoke<ScanResult>('scan_tree', { root });
  } catch (e) {
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
    // 새 프로젝트: 펼침 상태 초기화, 루트 직속만 펼침(자식 dir는 접힘).
    expandedPaths.clear();
  }
  projectRoot = root;
  projectTree = res.tree;
  if (res.truncated) toast('항목이 많아 트리를 일부만 표시합니다');
  sidebarTitle.textContent = res.tree.name;
  sidebarTitle.title = root;
  showSidebar();
  renderTree();
  localStorage.setItem(PROJECT_KEY, root);
  try {
    await invoke('watch_dir', { root });
  } catch (e) {
    if (!silent) toast(`폴더 감시 실패: ${String(e)}`);
  }
}

function closeProject(): void {
  if (projectRoot) void invoke('unwatch_dir', { root: projectRoot });
  projectRoot = null;
  projectTree = null;
  expandedPaths.clear();
  treeEl.textContent = '';
  sidebar.hidden = true;
  document.body.classList.remove('project-open');
  localStorage.removeItem(PROJECT_KEY);
  localStorage.removeItem(SIDEBAR_HIDDEN_KEY);
}

/// tree-changed 수신 시 재스캔. 펼침 상태(expandedPaths)는 그대로 유지.
async function refreshTree(): Promise<void> {
  if (!projectRoot) return;
  try {
    const res = await invoke<ScanResult>('scan_tree', { root: projectRoot });
    if (!projectRoot) return; // closed while scanning
    projectTree = res.tree;
    renderTree();
  } catch {
    // 프로젝트 폴더 자체가 사라짐
    closeProject();
  }
}

function renderTree(): void {
  treeEl.textContent = '';
  if (!projectTree) return;
  if (projectTree.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'md 파일 없음';
    treeEl.appendChild(empty);
    return;
  }
  treeEl.appendChild(buildTreeChildren(projectTree.children));
  updateTreeHighlight();
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
        if (expandedPaths.has(n.path)) {
          expandedPaths.delete(n.path);
        } else {
          expandedPaths.add(n.path);
        }
        renderTree();
      });
      if (expanded) {
        wrap.appendChild(buildTreeChildren(n.children));
      }
    } else {
      icon.innerHTML = SVG_FILE;
      row.addEventListener('click', () => {
        void openTabFromPath(n.path);
      });
    }
  }
  return wrap;
}

/// 활성 탭 파일을 트리에서 하이라이트. renderTabBar()가 탭 변화마다 호출.
function updateTreeHighlight(): void {
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
    row.scrollIntoView({ block: 'nearest' });
  }
}

sidebarClose.addEventListener('click', () => hideSidebar());

btnOpenFolder.addEventListener('click', async () => {
  if (projectRoot) {
    // 프로젝트가 이미 있으면 버튼은 보이기/숨기기 토글로 동작한다.
    if (sidebar.hidden) showSidebar();
    else hideSidebar();
    return;
  }
  const sel = await open({ directory: true });
  if (typeof sel === 'string') {
    await openProject(sel);
  }
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
updateCopyPathBtn();

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
        if (/\.(md|markdown)$/i.test(p)) {
          void openTabFromPath(p);
        } else {
          // md가 아니면 폴더로 시도 — scan_tree가 디렉토리 판별.
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
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
    if (sel === null) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    for (const p of paths) {
      await openTabFromPath(p);
    }
  });

  const initial = await invoke<string[]>('get_initial_file');
  if (initial.length > 0) {
    for (const p of initial) {
      await openTabFromPath(p);
    }
  } else {
    await renderActive(); // show placeholder
  }

  // 마지막 프로젝트 복원 (폴더가 사라졌으면 openProject가 조용히 기억을 지움)
  const savedProject = localStorage.getItem(PROJECT_KEY);
  if (savedProject) {
    await openProject(savedProject, true);
    if (localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1') hideSidebar();
  }
}

if (isTauri) {
  void startTauri();
} else {
  // Chrome dev harness: hide + button, load fixture
  btnOpen.style.display = 'none';
  btnOpenFolder.style.display = 'none';
  _addTab('sample.md', sample);
  void activate('sample.md');
}

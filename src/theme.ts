import lightUrl from 'github-markdown-css/github-markdown-light.css?url';
import darkUrl from 'github-markdown-css/github-markdown-dark.css?url';

export type ThemeMode = 'light' | 'dark' | 'system';
export type EffectiveTheme = 'light' | 'dark';

const STORAGE_KEY = 'mdview-theme';

let mode: ThemeMode = 'system';
let lightLink: HTMLLinkElement;
let darkLink: HTMLLinkElement;
let onChangeCb: ((effective: EffectiveTheme) => void) | null = null;

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function createLink(href: string): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
  return link;
}

function readStoredMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored;
  }
  return 'system';
}

function computeEffective(): EffectiveTheme {
  if (mode === 'system') {
    return darkQuery.matches ? 'dark' : 'light';
  }
  return mode;
}

function apply(): void {
  const effective = computeEffective();

  // github-markdown-css: 정확히 하나만 활성 (둘 다 .markdown-body 규칙).
  // link.disabled 는 시트 load 전 설정 시 StyleSheet.disabled 로 전파 안 되는
  // 타이밍 버그가 있다(비활성 시트가 cascade에 남아 뒤 시트가 이김). media
  // 속성 토글은 load 타이밍과 무관하게 결정적으로 동작.
  lightLink.media = effective === 'light' ? 'all' : 'not all';
  darkLink.media = effective === 'dark' ? 'all' : 'not all';

  // 페이지 배경 매칭용 (styles.css).
  document.documentElement.setAttribute('data-mdview-theme', effective);

  if (onChangeCb) {
    onChangeCb(effective);
  }
}

/**
 * Initializes theme: creates the two github-markdown-css links, toggles
 * exactly one via .disabled, restores persisted mode, wires the system
 * (matchMedia) listener, and fires onChange synchronously with the initial
 * effective theme so callers can perform their first render with it.
 */
export function initTheme(onChange: (effective: EffectiveTheme) => void): EffectiveTheme {
  onChangeCb = onChange;
  lightLink = createLink(lightUrl);
  darkLink = createLink(darkUrl);

  mode = readStoredMode();

  // system 모드일 때 OS 외관 변경에 반응.
  darkQuery.addEventListener('change', () => {
    if (mode === 'system') {
      apply();
    }
  });

  apply();
  return computeEffective();
}

export function setMode(next: ThemeMode): void {
  mode = next;
  localStorage.setItem(STORAGE_KEY, next);
  apply();
}

/** Returns the current persisted/selected mode (not the effective resolved theme). */
export function getMode(): ThemeMode {
  return mode;
}

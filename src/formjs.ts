import { createForm } from '@bpmn-io/form-js-viewer';
import { DesignerContainerModule } from '@form-js-designer/designer-core';
import {
  DesignerComponentsModule,
  migrateLegacyTabsSchema,
} from '@form-js-designer/designer-components';
import { LayoutHeightModule } from '@form-js-designer/designer-runtime';
import '@bpmn-io/form-js-viewer/dist/assets/form-js-base.css';
import '@bpmn-io/form-js-viewer/dist/assets/form-js.css';
import './formjs-block.css';

/**
 * ```form-js 펜스 블록에 form-js viewer(+ designer 확장 컴포넌트)를 마운트.
 * render.ts가 만든 placeholder(.form-js-block[data-formjs-idx])를 채운다.
 * mdview는 뷰어이므로 폼은 표시 전용 — submit 배선 없음. bpmn.io 워터마크는
 * form-js가 자동 렌더하며 숨기지 않는다(라이선스 의무).
 */

let active: Array<() => void> = [];

/** 블록 저장 핸들러 — main.ts가 등록 (fence 교체 + 파일 쓰기 + 재렌더) */
export type FormBlockSaveHandler = (blockIdx: number, newJson: string) => Promise<void>;
let saveHandler: FormBlockSaveHandler | null = null;
export function setFormBlockSaveHandler(h: FormBlockSaveHandler): void {
  saveHandler = h;
}

/**
 * ✏️ 편집 진입 토글 — 현재 뷰어 전용 운영이라 비활성.
 * 편집 UI(에디터 모달·fence 교체·write_file)는 배선 완료 상태로,
 * true로 바꾸면 블록 호버 시 편집 버튼이 노출된다.
 */
const FORM_EDIT_ENABLED = false;

/** 한 번에 하나의 에디터만 (single-editor lock) */
let editorOpen = false;

async function openEditor(blockIdx: number, schema: Record<string, unknown>): Promise<void> {
  if (editorOpen) return;
  editorOpen = true;
  try {
    // 에디터 번들은 무겁다 — 첫 편집 시점에만 동적 로드
    const { mountEmbeddedEditorModal } = await import(
      '@form-js-designer/designer-editor-host/embedded'
    );
    await mountEmbeddedEditorModal({
      initialSchema: schema as { type: string; components: unknown[] },
      onSave: async (next) => {
        if (saveHandler) await saveHandler(blockIdx, JSON.stringify(next, null, 2));
      },
      onClose: () => {
        editorOpen = false;
      },
    });
  } catch (e) {
    editorOpen = false;
    console.error('form-js 에디터 오픈 실패:', e);
  }
}

function mountEditButton(el: HTMLElement, blockIdx: number, schema: Record<string, unknown>): void {
  const btn = document.createElement('button');
  btn.className = 'form-js-edit-btn';
  btn.title = 'form-js 블록 편집';
  btn.setAttribute('aria-label', 'form-js 블록 편집');
  btn.textContent = '✏️';
  btn.addEventListener('click', () => void openEditor(blockIdx, schema));
  el.appendChild(btn);
}

/** mdview 테마(documentElement[data-mdview-theme]) → 블록 theme-* 클래스 동기화 */
function applyBlockTheme(el: HTMLElement): void {
  const dark = document.documentElement.getAttribute('data-mdview-theme') === 'dark';
  el.classList.toggle('theme-dark', dark);
  el.classList.toggle('theme-light', !dark);
}

function errorBanner(el: HTMLElement, message: string): void {
  el.classList.add('theme-light');
  applyBlockTheme(el);
  const banner = document.createElement('div');
  banner.className = 'form-js-block--error';
  banner.setAttribute('role', 'alert');
  banner.textContent = `form-js 오류: ${message}`;
  el.appendChild(banner);
}

export async function renderAllFormJs(formBlocks: string[]): Promise<void> {
  // 이전 마운트 정리 — renderActive가 #content.innerHTML을 통째로 갈아끼우므로
  // DOM은 이미 사라졌고, form 인스턴스/observer만 해제하면 된다.
  for (const dispose of active) dispose();
  active = [];

  const els = document.querySelectorAll<HTMLElement>('.form-js-block');
  for (const el of els) {
    const idx = Number(el.dataset.formjsIdx);
    const src = formBlocks[idx];
    if (src === undefined) continue;

    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(src);
    } catch (e) {
      errorBanner(el, e instanceof Error ? e.message : '유효하지 않은 JSON');
      continue;
    }

    applyBlockTheme(el);
    const observer = new MutationObserver(() => applyBlockTheme(el));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-mdview-theme'],
    });

    try {
      const form = await createForm({
        container: el,
        schema: migrateLegacyTabsSchema(schema),
        additionalModules: [
          DesignerContainerModule,
          DesignerComponentsModule,
          LayoutHeightModule,
        ],
      });
      active.push(() => {
        observer.disconnect();
        form.destroy();
      });
      if (FORM_EDIT_ENABLED) mountEditButton(el, idx, schema);
    } catch (e) {
      observer.disconnect();
      el.innerHTML = '';
      errorBanner(el, e instanceof Error ? e.message : String(e));
    }
  }
}

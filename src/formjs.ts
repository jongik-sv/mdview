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
    } catch (e) {
      observer.disconnect();
      el.innerHTML = '';
      errorBanner(el, e instanceof Error ? e.message : String(e));
    }
  }
}

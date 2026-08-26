/**
 * @form-js-designer/* link: 의존은 소스(.ts/.tsx)로 링크되어 mdview tsconfig로는
 * 타입체크가 불가능하다(preact JSX·node 타입 등 전제가 다름). tsc에는 이 stub을
 * paths로 물리고, vite 번들만 실제 소스를 사용한다.
 */
export declare const DesignerContainerModule: Record<string, unknown>;

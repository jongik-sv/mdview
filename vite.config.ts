import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// form-js designer 패키지(vendor/*.tgz 의존)는 preact 기반이며 radix 등 React
// 라이브러리를 preact/compat alias로 소비한다. 소스(.ts/.tsx) 그대로 배포되므로
// mdview vite가 alias/dedupe/JSX 변환을 책임진다 (preact 이중 인스턴스 금지).
// JSX: 의존 프리번들(esbuild)은 패키지 tsconfig를 안 읽으므로 automatic+preact를
// 명시해야 한다 — 없으면 classic 변환으로 "React is not defined" 런타임 오류.
const DESIGNER_REPO = "/Users/jji/project/form-js-designer-simple-props";
const PREACT_JSX = { jsx: "automatic", jsxImportSource: "preact" } as const;

// https://vite.dev/config/
export default defineConfig(async () => ({
  resolve: {
    dedupe: ["preact", "@bpmn-io/form-js-viewer"],
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
  },
  esbuild: PREACT_JSX,
  optimizeDeps: {
    esbuildOptions: PREACT_JSX,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    fs: {
      // link: 의존이 저장소 밖 소스를 서빙하므로 허용 목록에 추가
      allow: [".", DESIGNER_REPO],
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

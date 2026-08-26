import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// form-js designer 패키지(link: 의존)는 preact 기반이며 radix 등 React 라이브러리를
// preact/compat alias로 소비한다. 소스(.ts/.tsx) 그대로 링크되므로 mdview vite가
// alias/dedupe를 책임진다 (preact 이중 인스턴스 금지).
const DESIGNER_REPO = "/Users/jji/project/form-js-designer-simple-props";

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

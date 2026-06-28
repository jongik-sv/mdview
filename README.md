# mdview

A fast, native Markdown viewer for macOS and Windows, built with [Tauri 2](https://tauri.app/) and TypeScript. Open a `.md` file from your file manager and it renders instantly — with live reload, tabs, and a GitHub-flavored look.

## Features

- **GitHub-flavored rendering** — [markdown-it](https://github.com/markdown-it/markdown-it) with task lists, [github-markdown-css](https://github.com/sindresorhus/github-markdown-css), and syntax highlighting via [highlight.js](https://highlightjs.org/).
- **Mermaid diagrams** — fenced ` ```mermaid ` blocks render to SVG.
- **Live reload** — the open file is watched on disk and re-renders on save (atomic-save aware, so editors like Zed/VS Code work).
- **Tabs** — open multiple documents at once.
- **Source view** — toggle between rendered output and a read-only, syntax-highlighted source pane.
- **Light / dark theme** — follows the system or can be toggled manually.
- **In-page search** — find-as-you-type with match highlighting and a counter.
- **Recent files** menu, copy-file-path, and adjustable font size.
- **File association** — registers as a handler for `.md` / `.markdown` so you can set it as the default app and double-click to open.

## Tech stack

| Layer    | Tech                                              |
|----------|---------------------------------------------------|
| Shell    | Tauri 2 (Rust)                                     |
| Frontend | TypeScript + Vite 6                               |
| Render   | markdown-it, highlight.js, mermaid, github-markdown-css |
| File I/O | Rust commands + `notify` file watcher             |

## Prerequisites

- [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/) toolchain
- Platform [Tauri prerequisites](https://tauri.app/start/prerequisites/)

## Development

```bash
pnpm install
pnpm tauri dev
```

## Build

```bash
pnpm tauri build
```

Bundles land in `src-tauri/target/release/bundle/`.

### Windows build from macOS

Cross-compiles an unsigned x64 NSIS installer using [cargo-xwin](https://github.com/rust-cross/cargo-xwin):

```bash
brew install llvm lld makensis
rustup target add x86_64-pc-windows-msvc
XWIN_ACCEPT_LICENSE=1 pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

> The installer is unsigned; Windows SmartScreen may warn on first launch.

## License

TBD

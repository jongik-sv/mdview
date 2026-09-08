#!/usr/bin/env node
// Print the CHANGELOG.md section for one version — the text that becomes the
// GitHub Release body and, through latest.json's `notes`, the summary the
// updater shows before installing.
//
// Usage:
//   node scripts/release-notes.mjs v0.1.34
//   node scripts/release-notes.mjs            # version from package.json
//
// A version with no section still yields the download line, so the release
// workflow never fails over a missing entry.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = (process.argv[2] ?? pkg.version).replace(/^v/, '');

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

// `## v0.1.34 — 2026-09-08` 부터 다음 `## ` 직전까지.
const heading = new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}\\b.*$`, 'm');
const start = changelog.search(heading);
let section = '';
if (start !== -1) {
  const rest = changelog.slice(start);
  const nextIdx = rest.slice(1).search(/^## /m);
  section = (nextIdx === -1 ? rest : rest.slice(0, nextIdx + 1)).trim();
  // 제목 줄은 릴리스 제목이 이미 버전을 말하므로 뺀다.
  section = section.split('\n').slice(1).join('\n').trim();
}

const download = 'macOS(Apple Silicon·Intel)와 Windows x64 설치 파일은 아래 Assets 에 있다.';
process.stdout.write(section ? `${section}\n\n---\n\n${download}\n` : `${download}\n`);

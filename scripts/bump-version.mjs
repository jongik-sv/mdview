#!/usr/bin/env node
// Bump the app version across package.json, tauri.conf.json and Cargo.toml.
//
// Usage:
//   node scripts/bump-version.mjs <version|major|minor|patch> [--tag]
//
//   node scripts/bump-version.mjs 0.2.0          # set explicit version
//   node scripts/bump-version.mjs patch          # 0.1.0 -> 0.1.1
//   node scripts/bump-version.mjs minor --tag    # bump + git commit + tag + push
//
// With --tag it commits the three files, creates an annotated tag vX.Y.Z and
// pushes it, which triggers the release workflow.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
const doTag = process.argv.includes('--tag');

if (!arg) {
  console.error('Usage: node scripts/bump-version.mjs <version|major|minor|patch> [--tag]');
  process.exit(1);
}

const pkgPath = join(root, 'package.json');
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
const cargoPath = join(root, 'src-tauri', 'Cargo.toml');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const current = pkg.version;

function nextVersion(cur, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [maj, min, pat] = cur.split('.').map(Number);
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`;
  console.error(`Invalid version/bump: ${bump}`);
  process.exit(1);
}

const next = nextVersion(current, arg);
console.log(`Version: ${current} -> ${next}`);

// package.json — preserve formatting via JSON round-trip with 2-space indent.
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// tauri.conf.json — same.
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
conf.version = next;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

// Cargo.toml — replace only the first `version =` line (the [package] one).
let cargo = readFileSync(cargoPath, 'utf8');
cargo = cargo.replace(/^version = ".*"$/m, `version = "${next}"`);
writeFileSync(cargoPath, cargo);

console.log('Updated: package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml');

if (doTag) {
  const tag = `v${next}`;
  execSync(`git add ${pkgPath} ${confPath} ${cargoPath} ${join(root, 'src-tauri', 'Cargo.lock')}`, { stdio: 'inherit' });
  execSync(`git commit -m "chore: release ${tag}"`, { stdio: 'inherit', cwd: root });
  execSync(`git tag -a ${tag} -m "${tag}"`, { stdio: 'inherit', cwd: root });
  execSync('git push', { stdio: 'inherit', cwd: root });
  execSync(`git push origin ${tag}`, { stdio: 'inherit', cwd: root });
  console.log(`\nTagged and pushed ${tag} — release workflow triggered.`);
} else {
  console.log(`\nNext: review changes, then\n  git commit -am "chore: release v${next}"\n  git tag v${next} && git push && git push origin v${next}`);
}

/**
 * Propagates package.json's version to every place that repeats it.
 *
 * There were four independent version numbers: package.json (0.1.0, never bumped), both
 * OpenWrt Makefiles, and the installer/workflow/README's release tag (v0.1.5). The installer
 * also hardcoded package filenames, so a PKG_RELEASE bump silently broke installs.
 *
 * Wired into npm's `version` lifecycle, so `npm version minor` bumps, propagates and tags in
 * one command. Run with --check in CI to catch drift.
 *
 *   node scripts/sync-version.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`package.json version is not a plain semver: ${version}`);
}
const tag = `v${version}`;

/** [file, regex, replacement] — each regex must capture the prefix it should keep. */
const rules = [
  ['openwrt-packages/cf-ip-speed-client/Makefile', /^(PKG_VERSION:=).*$/m, `$1${version}`],
  ['openwrt-packages/luci-app-cf-ip-speed-client/Makefile', /^(PKG_VERSION:=).*$/m, `$1${version}`],
  ['scripts/install-openwrt.sh', /^(TAG="\$\{TAG:-)v[^"}]+(\}")$/m, `$1${tag}$2`],
  ['scripts/install-openwrt.sh', /^(PKG_VERSION="\$\{PKG_VERSION:-)[^"}]+(\}")$/m, `$1${version}$2`],
  ['.github/workflows/openwrt-packages.yml', /^(\s+default:\s*)["']?v\d+\.\d+\.\d+["']?\s*$/m, `$1"${tag}"`],
  ['README.md', /releases\/tag\/v\d+\.\d+\.\d+/g, `releases/tag/${tag}`]
];

const drifted = [];

for (const [file, pattern, replacement] of rules) {
  const path = join(root, file);
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    console.warn(`sync-version: skipping missing ${file}`);
    continue;
  }

  // Not pattern.test(): with a /g regex that is stateful via lastIndex and misreports on the
  // second call against the same regex object.
  if (source.match(pattern) === null) {
    console.warn(`sync-version: no match in ${file} — pattern may need updating`);
    continue;
  }

  const next = source.replace(pattern, replacement);
  if (next === source) {
    continue;
  }
  if (check) {
    drifted.push(file);
  } else {
    writeFileSync(path, next, 'utf8');
    console.log(`sync-version: updated ${file}`);
  }
}

if (check && drifted.length) {
  console.error(`sync-version: these files disagree with package.json (${version}):\n  ${drifted.join('\n  ')}`);
  process.exit(1);
}

console.log(check ? `sync-version: all files agree on ${tag}` : `sync-version: synced to ${tag}`);

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const script = fileURLToPath(new URL('./check-release-metadata.mjs', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../../app/package.json', import.meta.url), 'utf8'));
const wrongTag = 'v0.0.0-audit-mismatch';

function runMetadata(env) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

test('push tag matching package version passes metadata gate', () => {
  const result = runMetadata({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/tags/v${version}` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release metadata OK/);
});

test('push tag mismatching package version fails before release upload', () => {
  const result = runMetadata({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/tags/${wrongTag}` });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(`触发 tag ${wrongTag} 与发布版本 v${version} 不一致`));
});

test('release upload step is after the metadata gate and cannot run on gate failure', () => {
  const workflow = fileURLToPath(new URL('../../.github/workflows/release-windows.yml', import.meta.url));
  const text = readFileSync(workflow, 'utf8');
  const gate = text.indexOf('node src-tauri/scripts/check-release-metadata.mjs');
  const upload = text.indexOf('gh release create "$TAG"');
  assert.ok(gate >= 0, 'metadata gate missing');
  assert.ok(upload > gate, 'release upload precedes metadata gate');
});

test('release remains draft until portable assets and draft checks finish', () => {
  const workflow = fileURLToPath(new URL('../../.github/workflows/release-windows.yml', import.meta.url));
  const text = readFileSync(workflow, 'utf8');
  const portable = text.indexOf('Compress-Archive');
  const create = text.indexOf('gh release create "$TAG"');
  const verify = text.indexOf('gh release view "$TAG" --json isDraft,assets');
  const publish = text.indexOf('gh release edit "v$VERSION" --draft=false --latest');
  assert.ok(portable >= 0 && create > portable, 'portable package must be ready before draft upload');
  assert.ok(verify > create && publish > verify, 'publish must follow draft asset checks');
  assert.match(text.slice(create, verify), /--draft/);
  assert.ok(!text.includes('--clobber'), 'release workflow must not replace existing assets');
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const script = fileURLToPath(new URL('./check-w15-scope.mjs', import.meta.url));

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'guitar-w15-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  const check = () => spawnSync(process.execPath, [script], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  try {
    git('init', '--quiet');
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app/package.json'), '{"version":"1"}\n');
    writeFileSync(join(root, 'app/other.txt'), 'original\n');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'baseline');
    git('tag', 'app-baseline');
    run({ root, git, check });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('missing baseline fails instead of accepting empty Git output', () => fixture(({ git, check }) => {
  git('tag', '-d', 'app-baseline');
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /W15 Git 检查失败/);
}));

test('unchanged checkout and allowed version change pass', () => fixture(({ root, check }) => {
  assert.equal(check().status, 0);
  writeFileSync(join(root, 'app/package.json'), '{"version":"2"}\n');
  const result = check();
  assert.equal(result.status, 0, result.stderr);
}));

test('unapproved working tree change fails', () => fixture(({ root, check }) => {
  writeFileSync(join(root, 'app/other.txt'), 'modified\n');
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /app\/other\.txt/);
}));

test('unapproved committed change fails', () => fixture(({ root, git, check }) => {
  writeFileSync(join(root, 'app/other.txt'), 'modified\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'change outside scope');
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /app\/other\.txt/);
}));

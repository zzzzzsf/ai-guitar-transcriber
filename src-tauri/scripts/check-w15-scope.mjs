#!/usr/bin/env node
/**
 * W15 例外清单自检：只放行本轮修复涉及的具体文件。
 * 自行读取 Git 基线与差异；Git 失败必须阻断，不能把空输出当成无改动。
 */
import { spawnSync } from 'node:child_process';

const ALLOWED = new Set([
  'app/package.json',
  // Release metadata only; dependency versions are unchanged by this bump.
  'app/package-lock.json',
  'app/src/tauriCsp.test.ts',
  'app/src/App.tsx',
  'app/src/components/AudioDropzone.tsx',
  'app/src/components/PlaybackBar.tsx',
  'app/src/components/TempoMapPanel.tsx',
  'app/src/components/SettingsModal.tsx',
  'app/src/components/WaveformMixer.tsx',
  'app/src/components/TabViewer.tsx',
  'app/src/components/tabViewerConfig.ts',
  'app/src/components/tabViewerConfig.test.ts',
  'app/src/core/audioPreprocessor.ts',
  'app/src/main/desktopSeparation.ts',
  'app/src/main/desktopSeparation.test.ts',
  'app/src/main/separatorRunner.ts',
  'app/src/main/separatorRunner.test.ts',
  'app/src/main/tierRouter.ts',
  'app/src/profiles/GuitarProfile.ts',
  'app/src/profiles/GuitarProfile.test.ts',
  'app/src/core/pitchTranscriber.ts',
  'app/src/core/pitchTranscriber.test.ts',
  'app/src/core/quantizer.ts',
  'app/src/core/quantizer.test.ts',
  'app/src/core/scoreContext.ts',
  'app/src/core/scoreContext.test.ts',
  'app/src/persistence/projectFile.ts',
  'app/src/persistence/projectFile.test.ts',
  'app/src/persistence/editOverlay.ts',
  'app/src/persistence/editOverlay.test.ts',
  'app/src/io/fsAdapter.ts',
  'app/src/io/fsAdapter.test.ts',
  'app/src/main/modelDownloader.ts',
  'app/src/main/modelDownloader.test.ts',
  'app/src/llm/guitarPrompts.ts',
  'app/src/llm/guitarPrompts.test.ts',
  'app/src/llm/aiRewrite.ts',
  'app/src/llm/aiRewrite.test.ts',
  'app/src/llm/texGuard.ts',
  'app/src/llm/texGuard.test.ts',
  'app/src/llm/chordAnnotator.ts',
  'app/src/llm/chordAnnotator.test.ts',
  'app/src/llm/stemSplitter.ts',
  'app/src/llm/stemSplitter.test.ts',
]);

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`W15 Git 检查失败：${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}

const baseline = process.argv[2] ?? 'app-baseline';
if (baseline.startsWith('-')) throw new Error('W15 基线不能是 Git 选项');
git(['rev-parse', '--verify', `${baseline}^{commit}`]);
const changed = git(['diff', '--name-only', '-z', baseline, '--', 'app/'])
  .split('\0').filter(Boolean);
const unexpected = changed.filter((file) => !ALLOWED.has(file));
if (unexpected.length > 0) {
  console.error('W15-1 失败：检测到本次修复范围之外的前端改动');
  for (const file of unexpected) console.error(`  ${file}`);
  process.exit(1);
}
console.log(`W15-1a OK: ${changed.length} 个变更均在已批准清单内`);

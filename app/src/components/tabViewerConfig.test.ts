import { describe, expect, it } from 'vitest';
import { PlayerMode, ScrollMode, Settings } from '@coderline/alphatab';
import { createTabPlayerSettings, TAB_SOUNDFONT_URL } from './tabViewerConfig';

describe('createTabPlayerSettings', () => {
  it('启用 alphaTab 播放器并使用随包音源', () => {
    const settings = new Settings();
    settings.fillFromJson({
      player: createTabPlayerSettings({ followPlayback: true, showCursor: true }),
    });

    expect(settings.player.playerMode).toBe(PlayerMode.EnabledAutomatic);
    expect(settings.player.soundFont).toBe(TAB_SOUNDFONT_URL);
    expect(settings.player.scrollMode).toBe(ScrollMode.Continuous);
    expect(settings.player.enableCursor).toBe(true);
  });

  it('保留关闭跟随滚动和光标的显示设置', () => {
    const settings = new Settings();
    settings.fillFromJson({
      player: createTabPlayerSettings({ followPlayback: false, showCursor: false }),
    });

    expect(settings.player.playerMode).toBe(PlayerMode.EnabledAutomatic);
    expect(settings.player.scrollMode).toBe(ScrollMode.Off);
    expect(settings.player.enableCursor).toBe(false);
  });
});

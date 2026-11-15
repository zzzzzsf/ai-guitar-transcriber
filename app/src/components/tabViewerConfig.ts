import { PlayerMode, ScrollMode } from '@coderline/alphatab';

type PlayerDisplaySettings = {
  followPlayback: boolean;
  showCursor: boolean;
};

/** alphaTab Vite 插件会把随包音源复制到 public/soundfont/。 */
export const TAB_SOUNDFONT_URL = '/soundfont/sonivox.sf2';

export function createTabPlayerSettings(
  display: PlayerDisplaySettings,
  scrollElement?: string | HTMLElement,
) {
  return {
    soundFont: TAB_SOUNDFONT_URL,
    playerMode: PlayerMode.EnabledAutomatic,
    scrollMode: display.followPlayback ? ScrollMode.Continuous : ScrollMode.Off,
    scrollElement,
    enableCursor: display.showCursor,
  };
}

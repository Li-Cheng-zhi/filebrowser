import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { globalVarsMock } = vi.hoisted(() => ({
  globalVarsMock: { darkMode: false },
}));

vi.mock('@/utils/constants', () => ({
  globalVars: globalVarsMock,
}));

import { defaultDarkMode, syncDocumentTheme } from './theme.js';

describe('theme utils', () => {
  beforeEach(() => {
    globalVarsMock.darkMode = false;
    document.documentElement.className = '';
    document.documentElement.style.setProperty('--background', '#f5f5f5');
    document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  });

  afterEach(() => {
    document.documentElement.className = '';
    document.head.innerHTML = '';
  });

  it('defaultDarkMode returns true only when globalVars.darkMode is true', () => {
    globalVarsMock.darkMode = false;
    expect(defaultDarkMode()).toBe(false);

    globalVarsMock.darkMode = true;
    expect(defaultDarkMode()).toBe(true);

    globalVarsMock.darkMode = null;
    expect(defaultDarkMode()).toBe(false);
  });

  it('syncDocumentTheme toggles html class and updates theme-color from --background', () => {
    document.documentElement.style.setProperty('--background', '#141D24');

    syncDocumentTheme(true);
    expect(document.documentElement.classList.contains('dark-mode')).toBe(true);
    expect(document.querySelector('meta[name="theme-color"]').getAttribute('content')).toBe('#141D24');

    document.documentElement.style.setProperty('--background', '#f5f5f5');
    syncDocumentTheme(false);
    expect(document.documentElement.classList.contains('dark-mode')).toBe(false);
    expect(document.querySelector('meta[name="theme-color"]').getAttribute('content')).toBe('#f5f5f5');
  });
});

// Standalone /works/file bypasses Layout.vue; its theme must still track the
// loaded user preference instead of mixing dark text tokens with a light page.
const preference = { dark: false };
vi.mock('@/store', () => ({ mutations: { setLoading: vi.fn() }, getters: { isDarkMode: () => preference.dark } }));
vi.mock('@/utils/loadFullIcons', () => ({ scheduleFullIcons: vi.fn() }));
import { createApp, nextTick, reactive } from 'vue';
import RootApp from '../App.vue';

it('updates the document theme on routes without Layout', async () => {
  const current = reactive(preference);
  const { getters } = await import('@/store');
  getters.isDarkMode = () => current.dark;
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = createApp(RootApp);
  app.component('router-view', { template: '<main class="works-file">standalone file</main>' });
  try {
    app.mount(target);
    expect(document.documentElement.classList.contains('dark-mode')).toBe(false);
    current.dark = true;
    await nextTick();
    expect(document.documentElement.classList.contains('dark-mode')).toBe(true);
    current.dark = false;
    await nextTick();
    expect(document.documentElement.classList.contains('dark-mode')).toBe(false);
  } finally { app.unmount(); target.remove(); }
});

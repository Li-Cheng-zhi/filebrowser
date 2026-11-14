import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/store', async () => {
  const { reactive } = await import('vue');
  const state = reactive({ req: {}, selected: [], showSidebar: true });
  return { state,
    mutations: { closeSidebar: () => { state.showSidebar = false; }, toggleSidebar: () => { state.showSidebar = !state.showSidebar; },
      resetSelected: () => { state.selected = []; }, addSelected: index => { state.selected.push(index); } },
    getters: { sorting: () => ({ by: 'name', asc: true }), viewModeChangeLocked: () => false },
  };
});
vi.mock('@/router', () => ({ router: { replace: vi.fn(async () => {}), push: vi.fn(async () => {}) } }));
vi.mock('@/views/bars/Default.vue', () => ({ default: { methods: { switchView: vi.fn(), toggleOverflow: vi.fn() } } }));

// A scoped upstream renderer catches adapter regressions without mocking the adapter itself.
vi.mock('./FilePage.vue', async () => {
  const { h } = await import('vue');
  return { default: {
    __scopeId: 'data-v-upstream-file',
    data: () => ({ loaded: true, busy: false, canonical: '/a/file.txt', source: 'home', path: '/a/file.txt',
      status: 'saved', message: '', office: false, officeDirty: false, textFile: true, mode: 'edit', right: false,
      modes: [{ value: 'view' }, { value: 'edit' }], saver: { dirty: false }, saves: 0, guardCalled: false, unloadChecks: 0 }),
    render() { return h('main', { class: 'upstream-file-body' }, 'upstream renderer'); },
    mounted() {
      window.worksFilesHost = { relocate: async () => {} };
      window.addEventListener('beforeunload', this.beforeUnload);
      return Promise.resolve();
    },
    beforeUnmount() { window.removeEventListener('beforeunload', this.beforeUnload); delete window.worksFilesHost; },
    beforeRouteLeave() { this.guardCalled = true; return false; },
    methods: { publish() {}, save() { this.saves++; }, switchMode() {}, reload() {}, saveAs() {}, openMain() {},
      beforeUnload(event) { this.unloadChecks++; event.preventDefault(); } },
  } };
});

async function chrome(url = '/works/file?worksChrome=1&worksPage=doc-1') {
  history.replaceState(null, '', url);
  vi.resetModules();
  return import('./hostChrome.js');
}

afterEach(() => { delete window.worksFilesHost; delete window.cefQuery; document.documentElement.classList.remove('works-hosted-chrome'); });

describe('resource host chrome', () => {
  it('requires an explicit hosted document rather than the availability of cefQuery', async () => {
    const module = await chrome('/works/file');
    window.cefQuery = vi.fn();
    expect(module.hostChromeEnabled({ query: {} })).toBe(false);
    expect(module.activateHostChrome()).toBe(false);
    expect(module.hostRequest({ action: 'identity' })).toEqual({ action: 'identity' });
    delete window.cefQuery;
  });
  it('retains one document identity across directory SPA navigation and ignores a spoofed key', async () => {
    const module = await chrome('/files/home/a/?worksChrome=1&worksPage=doc-1');
    history.replaceState(null, '', '/files/home/b/');
    expect(module.hostChromeEnabled({ query: {} })).toBe(true);
    expect(module.hostRequest({ action: 'navigation', documentKey: 'stale' }).documentKey).toBe('doc-1');
    expect(module.activateHostChrome()).toBe(true);
  });
  it('routes commands to existing operations, publishes after completion and reports failure', async () => {
    const { attachHostCommands } = await chrome();
    const host = {}; const publish = vi.fn(); const error = vi.fn();
    const save = vi.fn(async () => { throw new Error('磁盘版本冲突'); });
    attachHostCommands(host, { save }, publish, error);
    await host.runCommand('save');
    expect(save).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('磁盘版本冲突');
    expect(publish).toHaveBeenCalledOnce();
  });
  it('does not remove the bridge registration of a newer mounted page', async () => {
    const { cleanHost } = await chrome(); const older = {}; const newer = {};
    window.worksFilesHost = newer;
    cleanHost(older, () => { delete window.worksFilesHost; });
    expect(window.worksFilesHost).toBe(newer);
    cleanHost(newer, () => { delete window.worksFilesHost; });
    expect(window.worksFilesHost).toBeUndefined();
  });
  it('publishes actual file permissions and Office review capability, preserving right-side read-only mode', async () => {
    const { fileChromeState } = await chrome();
    const page = { loaded: true, busy: false, canonical: '/a/doc.docx', source: 'home', path: '/a/doc.docx',
      status: 'dirty', message: '', office: true, officeDirty: true, mode: 'review',
      modes: [{ value: 'view' }, { value: 'edit' }, { value: 'review' }], right: false };
    expect(fileChromeState(page)).toMatchObject({ ready: true, dirty: true, mode: 'review', modes: ['view', 'edit', 'review'], saveAs: true });
    expect(fileChromeState({ ...page, right: true })).toMatchObject({ modes: [], saveAs: false });
  });
  it('keeps the upstream renderer and explicit save while allowing hosted navigation without save checks', async () => {
    await chrome();
    window.cefQuery = vi.fn(({ onSuccess }) => onSuccess('{}'));
    const { createApp, nextTick } = await import('vue');
    const factory = (await import('./HostedFilePage.vue')).default;
    const target = document.createElement('div'); document.body.append(target);
    const app = createApp(factory);
    app.config.globalProperties.$route = { query: { source: 'home', path: '/a/file.txt', worksChrome: '1' } };
    const vm = app.mount(target); await nextTick();
    expect(target.querySelector('.upstream-file-body')?.hasAttribute('data-v-upstream-file')).toBe(true);
    await window.worksFilesHost.runCommand('save');
    expect(vm.$refs.page.saves).toBe(1);
    vm.$refs.page.saver.dirty = true;
    vm.$refs.page.status = 'saving';
    expect(await factory.beforeRouteLeave.call(vm, { name: 'Settings' }, {})).toBe(true);
    expect(await factory.beforeRouteLeave.call(vm, { name: 'Files', path: '/files/home/a/' }, {})).toBe(true);
    expect(await factory.beforeRouteUpdate.call(vm, { query: { source: 'home', path: '/b/file.txt' } },
      { query: { source: 'home', path: '/a/file.txt' } })).toBe(true);
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
    expect(vm.$refs.page.guardCalled).toBe(false);
    expect(vm.$refs.page.unloadChecks).toBe(0);
    expect(vm.$refs.page.saves).toBe(1);
    expect(window.cefQuery.mock.calls.some(([request]) => JSON.parse(request.request).action === 'navigate')).toBe(false);
    app.unmount(); target.remove();
    expect(window.worksFilesHost).toBeUndefined();
  });
  it('mounts the actual directory renderer with the hosted lifecycle, full tools and original scope', async () => {
    await chrome('/files/home/a/?worksChrome=1&worksPage=directory-1');
    const { createApp, nextTick } = await import('vue');
    const { state } = await import('@/store');
    const baseline = (await import('./DirectoryPager.vue')).default;
    const factory = (await import('./HostedDirectoryControls.vue')).default;
    state.req = { source: 'home', path: '/a', canonicalPath: '/Users/chui/a',
      items: [{ source: 'home', path: '/a/file.txt', name: 'file.txt', type: 'file' }],
      page: { cursor: 'snapshot:0', index: 1, total: 1, previousCursor: '', nextCursor: '' } };
    state.selected = [0];
    const messages = [];
    window.cefQuery = vi.fn(({ request, onSuccess }) => {
      const message = JSON.parse(request); messages.push(message);
      onSuccess(JSON.stringify(message.action === 'context' ? { right: false } : {}));
    });
    const target = document.createElement('div'); target.id = 'main'; document.body.append(target);
    const app = createApp(factory, { page: state.req.page });
    app.config.globalProperties.$route = { path: '/files/home/a/', query: {} };
    const vm = app.mount(target);
    try {
      await nextTick(); await nextTick(); await nextTick();
      const tools = target.querySelector('.works-hosted-directory-controls');
      expect(tools).not.toBeNull();
      expect(tools.hasAttribute(baseline.__scopeId)).toBe(true);
      expect(target.querySelector('[aria-label="筛选已加载项"]')).not.toBeNull();
      expect(target.querySelector('[aria-label="刷新目录"]')).not.toBeNull();
      expect(target.querySelector('[aria-label="打开所选项"]')).not.toBeNull();
      expect(target.querySelector('[aria-label="系统回收站"]')).not.toBeNull();
      expect(target.querySelector('.works-hosted-pager')).toBeNull();
      expect(state.showSidebar).toBe(false);
      await window.worksFilesHost.runCommand('filter', { value: 'file' });
      expect(vm.filter).toBe('file'); expect(state.req.worksFilter).toBe('file');
      await window.worksFilesHost.runCommand('newTab');
      expect(messages).toContainEqual(expect.objectContaining({ action: 'open', source: 'home', path: '/a/file.txt', target: 'new', documentKey: 'directory-1' }));
      await window.worksFilesHost.runCommand('openRight');
      expect(messages).toContainEqual(expect.objectContaining({ action: 'open', target: 'right', documentKey: 'directory-1' }));
      expect(messages).toContainEqual(expect.objectContaining({ action: 'chromeState', selectedCount: 1, documentKey: 'directory-1' }));
    } finally { app.unmount(); target.remove(); }
    expect(window.worksFilesHost).toBeUndefined();
  });
  it('restores only the hosted directory header and its content offset, keeping file headers and breadcrumbs hidden', async () => {
    await chrome('/files/home/a/?worksChrome=1&worksPage=directory-1');
    // Read the real file: Vitest replaces CSS modules, including query imports, with empty strings.
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/works/hostChrome.css', 'utf8');
    expect(css).toContain('.works-hosted-directory-controls');
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    const directory = document.createElement('div'); directory.className = 'works-hosted-directory-controls';
    const header = document.createElement('header'); header.className = 'flexbar';
    const main = document.createElement('main'); main.id = 'main'; main.append(directory);
    const breadcrumbs = document.createElement('div'); breadcrumbs.id = 'breadcrumbs';
    const file = document.createElement('div'); file.className = 'works-file';
    const fileHeader = document.createElement('header'); file.append(fileHeader);
    document.body.append(header, main, breadcrumbs, file); document.documentElement.classList.add('works-hosted-chrome');
    try {
      expect(getComputedStyle(header).display).toBe('flex');
      expect(getComputedStyle(main).paddingTop).toBe('var(--header-height)');
      expect(getComputedStyle(breadcrumbs).display).toBe('none');
      expect(getComputedStyle(fileHeader).display).toBe('none');
      directory.remove();
      expect(getComputedStyle(header).display).toBe('none');
      expect(getComputedStyle(main).paddingTop).toBe('0px');
    } finally { style.remove(); header.remove(); main.remove(); breadcrumbs.remove(); file.remove(); }
  });
});

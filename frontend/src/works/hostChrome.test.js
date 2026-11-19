import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextTargetCommands, withContextTargets } from '../components/contextMenuTargets.js';

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

describe('explicit file prompt targets', () => {
  function fixture() {
    const selected = [7];
    const state = { selected, req: { source: 'rw', path: '/B' }, user: { scopes: [{ name: 'rw' }] }, navigation: { listing: [] } };
    const mutations = { closeHovers: vi.fn(), closeTopPrompt: vi.fn(), showPrompt: vi.fn() };
    const getters = { isShare: () => false, sourcePermissions: source => ({ modify: source === 'rw', delete: source === 'rw', create: source === 'rw', download: true }), canCreateInSource: source => source === 'rw' };
    const fetchFiles = vi.fn(async (source, path) => ({ source, path, name: path.split('/').at(-1), type: path.endsWith('dir') ? 'directory' : 'file' }));
    return { state, mutations, getters, fetchFiles, selected };
  }
  it('passes target A to rename while preserving the existing selected B and shares the mouse prompt entry', async () => {
    const f = fixture(); const commands = contextTargetCommands(f, f.fetchFiles);
    await commands.renameTarget({ source: 'rw', path: '/A.txt' });
    const prompt = f.mutations.showPrompt.mock.calls[0][0];
    expect(prompt).toEqual({ name: 'rename', props: { item: { source: 'rw', path: '/A.txt', name: 'A.txt', type: 'file' }, parentItems: [] } });
    expect(f.fetchFiles).toHaveBeenCalledWith('rw', '/A.txt', false, true); expect(f.state.selected).toBe(f.selected); expect(f.state.selected).toEqual([7]);
    const mouse = withContextTargets({ methods: {} }, f);
    mouse.methods.showRenamePrompt.call({ selectedCount: 1, firstSelected: prompt.props.item });
    expect(f.mutations.showPrompt.mock.calls[1][0]).toEqual(prompt);
  });
  it('passes existing copy/move/delete items and new-file/new-directory bases without adding save behavior', async () => {
    const f = fixture(); const commands = contextTargetCommands(f, f.fetchFiles);
    for (const name of ['copyTarget', 'moveTarget', 'deleteTarget']) await commands[name]({ source: 'rw', path: '/A.txt' });
    expect(f.mutations.showPrompt.mock.calls.map(([prompt]) => prompt.name)).toEqual(['copy', 'move', 'delete']);
    expect(f.mutations.showPrompt.mock.calls[0][0].props).toMatchObject({ items: [{ path: '/A.txt' }], operation: 'copy' });
    await commands.newFileTarget({ source: 'rw', path: '/A-dir' }); await commands.newDirTarget({ source: 'rw', path: '/A-dir' });
    expect(f.mutations.showPrompt.mock.calls.slice(3).map(([prompt]) => prompt.props.base)).toEqual([{ source: 'rw', path: '/A-dir' }, { source: 'rw', path: '/A-dir' }]);
    expect(f.state.selected).toEqual([7]);
  });
  it('uses original source permissions and leaves unavailable actions without a prompt', async () => {
    const f = fixture(); const commands = contextTargetCommands(f, f.fetchFiles);
    expect(await commands.renameTarget({ source: 'ro', path: '/A.txt' })).toBe(false);
    expect(await commands.moveTarget({ source: 'ro', path: '/A.txt' })).toBe(false);
    expect(await commands.deleteTarget({ source: 'ro', path: '/A.txt' })).toBe(false);
    expect(await commands.newFileTarget({ source: 'ro', path: '/A-dir' })).toBe(false);
    expect(f.mutations.showPrompt).not.toHaveBeenCalled();
    expect(await commands.copyTarget({ source: 'ro', path: '/A.txt' })).toBe(true);
  });
});

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
  it('reports a loaded LaTeX editor through the main-frame host and closes clean files without saving', async () => {
    await chrome('/works/file?source=home&path=/paper/main.tex&worksChrome=1&worksPage=latex-1');
    const messages = [];
    window.cefQuery = vi.fn(({ request, onSuccess }) => { messages.push(JSON.parse(request)); onSuccess('{}'); });
    const { createApp, nextTick } = await import('vue');
    const factory = (await import('./HostedFilePage.vue')).default;
    const target = document.createElement('div'); document.body.append(target);
    const app = createApp(factory);
    app.config.globalProperties.$route = { query: { source: 'home', path: '/paper/main.tex', worksChrome: '1' } };
    const vm = app.mount(target); await nextTick();
    const frame = target.querySelector('iframe');
    const editor = { state: { openTabs: [{ kind: 'text', path: 'main.tex', dirty: false }] }, saveAll: vi.fn(), discardClose: vi.fn() };
    frame.contentWindow.__ol = editor; frame.contentWindow.__olReady = true;
    try {
      expect(window.worksFilesHost).toBeDefined();
      await window.worksFilesHost.publish();
      expect(messages).toContainEqual(expect.objectContaining({ action: 'chromeState', documentKey: 'latex-1', ready: true, dirty: false, state: 'saved' }));
      await window.worksFilesHost.prepareClose('clean-close');
      expect(editor.saveAll).not.toHaveBeenCalled();
      expect(messages).toContainEqual(expect.objectContaining({ action: 'closeReady', token: 'clean-close', documentKey: 'latex-1' }));
      editor.state.openTabs[0].savePending = Promise.resolve();
      await window.worksFilesHost.publish();
      expect(messages).toContainEqual(expect.objectContaining({ action: 'chromeState', ready: true, busy: true, dirty: false, state: 'saving' }));
      editor.state.openTabs[0].dirty = true;
      expect(await factory.beforeRouteLeave.call(vm, { name: 'Files' }, {})).toBe(true);
      expect(await factory.beforeRouteUpdate.call(vm, { query: { source: 'home', path: '/other.tex' } },
        { query: { source: 'home', path: '/paper/main.tex' } })).toBe(true);
      expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
      expect(editor.saveAll).not.toHaveBeenCalled();
    } finally { app.unmount(); target.remove(); }
    expect(window.worksFilesHost).toBeUndefined();
  });
  it('waits for real LaTeX save receipts on explicit close and preserves failed buffers for keep or discard', async () => {
    await chrome('/works/file?worksChrome=1&worksPage=latex-2');
    const messages = [];
    window.cefQuery = vi.fn(({ request, onSuccess }) => { messages.push(JSON.parse(request)); onSuccess('{}'); });
    const { createApp, nextTick } = await import('vue');
    const page = (await import('./LatexPane.vue')).default;
    const target = document.createElement('div'); document.body.append(target);
    const app = createApp(page); app.config.globalProperties.$route = { query: { source: 'home', path: '/paper/main.tex' } };
    app.mount(target); await nextTick();
    const frame = target.querySelector('iframe');
    let complete;
    const receipt = new Promise(resolve => { complete = resolve; });
    const tabs = [{ kind: 'text', path: 'main.tex', dirty: true }, { kind: 'text', path: 'part.tex', dirty: true }];
    const editor = { state: { openTabs: tabs }, saveAll: vi.fn(async () => {
      await receipt; tabs.forEach(tab => { tab.dirty = false; });
    }), discardClose: vi.fn() };
    frame.contentWindow.__ol = editor; frame.contentWindow.__olReady = true;
    try {
      const host = window.worksFilesHost; expect(host).toBeDefined();
      const closing = host.prepareClose('saving-close');
      expect(editor.saveAll).toHaveBeenCalledOnce();
      expect(messages.some(message => message.action === 'closeReady')).toBe(false);
      complete(); await closing;
      expect(messages).toContainEqual(expect.objectContaining({ action: 'closeReady', token: 'saving-close', documentKey: 'latex-2' }));
      tabs[0].dirty = true;
      editor.saveAll.mockImplementation(async () => { throw new Error('磁盘版本冲突'); });
      await host.prepareClose('failed-close');
      expect(messages).toContainEqual(expect.objectContaining({ action: 'closeFailed', token: 'failed-close', message: '磁盘版本冲突', documentKey: 'latex-2' }));
      expect(tabs[0].dirty).toBe(true);
      const saves = editor.saveAll.mock.calls.length;
      await host.cancelClose(); expect(tabs[0].dirty).toBe(true);
      await host.discardClose('discard-close');
      expect(editor.discardClose).toHaveBeenCalledOnce(); expect(editor.saveAll.mock.calls.length).toBe(saves);
      expect(messages).toContainEqual(expect.objectContaining({ action: 'closeReady', token: 'discard-close', documentKey: 'latex-2' }));
    } finally { complete(); app.unmount(); target.remove(); }
  });
  it('lets an explicitly discarded LaTeX page close while the iframe is still loading', async () => {
    await chrome('/works/file?worksChrome=1&worksPage=latex-loading');
    const messages = [];
    window.cefQuery = vi.fn(({ request, onSuccess }) => { messages.push(JSON.parse(request)); onSuccess('{}'); });
    const { createApp, nextTick } = await import('vue');
    const page = (await import('./LatexPane.vue')).default;
    const target = document.createElement('div'); document.body.append(target);
    const app = createApp(page); app.config.globalProperties.$route = { query: { source: 'home', path: '/paper/main.tex' } };
    app.mount(target); await nextTick();
    try {
      expect(window.worksFilesHost).toBeDefined();
      await window.worksFilesHost.discardClose('loading-close');
      expect(messages).toContainEqual(expect.objectContaining({ action: 'closeReady', token: 'loading-close', documentKey: 'latex-loading' }));
    } finally { app.unmount(); target.remove(); }
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

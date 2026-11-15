import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/constants", () => ({
  globalVars: {
    baseURL: "/",
    externalUrl: "",
  },
}));

vi.mock("@/store", () => ({
  getters: { isShare: () => false },
  mutations: { replaceRequest: vi.fn() },
  state: {
    sessionId: "test-session",
    shareInfo: { subPath: "", hash: "", token: "" },
    req: { parentDirItems: [{ name: "app.js", viewToken: "sibling-view-token" }] },
  },
}));
vi.mock('@/views/files/Preview.vue', () => ({ default: {} }));
vi.mock('@/views/files/EpubViewer.vue', () => ({ default: {} }));
vi.mock('@/views/files/MarkdownViewer.vue', () => ({ default: {} }));
vi.mock('@/works/OfficePane.vue', () => ({ default: {} }));

vi.mock("@/api/media", () => ({
  getStreamURL: (_source, path, viewToken) =>
    `http://localhost/api/media/stream?file=${encodeURIComponent(path)}&viewToken=${viewToken}`,
  getStreamURLPublic: () => "http://localhost/public/stream",
}));

import { getViewURL, getOpenFileURL } from "@/api/resources.js";

describe("getViewURL", () => {
  it("routes audio to media stream with viewToken", () => {
    const url = getViewURL(
      "src",
      "/music/song.mp3",
      "view-tok",
      null,
      false,
      "audio/mpeg",
    );
    expect(url).toContain("/api/media/stream");
    expect(url).toContain("viewToken=view-tok");
  });

  it("routes documents to resources view with viewToken", () => {
    const url = getViewURL(
      "src",
      "/docs/readme.txt",
      "view-tok",
      null,
      false,
      "text/plain",
    );
    expect(url).toContain("/api/resources/view");
    expect(url).toContain("viewToken=view-tok");
  });

  it("returns null without viewToken when fallback disabled", () => {
    expect(getViewURL("src", "/a.txt", null, null, false, "text/plain")).toBeNull();
  });
  it('never returns a download URL when a legacy caller requests fallback', () => {
    expect(getViewURL('src', '/a.txt', null, null, true, 'text/plain')).toBeNull();
    expect(getViewURL('src', '/a.pdf', null, { hash: 'share' }, true, 'application/pdf')).toBeNull();
    expect(getOpenFileURL('src', '/a.txt')).toBeNull();
    expect(getOpenFileURL('src', '/a.pdf', { hash: 'share' })).toBeNull();
  });
});

afterEach(() => { delete window.cefQuery; vi.unstubAllGlobals(); });

describe('original-file default application fallback', () => {
  async function page() {
    history.replaceState(null, '', '/works/file?worksChrome=1&worksPage=open-1');
    vi.resetModules();
    const component = (await import('@/works/FilePage.vue')).default;
    const vm = { ...component.data.call({ $route: { query: { source: 'home', path: '/a b+%#42.txt' } } }),
      ...component.methods, errorCaptured: component.errorCaptured, $nextTick: async () => {}, publish: vi.fn(), mountEditor: vi.fn(), renderMarkdown: vi.fn() };
    return vm;
  }
  it('sends the original source and path through the document bridge without downloading', async () => {
    history.replaceState(null, '', '/works/file?worksChrome=1&worksPage=open-1'); vi.resetModules();
    const { openOriginalWithDefaultApp } = await import('@/works/api.js');
    window.cefQuery = vi.fn(({ onSuccess }) => onSuccess('{}'));
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await openOriginalWithDefaultApp('home', '/a b+%#42.txt');
    expect(JSON.parse(window.cefQuery.mock.calls[0][0].request)).toEqual({ worksFiles: 1, action: 'openDefaultApp', source: 'home', path: '/a b+%#42.txt', documentKey: 'open-1' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not report a successful external open without a desktop host', async () => {
    const { openOriginalWithDefaultApp } = await import('@/works/api.js');
    await expect(openOriginalWithDefaultApp('home', '/a')).rejects.toThrow('桌面宿主');
  });
  it.each([413, 415, 500])('opens the original on a text opening HTTP %s error and coalesces repeated renderer errors', async status => {
    const vm = await page(); const messages = [];
    window.cefQuery = vi.fn(({ request, onSuccess }) => { messages.push(JSON.parse(request)); onSuccess('{}'); });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ canonicalPath: '/Users/chui/a b+%#42.txt', type: 'text/plain', modes: ['view', 'edit'] }) })
      .mockResolvedValueOnce({ ok: false, status, text: async () => JSON.stringify({ message: 'cannot open original' }) }));
    await vm.load(); await vm.openFailure(new Error('second renderer error'));
    expect(vm.status).toBe('external'); expect(vm.message).toContain('系统关联应用');
    expect(messages.filter(message => message.action === 'openDefaultApp')).toHaveLength(1);
    expect(messages[0].path).toBe('/a b+%#42.txt');
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('download'))).toBe(true);
  });
  it('keeps the native open failure visible instead of claiming success', async () => {
    const vm = await page(); window.cefQuery = vi.fn(({ onFailure }) => onFailure(500, 'no associated application'));
    await vm.openFailure(new Error('unsupported file'));
    expect(vm.status).toBe('failed'); expect(vm.message).toContain('no associated application');
  });
  it('does not open another application for save errors, aborted loads, thumbnails or fonts', async () => {
    const vm = await page(); window.cefQuery = vi.fn();
    vm.mode = 'edit'; vm.saver = { save: vi.fn(async () => { throw new Error('save conflict'); }) };
    await vm.save(); expect(vm.message).toBe('save conflict');
    await vm.openFailure(Object.assign(new Error('cancelled navigation'), { name: 'AbortError' }));
    for (const src of ['/api/resources/preview?source=home&file=%2Fa+b%2B%25%2342.txt', '/fonts/font.png']) {
      vm.resourceError({ target: { tagName: 'IMG', src } });
    }
    expect(window.cefQuery).not.toHaveBeenCalled();
  });
  it('matches only the selected original bytes, including literal spaces, plus, percent and hash', async () => {
    const { isOpenedFileResource } = await import('@/works/api.js');
    expect(isOpenedFileResource('/api/resources/view?source=home&file=%2Fa+b%2B%25%2342.txt', 'home', '/a b+%#42.txt')).toBe(true);
    for (const url of ['/api/resources/preview?source=home&file=%2Fa+b%2B%25%2342.txt', '/api/resources/view?source=home&file=%2Fother.txt', 'https://other.example/api/resources/view?source=home&file=%2Fa+b%2B%25%2342.txt']) {
      expect(isOpenedFileResource(url, 'home', '/a b+%#42.txt')).toBe(false);
    }
  });
  it('handles production Vue loader/render codes without treating event-handler errors as file opens', async () => {
    const vm = await page(); vm.openFailure = vi.fn(); const failure = new Error('viewer module failed');
    expect(vm.errorCaptured(failure, {}, 'https://vuejs.org/error-reference/#runtime-13')).toBe(false);
    expect(vm.openFailure).toHaveBeenCalledWith(failure); vm.openFailure.mockClear();
    expect(vm.errorCaptured(failure, {}, 'https://vuejs.org/error-reference/#runtime-6')).toBeUndefined();
    expect(vm.openFailure).not.toHaveBeenCalled();
  });
});

describe("getOpenFileURL", () => {
  it("returns null for media files", () => {
    expect(getOpenFileURL("src", "/video/clip.mp4")).toBeNull();
    expect(getOpenFileURL("src", "/music/song.mp3")).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), '../../../../desktop/appshell/shell/KeyboardBrowser.js'), 'utf8');
const module = { exports: {} }; runInNewContext(source, { module, Intl });
const { createKeyboard } = module.exports;
const activeApis = [];
const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
function element(tag, text = '', box = rect(0, 0, 100, 20)) {
  const el = document.createElement(tag); el.textContent = text; el.style.opacity = '1';
  Object.defineProperty(el, 'innerText', { get() { return this.textContent; } });
  el.getClientRects = () => [box]; el.getBoundingClientRect = () => box;
  document.body.append(el); return el;
}
function setup(options = {}, answer = () => ({})) {
  const messages = [];
  window.worksKeyboardQuery = ({ request, onSuccess }) => { const message = JSON.parse(request); messages.push(message); onSuccess(JSON.stringify(answer(message))); };
  const api = createKeyboard(window, { install: false, ...options }); window.worksKeyboard = api; activeApis.push(api);
  return { api, messages };
}
function key(api, value, extra = {}) {
  const event = { type: 'keydown', key: value, target: document.activeElement, shiftKey: false, ctrlKey: false,
    metaKey: false, altKey: false, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra };
  api.key(event); return event;
}
async function flush(api) { await api.flush(); await api.flush(); }
afterEach(() => {
  activeApis.splice(0).forEach(api => api.dispose()); document.body.replaceChildren();
  delete window.worksKeyboard; delete window.worksKeyboardQuery; vi.restoreAllMocks();
});

describe('Works CEF primitive adapter without a GUI', () => {
  it('discovers controls through shadow roots and clips even a partially visible element', () => {
    const { api } = setup(); const button = element('button', 'button', rect(-2, 1, 1, 18));
    expect(api.visibleRect(button)).toMatchObject({ left: 0, right: 1 });
    button.disabled = true; expect(api.snapshot().candidates.some(item => item.enabled === false)).toBe(true);
    const host = element('div'); const shadow = host.attachShadow({ mode: 'open' });
    const nested = element('input'); shadow.append(nested);
    expect(api.snapshot().candidates).toHaveLength(2);
    nested.hidden = true; expect(api.snapshot().candidates).toHaveLength(1);
  });
  it('uses paragraph blocks instead of inline spans and never clicks a paragraph on copy', async () => {
    const { api, messages } = setup(); const p = element('p', 'paragraph'); p.style.display = 'block';
    const span = document.createElement('span'); span.textContent = ' inline'; p.append(span);
    const click = vi.fn(); p.click = click;
    expect(api.paragraphs([p, span])).toEqual([p]);
    expect(api.textMode()).toBe(true); await flush(api);
    api.select(api.snapshot().candidates[0].id); api.activate(false); await flush(api);
    expect(messages.filter(message => message.kind === 'copy').at(-1).text).toBe('paragraph inline');
    expect(api.mode).toBe('paragraph'); expect(api.selected).toBe(p); expect(click).not.toHaveBeenCalled();
    key(api, 'Escape'); expect(api.mode).toBe('controls');
  });
  it('measures legal emoji insertions and partially visible character cells', () => {
    const { api } = setup(); const text = 'a🙂b';
    expect(Array.from(api.offsets(text))).toEqual([0, 1, 3, 4]);
    const x = { 0: 0, 1: 10, 3: 30, 4: 40 };
    const model = { text, range: (a, b = a) => ({ getClientRects: () => [rect(x[a], 0, x[b], 10)] }) };
    const g = api.geometry(model, rect(29, 1, 31, 9));
    expect(Array.from(g.lines[0].visibleOffsets)).toEqual([1, 3, 4]);
    expect(g.lines[0].points.map(point => point.offset)).not.toContain(2);
  });
  it('remeasures after each queued text repeat, consumes once and sends Shift release without ending selection', async () => {
    const { api, messages } = setup({}, message => message.kind === 'text' ? { selection: { anchor: message.selection.anchor, caret: message.selection.caret + 1 } } : {});
    const el = element('div'); el.tabIndex = 0; el.focus(); let s = { anchor: 0, caret: 0 };
    api.registerEditor({ element: el, editable: true, geometry: () => ({ text: 'abc', lines: [], revision: 1 }), selection: () => s,
      apply: next => { s = next; }, pause: () => el.blur() });
    key(api, 'Shift'); key(api, 'Shift', { repeat: true }); key(api, 'Shift', { type: 'keyup' });
    const first = key(api, 'ArrowRight'); key(api, 'ArrowRight'); await flush(api);
    expect(messages.filter(message => message.kind === 'shift').map(message => message.down)).toEqual([true, true, false]);
    const steps = messages.filter(message => message.kind === 'text');
    expect(steps.map(message => message.selection.caret)).toEqual([0, 1]); expect(s.caret).toBe(2);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(messages.some(message => message.kind === 'window')).toBe(false);
    const letter = key(api, 'j'); expect(letter.preventDefault).not.toHaveBeenCalled();
  });
  it('keeps text selection untouched for associated Shift+up/down and does not activate a disabled option', async () => {
    const { api, messages } = setup(); const input = element('input'); input.setAttribute('aria-controls', 'choices'); input.focus();
    const list = element('div'); list.id = 'choices'; list.setAttribute('role', 'listbox');
    const item = element('div', 'unavailable'); item.setAttribute('role', 'option'); item.setAttribute('aria-selected', 'true'); item.setAttribute('aria-disabled', 'true'); list.append(item);
    const click = vi.fn(); item.click = click;
    const shift = key(api, 'ArrowDown', { shiftKey: true }); key(api, 'Enter'); await flush(api);
    expect(shift.preventDefault).toHaveBeenCalledOnce(); expect(click).not.toHaveBeenCalled();
    expect(messages.some(message => message.kind === 'list' || message.kind === 'text' || message.kind === 'window')).toBe(false);
  });
  it('copies the captured A selection after focus moves to B', async () => {
    const { api, messages } = setup(); const a = element('div'); a.tabIndex = 0;
    api.registerEditor({ element: a, editable: true, geometry: () => ({ text: 'abcd', lines: [] }), selection: () => ({ anchor: 1, caret: 3 }) });
    a.focus(); api.capturePalette(); await flush(api); const capture = messages.find(message => message.kind === 'palette').text;
    const b = element('input'); b.value = 'other'; b.focus();
    api.editCaptured(capture.token, 'copy'); await flush(api);
    expect(messages.filter(message => message.kind === 'copy').at(-1).text).toBe('bc');
  });
  it('captures original input and SELECT focus before the command panel takes focus', async () => {
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange(); range.getClientRects = () => []; return range;
    });
    const { api, messages } = setup();
    for (const tag of ['input', 'textarea', 'select', 'button']) {
      const field = element(tag); field.focus(); api.capturePalette(); await flush(api);
      const capture = messages.filter(message => message.kind === 'palette').at(-1);
      expect(capture.inField).toBe(tag !== 'button');
      if (tag === 'select') expect(capture.text).toBeNull();
    }
    const editor = element('div'); editor.classList.add('cm-editor'); editor.tabIndex = 0;
    editor.focus(); api.capturePalette(); await flush(api);
    expect(messages.filter(message => message.kind === 'palette').at(-1).inField).toBe(true);
  });
  it('converts element-boundary selections to visible text offsets and excludes hidden text', () => {
    const { api } = setup(); const p = element('p');
    const first = document.createElement('span'); first.textContent = 'ab';
    const hidden = document.createElement('span'); hidden.style.display = 'none'; hidden.textContent = 'hidden';
    const last = document.createElement('span'); last.textContent = '🙂c'; p.append(first, hidden, last);
    const model = api.rangeModel(p);
    expect(model.text).toBe('ab🙂c'); expect(model.toOffset(p, 1)).toBe(2);
    expect(model.toOffset(p, 3)).toBe(5); expect(model.toOffset(last.firstChild, 2)).toBe(4);
    expect(model.locate(4)).toEqual([last.firstChild, 2]);
  });
  it('counts an empty visual line and RTL character cells using actual supplied Range rectangles', () => {
    const { api } = setup(); const x = { 0: 30, 1: 20, 2: 10, 3: 0 };
    const rtl = api.geometry({ text: 'אבג', range: (a, b = a) => ({ getClientRects: () => [rect(Math.min(x[a], x[b]), 0, Math.max(x[a], x[b]), 10)] }) }, rect(19, 0, 21, 10));
    expect(Array.from(rtl.lines[0].visibleOffsets)).toEqual([0, 1, 2]);
    expect(rtl.lines[0].points.map(point => point.x)).toEqual([30, 20, 10, 0]);
    const coordinates = offset => offset < 2 ? rect(offset * 10, 0, offset * 10, 10) : offset === 2 ? rect(0, 10, 0, 20) : rect((offset - 3) * 10, 20, (offset - 3) * 10, 30);
    const empty = api.geometry({ text: 'a\n\nb', range: (a, b = a) => ({ getClientRects: () => {
      const r = coordinates(a), end = coordinates(b); return [a === b ? r : rect(r.left, r.top, end.left, r.bottom)];
    } }) }, rect(0, 0, 100, 30));
    expect(empty.lines.map(row => [row.start, row.end])).toEqual([[0, 1], [2, 2], [3, 4]]);
    expect(Array.from(empty.lines[1].visibleOffsets)).toEqual([2]);
  });
  it('keeps read-only block navigation, copy and its two Esc levels separate', async () => {
    const { api, messages } = setup({}, message => message.kind === 'text' ? { selection: { anchor: 0, caret: 2 } } : {});
    const p = element('p', 'abc'); p.style.display = 'block';
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => { const range = createRange();
      range.getClientRects = () => [rect(range.startOffset * 10, 0, range.endOffset * 10, 10)]; return range;
    });
    api.textMode(); const candidate = api.snapshot().candidates[0]; api.select(candidate.id); api.activate(true);
    expect(api.mode).toBe('block'); key(api, 'Shift'); key(api, 'Shift', { type: 'keyup' }); key(api, 'ArrowRight'); await flush(api);
    key(api, 'Enter'); await flush(api);
    expect(messages.filter(message => message.kind === 'copy').at(-1).text).toBe('ab');
    expect(messages.filter(message => message.kind === 'shift').map(message => message.down)).toEqual([true, false]);
    key(api, 'Escape'); expect(api.mode).toBe('paragraph'); expect(api.selected).toBe(p);
    key(api, 'Escape'); expect(api.mode).toBe('controls'); expect(api.selected).toBeNull();
  });
  it('runs an original editor shortcut against the captured selection after another field gains focus', async () => {
    const { api, messages } = setup(); const a = element('div'); a.tabIndex = 0;
    const actual = document.createElement('div'); a.append(actual); let s = { anchor: 1, caret: 3 };
    api.registerEditor({ element: a, keyboardElement: actual, kind: 'openleaf', editable: true,
      geometry: () => ({ text: 'abcd', lines: [] }), selection: () => s,
      focus: () => a.focus(), apply: value => { s = value; } });
    a.focus(); api.capturePalette(); await flush(api); const capture = messages.find(message => message.kind === 'palette').text;
    expect(capture.editorKind).toBe('openleaf'); const original = vi.fn(); actual.addEventListener('keydown', original);
    element('input').focus(); s = { anchor: 0, caret: 0 };
    expect(api.shortcut({ key: 'b', metaKey: true }, capture.token)).toBe(true);
    expect(s).toEqual({ anchor: 1, caret: 3 }); expect(original).toHaveBeenCalledOnce();
    expect(original.mock.calls[0][0]).toMatchObject({ key: 'b', metaKey: true, worksKeyboardOriginal: true });
    expect(api.shortcut({ key: 'b' }, capture.token)).toBe(false);
  });
  it('exposes the installed host before ready callbacks run and updates iframe offsets after resize', async () => {
    window.ResizeObserver = class { observe() {} disconnect() {} };
    const frame = element('iframe', '', rect(20, 30, 220, 130));
    Object.defineProperty(frame, 'offsetWidth', { value: 200 }); Object.defineProperty(frame, 'offsetHeight', { value: 100 });
    const posted = vi.spyOn(frame.contentWindow, 'postMessage'); const ready = vi.fn(() => window.worksKeyboard);
    window.addEventListener('works-keyboard-ready', ready, { once: true });
    const { api } = setup({ install: true }); expect(ready.mock.results[0].value).toBe(api);
    const first = posted.mock.calls.at(-1)[0]; expect(first).toMatchObject({ x: 20, y: 30, scaleX: 1, scaleY: 1 });
    frame.getBoundingClientRect = () => rect(40, 50, 240, 150); window.dispatchEvent(new Event('resize'));
    await new Promise(resolve => requestAnimationFrame(resolve)); await flush(api);
    expect(posted.mock.calls.at(-1)[0]).toMatchObject({ x: 40, y: 50 });
    api.capturePalette(); api.dispose(); const count = posted.mock.calls.length; await flush(api);
    expect(posted.mock.calls).toHaveLength(count);
  });
  it('clears real listener candidates on remove and once, and restores hooks on disposal', async () => {
    const original = window.EventTarget.prototype.addEventListener;
    window.ResizeObserver = class { observe() {} disconnect() {} };
    const { api } = setup({ install: true }); const target = element('div');
    const listener = vi.fn(); target.addEventListener('click', listener);
    expect(api.clickable(target)).toBe(true); target.removeEventListener('click', listener); expect(api.clickable(target)).toBe(false);
    target.addEventListener('click', listener, { once: true }); target.dispatchEvent(new Event('click'));
    expect(api.clickable(target)).toBe(false); expect(listener).toHaveBeenCalledOnce();
    api.dispose(); expect(window.EventTarget.prototype.addEventListener).toBe(original);
    await flush(api);
  });
});

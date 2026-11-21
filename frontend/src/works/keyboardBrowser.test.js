import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { registerDesktopMonaco } from './desktopKeyboardMonaco.js';
import { contextMenuTargetPrompt, desktopContextMenuTargets } from '../components/contextMenuTargets.js';
import { attachHostCommands } from './hostChrome.js';
const source = readFileSync(resolve(process.cwd(), '../../../../desktop/appshell/shell/DesktopKeyboardBrowser.js'), 'utf8');
const sandbox = { module: { exports: {} } }; vm.runInNewContext(source, sandbox);
const { createBridge } = sandbox.module.exports;
let bridge;
const originalRangeRects = window.Range.prototype.getClientRects;
afterEach(() => {
  bridge?.dispose(); bridge = null; document.body.innerHTML = '';
  if (originalRangeRects) window.Range.prototype.getClientRects = originalRangeRects; else delete window.Range.prototype.getClientRects;
  delete window.__worksDesktopKeyboardPageActions; delete window.worksFilesHost;
});
function box(element, left = 10, top = 10, width = 20, height = 20) {
  element.getBoundingClientRect = () => ({ left, top, right: left + width, bottom: top + height, width, height });
}
// Only layout is supplied: selection, text nodes and Range operations remain the
// real DOM objects used by the production bridge.
function rangeLayout(columns = 4) {
  window.Range.prototype.getClientRects = function () {
    const node = this.startContainer.nodeType === 3 ? this.startContainer.parentElement : this.startContainer;
    const block = node.closest('p,li,h1,pre,blockquote') || node;
    const offset = (container, index) => { const before = document.createRange(); before.selectNodeContents(block); before.setEnd(container, index); return before.toString().length; };
    const start = offset(this.startContainer, this.startOffset), end = offset(this.endContainer, this.endOffset), bounds = block.getBoundingClientRect();
    let scrollY = 0, scrollX = 0; for (let owner = block.parentElement; owner; owner = owner.parentElement) { scrollY += owner.scrollTop; scrollX += owner.scrollLeft; }
    const result = []; for (let index = start; index < Math.max(start + 1, end); index++) {
      const left = bounds.left + index % columns * 10 - scrollX, top = bounds.top + Math.floor(index / columns) * 16 - scrollY;
      result.push({ left, right: left + (this.collapsed ? 0 : 10), top, bottom: top + 16 });
    }
    return result;
  };
}
describe('production keyboard document boundary', () => {
  it('keeps original event APIs and discovers current native listeners without geometry deduplication', () => {
    const add = window.EventTarget.prototype.addEventListener, remove = window.EventTarget.prototype.removeEventListener;
    document.body.innerHTML = '<button>A</button><button>B</button><input type="checkbox"><input type="radio"><label>C</label><div id="native">custom</div>';
    document.querySelectorAll('body *').forEach(element => box(element));
    const custom = document.getElementById('native'); custom.addEventListener('click', () => {});
    bridge = createBridge(window, async () => ({}));
    bridge.native([{ node: custom, clickable: true }]);
    const snapshot = bridge.snapshot();
    expect(snapshot.targets).toHaveLength(6); expect(new Set(snapshot.targets.map(t => t.id)).size).toBe(6);
    expect(window.EventTarget.prototype.addEventListener).toBe(add); expect(window.EventTarget.prototype.removeEventListener).toBe(remove);
    bridge.native([]); expect(bridge.snapshot().targets).toHaveLength(5);
    custom.addEventListener('click', () => {}); bridge.native([{ node: custom }]);
    expect(bridge.snapshot().targets.find(t => t.label === 'custom')?.id).toBe(snapshot.targets.find(t => t.label === 'custom')?.id);
  });
  it('keeps independently clickable parents and children as distinct original actions', async () => {
    document.body.innerHTML = '<div id="parent" aria-label="parent action"><button aria-label="child action">child</button></div>';
    const parent = document.getElementById('parent'), child = parent.firstElementChild, actions = [];
    box(parent, 0, 0, 100, 100); box(child, 40, 40, 20, 20);
    parent.addEventListener('click', () => actions.push('parent'));
    child.addEventListener('click', event => { event.stopPropagation(); actions.push('child'); });
    bridge = createBridge(window, async () => ({}));
    bridge.native([{ node: parent, clickable: true }]);
    const targets = bridge.snapshot().targets;
    expect(targets).toHaveLength(2);
    const parentId = targets.find(target => target.label === 'parent action').id;
    const childId = targets.find(target => target.label === 'child action').id;
    expect(parentId).not.toBe(childId);
    expect((await bridge.apply({ targetId: parentId, operation: 'activate', arguments: {} })).kind).toBe('APPLIED');
    expect((await bridge.apply({ targetId: childId, operation: 'activate', arguments: {} })).kind).toBe('APPLIED');
    expect(actions).toEqual(['parent', 'child']);
  });
  it('retains actual offscreen focus while marking it ineligible for a new blue selection', async () => {
    document.body.innerHTML = '<a href="/ok">offscreen</a><button>visible</button><textarea></textarea>';
    const link = document.querySelector('a'); box(link, -288, 10, 256, 20); box(document.querySelector('button')); box(document.querySelector('textarea'));
    const observed = []; bridge = createBridge(window, async value => { observed.push(value); return {}; });
    link.focus(); expect(document.activeElement).toBe(link);
    expect(bridge.snapshot().targets.find(t => t.label === 'offscreen')?.visible).toBe(false);
    const input = document.querySelector('textarea'); input.focus();
    const command = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', metaKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(command); expect(command.defaultPrevented).toBe(false);
    const alt = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(alt); expect(alt.defaultPrevented).toBe(false);
    expect(observed.some(v => v.action === 'interaction' && v.editable)).toBe(true);
  });
  it('keeps current native click evidence in a closed shadow root and resolves original frame ancestry', async () => {
    document.body.innerHTML = '<div id="scroll"><div id="shadow"></div><iframe></iframe></div><div id="other"></div>';
    const scroller = document.getElementById('scroll'), host = document.getElementById('shadow'), frame = document.querySelector('iframe');
    document.querySelectorAll('body *').forEach(element => box(element, 0, 0, 100, 80));
    Object.defineProperties(scroller, { clientHeight: { value: 80 }, scrollHeight: { value: 320 } });
    const shadow = host.attachShadow({ mode: 'closed' }), button = document.createElement('button');
    button.textContent = 'original hidden shadow'; shadow.appendChild(button); box(button);
    let clicks = 0; button.addEventListener('click', () => { clicks++; });
    bridge = createBridge(window, async () => ({})); bridge.native([{ node: button, clickable: true }]);
    const id = bridge.identify(button);
    expect(bridge.snapshot().targets.some(target => target.id === id)).toBe(true);
    expect((await bridge.apply({ targetId: id, operation: 'activate' })).kind).toBe('APPLIED'); expect(clicks).toBe(1);
    const parent = bridge.frameAncestors(frame); expect(parent.nonce).toBe(bridge.nonce);
    expect(parent.ancestors).toContain(bridge.identify(scroller)); expect(parent.ancestors).not.toContain(bridge.identify(document.getElementById('other')));
    bridge.native([]); expect(bridge.snapshot().targets.some(target => target.id === id)).toBe(false);
  });
  it('resolves the explicit same ID, preserves original click and retires a replaced node', async () => {
    document.body.innerHTML = '<button>original</button>'; const button = document.querySelector('button'); box(button);
    let clicks = 0; button.addEventListener('click', () => { clicks++; });
    bridge = createBridge(window, async () => ({})); const id = bridge.snapshot().targets[0].id;
    bridge.render({ mode: 'WINDOW', targetId: id });
    expect((await bridge.apply({ targetId: id, operation: 'activate' })).kind).toBe('APPLIED'); expect(clicks).toBe(1);
    button.replaceWith(button.cloneNode(true)); expect((await bridge.apply({ targetId: id, operation: 'activate' })).kind).toBe('STALE'); expect(clicks).toBe(1);
  });
  it('uses the actual scroll dimensions and releases key-up by physical code', async () => {
    document.body.innerHTML = '<div id="scroll"><button>B</button></div>'; const element = document.getElementById('scroll'); box(element);
    Object.defineProperties(element, { scrollHeight: { value: 537 }, clientHeight: { value: 101 }, scrollWidth: { value: 201 }, clientWidth: { value: 101 } });
    const observed = []; bridge = createBridge(window, async data => { observed.push(data); return {}; });
    const id = bridge.identify(element); expect(bridge.extent(id, 'Y').range).toBe(436);
    await bridge.apply({ targetId: id, operation: 'scroll', arguments: { axis: 'Y', position: 600 } }); expect(element.scrollTop).toBe(436);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', code: 'KeyJ', shiftKey: true, bubbles: true, cancelable: true }));
    const release = new KeyboardEvent('keyup', { key: 'j', code: 'KeyJ', bubbles: true, cancelable: true }); document.body.dispatchEvent(release);
    expect(release.defaultPrevented).toBe(true); expect(observed.filter(v => v.action === 'key').map(v => v.phase)).toEqual(['DOWN', 'UP']);
  });
  it('registers the original Monaco before bridge installation, reuses actions, and retires its lifetime', async () => {
    document.body.innerHTML = '<div id="original-editor"><textarea></textarea></div>';
    const element = document.getElementById('original-editor'); box(element, 10, 10, 100, 40);
    let value = 'a👩‍💻b', caret = 0, version = 1, dead;
    const actions = [], model = { getValue: () => value, getVersionId: () => version,
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }), getOffsetAt: position => position.column - 1 };
    const instance = { getDomNode: () => element, getModel: () => model,
      getSelection: () => ({ getSelectionStart: () => model.getPositionAt(0), getPosition: () => model.getPositionAt(caret) }),
      getLayoutInfo: () => ({ height: 40, contentLeft: 0, contentWidth: 100 }), getScrollLeft: () => 0, getScrollTop: () => 0,
      getScrolledVisiblePosition: position => ({ left: ({1:0,2:10,7:20,8:30})[position.column] ?? 20, top: 0, height: 16 }),
      setSelection: selection => { caret = selection.head.column - 1; }, revealPosition: position => actions.push(['reveal', position]),
      getAction: word => ({ isSupported: () => true, run: () => actions.push(['action', word]) }), getOption: () => false,
      focus() {}, trigger: (...args) => actions.push(['trigger', ...args]), onDidDispose: fn => { dead = fn; return { dispose() {} }; } };
    const monaco = { Selection: { fromPositions: (anchor, head) => ({ anchor, head }) }, editor: { EditorOption: { readOnly: 1 } } };
    const release = registerDesktopMonaco(instance, monaco, window);
    bridge = createBridge(window, async () => ({}));
    const snapshot = bridge.snapshot(); expect(snapshot.targets).toHaveLength(1);
    const id = snapshot.targets[0].id;
    expect(bridge.text(id).lines[0].visibleOffsets).toEqual([0, 1, 6, 7]);
    expect((await bridge.apply({ targetId: id, operation: 'select', arguments: { anchor: '0', caret: '6', text: value } })).kind).toBe('APPLIED');
    expect(caret).toBe(6); expect(actions[0][0]).toBe('reveal');
    expect((await bridge.apply({ targetId: id, operation: 'editor-action', arguments: { word: 'undo' } })).kind).toBe('APPLIED');
    expect(actions.at(-1)).toEqual(['action', 'undo']);
    value = 'changed'; version++;
    expect((await bridge.apply({ targetId: id, operation: 'select', arguments: { anchor: '0', caret: '1', text: 'old' } })).kind).toBe('STALE');
    dead(); release(); expect(window.__worksDesktopKeyboardEditors.has(element)).toBe(false);
  });
  it('uses only the original input association and closes one original list layer', async () => {
    document.body.innerHTML = '<input aria-controls="choices" aria-expanded="true"><div id="choices" role="listbox"><div role="option">one</div><div role="option" aria-disabled="true">two</div></div><div role="listbox"><div role="option">unrelated</div></div>';
    document.querySelectorAll('body *').forEach(element => box(element));
    const input = document.querySelector('input'), choices = document.getElementById('choices'), observed = [];
    let originalEscapes = 0;
    input.addEventListener('keydown', event => { if (event.key === 'Escape') { originalEscapes++; input.setAttribute('aria-expanded', 'false'); choices.style.display = 'none'; } });
    bridge = createBridge(window, async data => { observed.push(data); return {}; }); input.focus();
    const id = bridge.identify(input), current = bridge.list(id);
    expect(current.items).toHaveLength(2); expect(current.items[1].enabled).toBe(false);
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(down); expect(down.defaultPrevented).toBe(true);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    const result = await bridge.apply({ targetId: id, operation: 'list-select', arguments: { item: current.items[1].id } });
    expect(result.values.selectedTargetId).toBe(current.items[1].id); expect(document.activeElement).toBe(input);
    await bridge.apply({ targetId: id, operation: 'list-dismiss' });
    expect(originalEscapes).toBe(1); expect(bridge.list(id)).toBeNull(); expect(document.activeElement).toBe(input);
    expect(observed.filter(data => data.action === 'key' && data.key === 'Escape')).toHaveLength(0);
  });
  it('passes every original Ctrl/Cmd Z/X/C/V on webpages and editors exactly once', () => {
    document.body.innerHTML = '<button>page</button><textarea>original</textarea>';
    const original = [], observed = []; bridge = createBridge(window, async data => { observed.push(data); return {}; });
    for (const target of document.querySelectorAll('button,textarea')) {
      target.addEventListener('keydown', event => original.push(event));
      for (const modifier of ['ctrlKey', 'metaKey']) for (const key of ['z', 'x', 'c', 'v']) {
        const event = new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, [modifier]: true, bubbles: true, cancelable: true });
        target.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
        const up = new KeyboardEvent('keyup', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true });
        target.dispatchEvent(up); expect(up.defaultPrevented).toBe(false);
      }
    }
    expect(original).toHaveLength(16); expect(observed.filter(data => data.action === 'key')).toHaveLength(0);
  });
  it('preserves unmatched Escape and uppercase C, and owns lowercase c only in the original web control scope', () => {
    document.body.innerHTML = '<button>original control</button>'; box(document.querySelector('button'));
    bridge = createBridge(window, async () => ({}));
    function press(key) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      document.body.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
      return event.defaultPrevented;
    }
    expect(press('Escape')).toBe(false); expect(press('C')).toBe(false); expect(press('c')).toBe(false);
    bridge.render({ mode: 'WINDOW', paragraphsAvailable: true }); expect(press('c')).toBe(true);
    bridge.render({ mode: 'PARAGRAPHS', paragraphsAvailable: true }); expect(press('c')).toBe(false); expect(press('Escape')).toBe(true);
  });
  it('publishes and invokes original page actions without substituting a selected node', async () => {
    let calls = 0; window.__worksDesktopKeyboardPageActions = { compile: () => { calls++; } };
    bridge = createBridge(window, async () => ({}));
    expect(bridge.snapshot().pageActions).toContain('compile');
    expect((await bridge.apply({ operation: 'page-action', arguments: { word: 'compile' } })).kind).toBe('ORIGINAL_ACCEPTED');
    expect(calls).toBe(1);
    expect((await bridge.apply({ operation: 'page-action', arguments: { word: 'unavailable' } })).kind).toBe('UNAVAILABLE');
  });
  it('uses the same original prompt for mouse and all six explicit file targets', async () => {
    const prompts = [], hovers = [], errors = [], reads = []; let published = 0;
    const mutations = { closeHovers: () => hovers.push('hover'), closeTopPrompt: () => hovers.push('top'), showPrompt: value => prompts.push(value) };
    const items = [{ source: 'other-backend', path: '/unopened/file.txt', type: 'file' }];
    const getter = { sourcePermissions: () => ({ modify: true, download: true, delete: true, create: true }) };
    const target = desktopContextMenuTargets({ mutations, getters: getter, read: async (source, path) => {
      reads.push([source, path]); return { source, path, type: path.endsWith('dir') ? 'directory' : 'file' };
    } });
    const commands = Object.fromEntries(['renameTarget', 'copyTarget', 'moveTarget', 'deleteTarget', 'newFileTarget', 'newDirTarget'].map(word => [word, args => target(word, args)]));
    window.worksFilesHost = attachHostCommands({}, commands, async () => { published++; }, error => errors.push(error));
    bridge = createBridge(window, async () => ({}));
    expect(bridge.snapshot().pageActions).toHaveLength(6);
    for (const [word, original] of [['renameTarget', 'rename'], ['copyTarget', 'copy'], ['moveTarget', 'move'], ['deleteTarget', 'delete']]) {
      contextMenuTargetPrompt(mutations, original, items); const mouse = prompts.at(-1);
      const result = await bridge.apply({ operation: 'page-action', arguments: { word, source: items[0].source, path: items[0].path } });
      expect(result.kind).toBe('ORIGINAL_ACCEPTED'); expect(prompts.at(-1)).toEqual(mouse);
    }
    for (const [word, original] of [['newFileTarget', 'newFile'], ['newDirTarget', 'newDir']]) {
      contextMenuTargetPrompt(mutations, original, [], { source: 'other-backend', path: '/unopened/dir' }); const mouse = prompts.at(-1);
      expect((await bridge.apply({ operation: 'page-action', arguments: { word, source: 'other-backend', path: '/unopened/dir' } })).kind).toBe('ORIGINAL_ACCEPTED');
      expect(prompts.at(-1)).toEqual(mouse);
    }
    const count = prompts.length; getter.sourcePermissions = () => ({ modify: false });
    expect((await bridge.apply({ operation: 'page-action', arguments: { word: 'renameTarget', source: 'other-backend', path: '/unopened/file.txt' } })).kind).toBe('FAILED');
    expect(prompts.length).toBe(count); expect(errors).toHaveLength(1); expect(published).toBe(7);
    expect(reads.every(([source]) => source === 'other-backend')).toBe(true); expect(hovers).toContain('top');
  });
  it('navigates original paragraph blocks, selects real text, copies only its selection and exits without clicking links', async () => {
    document.body.innerHTML = '<blockquote><p>abcd<a href="/link">efgh</a></p></blockquote><ul><li><p>second</p></li></ul>';
    document.querySelectorAll('body *').forEach(element => box(element, 10, 10, 80, 64)); rangeLayout();
    const observed = []; let clicks = 0; document.querySelector('a').addEventListener('click', () => { clicks++; });
    bridge = createBridge(window, async data => { observed.push(data); return {}; });
    expect(bridge.snapshot().targets).toHaveLength(1);
    bridge.render({ mode: 'PARAGRAPHS', targetId: null });
    const paragraphs = bridge.snapshot().targets; expect(paragraphs.map(item => item.label)).toEqual(['abcdefgh', 'second']);
    const id = paragraphs[0].id;
    expect((await bridge.apply({ targetId: id, operation: 'paragraph-copy' })).copiedText).toBe('abcdefgh');
    expect((await bridge.apply({ targetId: id, operation: 'block-enter' })).kind).toBe('APPLIED');
    bridge.render({ mode: 'BLOCK_TEXT', targetId: id });
    expect(document.querySelector('[data-works-keyboard-decoration=caret]').style.display).toBe('block');
    const revision = bridge.text(id).revision;
    expect((await bridge.apply({ targetId: id, operation: 'select', arguments: { anchor: '1', caret: '6', text: 'abcdefgh', revision } })).kind).toBe('APPLIED');
    expect(window.getSelection().toString()).toBe('bcdef');
    expect((await bridge.apply({ targetId: id, operation: 'selection-copy' })).copiedText).toBe('bcdef');
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(arrow); document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(arrow.defaultPrevented).toBe(true); expect(observed.filter(item => item.action === 'key').map(item => item.targetId)).toEqual([id, id]);
    const letter = new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }); document.body.dispatchEvent(letter); expect(letter.defaultPrevented).toBe(false);
    await bridge.apply({ targetId: paragraphs[1].id, operation: 'block-enter' });
    expect((await bridge.apply({ targetId: id, operation: 'selection-copy' })).kind).toBe('UNAVAILABLE');
    await bridge.apply({ targetId: id, operation: 'block-enter' });
    expect((await bridge.apply({ targetId: id, operation: 'selection-copy' })).kind).toBe('UNAVAILABLE');
    await bridge.apply({ targetId: id, operation: 'block-exit' }); bridge.render({ mode: 'PARAGRAPHS', targetId: id });
    expect(window.getSelection().rangeCount).toBe(0); expect(document.querySelector('[data-works-keyboard-decoration=caret]').style.display).toBe('none'); expect(clicks).toBe(0);
  });
  it('rejects the old text generation even if bytes were restored, and reveals the original Range along its scroll ancestor', async () => {
    document.body.innerHTML = '<div id="scroll" style="overflow-y:auto"><p>abcdefghijklmnop</p></div>';
    const scroller = document.getElementById('scroll'), paragraph = document.querySelector('p');
    box(scroller, 10, 10, 80, 40); box(paragraph, 10, 10, 80, 64); rangeLayout();
    Object.defineProperties(scroller, { scrollHeight: { value: 100 }, clientHeight: { value: 40 } });
    bridge = createBridge(window, async () => ({})); const id = bridge.identify(paragraph);
    const old = bridge.text(id); paragraph.firstChild.data = 'changed'; paragraph.firstChild.data = old.text;
    expect(bridge.text(id).revision).not.toBe(old.revision);
    expect((await bridge.apply({ targetId: id, operation: 'editor-action', arguments: { word: 'copy', anchor: '0', caret: '1', revision: old.revision } })).kind).toBe('STALE');
    bridge.render({ mode: 'BLOCK_TEXT', targetId: id });
    expect((await bridge.apply({ targetId: id, operation: 'select', arguments: { anchor: '12', caret: '12', text: old.text } })).kind).toBe('APPLIED');
    expect(scroller.scrollTop).toBeGreaterThan(0); expect(window.getSelection().focusNode).toBe(paragraph.firstChild); expect(window.getSelection().focusOffset).toBe(12);
  });
});

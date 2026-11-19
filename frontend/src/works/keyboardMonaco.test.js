import { describe, expect, it, vi } from 'vitest';
import { createMonacoKeyboardAdapter, registerMonacoKeyboard } from './keyboardMonaco.js';

function fixture(text = 'abcdefgh', breaks = [0, 4, 8]) {
  const position = offset => ({ lineNumber: 1, column: offset + 1 });
  const toView = p => { const offset = p.column - 1; const row = breaks.slice(1).findIndex(end => offset < end);
    const index = row < 0 ? breaks.length - 2 : row; return { lineNumber: index + 1, column: offset - breaks[index] + 1 }; };
  const fromView = p => position(breaks[p.lineNumber - 1] + p.column - 1);
  const model = { getValue: () => text, getOffsetAt: p => p.column - 1, getPositionAt: position, getVersionId: () => 7 };
  const vm = { getLineCount: () => breaks.length - 1, getLineMinColumn: () => 1,
    getLineMaxColumn: row => breaks[row] - breaks[row - 1] + 1,
    coordinatesConverter: { convertModelPositionToViewPosition: toView, convertViewPositionToModelPosition: fromView },
    viewLayout: { getVerticalOffsetForLineNumber: row => (row - 1) * 20, getLineHeightForLineNumber: () => 20 } };
  const element = document.createElement('div'); element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 25 });
  const editor = { _modelData: { viewModel: vm, view: { _viewLines: { visibleRangeForPosition: p => ({ left: (p.column - 1) * 10 }) } } },
    getDomNode: () => element, getModel: () => model, getPosition: () => position(2), getRawOptions: () => ({ readOnly: false }),
    getLayoutInfo: () => ({ contentLeft: 20 }), getScrollTop: () => 0, getScrollLeft: () => 25,
    getScrolledVisiblePosition: vi.fn(() => ({ top: 0, left: 20, height: 20 })),
    getSelection: () => ({ getSelectionStart: () => position(1), getPosition: () => position(3) }),
    setSelection: vi.fn(), revealPositionIfOutsideViewport: vi.fn(), focus: vi.fn(), trigger: vi.fn(),
    onDidDispose: callback => { editor.disposeCallback = callback; return { dispose: vi.fn() }; } };
  const monaco = { Position: class { constructor(lineNumber, column) { this.lineNumber = lineNumber; this.column = column; } },
    Selection: { fromPositions: (anchor, caret) => ({ anchor, caret }) }, editor: { ScrollType: { Immediate: 1 } } };
  return { editor, monaco, element };
}
describe('Monaco actual-layout adapter', () => {
  it('uses wrapped view rows, partial rows and horizontal scrolling when counting characters', () => {
    const { editor, monaco } = fixture(); const adapter = createMonacoKeyboardAdapter(editor, monaco);
    const g = adapter.geometry(); expect(g.lines.map(row => [row.start, row.end])).toEqual([[0, 4], [4, 8]]);
    expect(g.lines.every(row => row.visible)).toBe(true); expect(g.lines[0].visibleOffsets).toEqual([2, 3, 4]);
    expect(g.lines[0].points[0].x).toBe(-5); expect(editor.getScrolledVisiblePosition).toHaveBeenCalled();
  });
  it('never splits emoji and preserves anchor direction through the native selection/reveal API', () => {
    const { editor, monaco } = fixture('a🙂b', [0, 4]); const adapter = createMonacoKeyboardAdapter(editor, monaco);
    expect(adapter.geometry().lines[0].points.map(point => point.offset)).toEqual([0, 1, 3, 4]);
    adapter.apply({ anchor: 3, caret: 1 }); expect(editor.setSelection).toHaveBeenCalledWith({ anchor: { lineNumber: 1, column: 4 }, caret: { lineNumber: 1, column: 2 } });
    expect(editor.revealPositionIfOutsideViewport).toHaveBeenCalledWith({ lineNumber: 1, column: 2 }, 1);
    expect(adapter.selection()).toEqual({ anchor: 1, caret: 3 });
  });
  it('lets the original editor reveal an adjacent partially clipped row before measuring a small step', () => {
    const { editor, monaco } = fixture(); createMonacoKeyboardAdapter(editor, monaco).geometry({ direction: 'DOWN', big: false });
    expect(editor.revealPositionIfOutsideViewport).toHaveBeenCalledWith(expect.objectContaining({ column: 5 }), 1);
  });
  it('does not query rendered ranges for invisible rows or rescan other rows for every character', () => {
    const { editor, monaco } = fixture('a'.repeat(120), Array.from({ length: 31 }, (_, index) => index * 4));
    const range = vi.fn(p => ({ left: (p.column - 1) * 10 })); editor._modelData.view._viewLines.visibleRangeForPosition = range;
    const g = createMonacoKeyboardAdapter(editor, monaco).geometry();
    expect(g.lines).toHaveLength(30); expect(g.lines.filter(row => row.visible)).toHaveLength(2);
    expect(range).toHaveBeenCalledTimes(10); expect(range.mock.calls.every(([p]) => p.lineNumber <= 2)).toBe(true);
    expect(g.lines[29].visibleOffsets).toEqual([]);
  });
  it('uses original edit actions, enables only after the desktop host arrives and unregisters on disposal', () => {
    const { editor, monaco } = fixture(); const win = new EventTarget(); win.document = document;
    const adapter = registerMonacoKeyboard(editor, monaco, win); adapter.edit('undo');
    expect(editor.trigger).toHaveBeenCalledWith('works-keyboard', 'undo', null);
    const unregister = vi.fn(); win.worksKeyboard = { registerEditor: vi.fn(() => unregister) };
    win.dispatchEvent(new Event('works-keyboard-ready')); win.dispatchEvent(new Event('works-keyboard-ready'));
    expect(win.worksKeyboard.registerEditor).toHaveBeenCalledOnce(); editor.disposeCallback(); expect(unregister).toHaveBeenCalledOnce();
  });
  it('reads undo and redo availability from the captured editor model', () => {
    const { editor, monaco } = fixture(); const model = editor.getModel();
    model.canUndo = () => true; model.canRedo = () => false;
    const adapter = createMonacoKeyboardAdapter(editor, monaco);
    expect(adapter.available('undo')).toBe(true); expect(adapter.available('redo')).toBe(false);
    model.canUndo = () => false; model.canRedo = () => true;
    expect(adapter.available('undo')).toBe(false); expect(adapter.available('redo')).toBe(true);
  });
});

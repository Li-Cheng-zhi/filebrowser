// Original Monaco 0.57.0 instance adapter; source: FilePage.vue at 1a762e08.
// No extra model, undo stack, or editor is created.
const actionIds = { copy: 'editor.action.clipboardCopyAction', cut: 'editor.action.clipboardCutAction',
  paste: 'editor.action.clipboardPasteAction', undo: 'undo', redo: 'redo', selectall: 'editor.action.selectAll', find: 'actions.find' };
export function registerDesktopMonaco(instance, monaco, win = window) {
  const element = instance.getDomNode(), registry = win.__worksDesktopKeyboardEditors ||= new Map();
  let retired = false;
  const boundaries = text => [0, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.index + part.segment.length)];
  const adapter = {
    geometry() {
      const model = instance.getModel(); if (retired || !model || instance.inComposition) return null;
      const text = model.getValue(), selection = instance.getSelection(), layout = instance.getLayoutInfo();
      const lines = [], offsets = boundaries(text);
      for (let i = 0; i < offsets.length; i++) {
        const offset = offsets[i], position = model.getPositionAt(offset), box = instance.getScrolledVisiblePosition(position);
        if (!box || box.top + box.height <= 0 || box.top >= layout.height) continue;
        let row = lines.find(line => line.top === box.top);
        if (!row) { row = { top: box.top, start: offset, end: offset, points: [], visibleOffsets: [], visible: true }; lines.push(row); }
        row.start = Math.min(row.start, offset); row.end = Math.max(row.end, offset);
        // Monaco's original rendered view returns -1 for an unrendered column.
        if (box.left < layout.contentLeft - instance.getScrollLeft() - .5) continue;
        row.points.push({ offset, x: box.left });
        const next = offsets[i + 1] == null ? null : instance.getScrolledVisiblePosition(model.getPositionAt(offsets[i + 1]));
        if (next && next.top === box.top && Math.max(box.left, next.left) > layout.contentLeft && Math.min(box.left, next.left) < layout.contentLeft + layout.contentWidth)
          row.visibleOffsets.push(offset, offsets[i + 1]);
      }
      lines.sort((a, b) => a.top - b.top);
      for (const line of lines) line.visibleOffsets = [...new Set(line.visibleOffsets)].sort((a, b) => a - b);
      return { text, revision: String(model.getVersionId()),
        selection: { anchor: model.getOffsetAt(selection.getSelectionStart()), caret: model.getOffsetAt(selection.getPosition()) }, lines, originalVertical: true };
    },
    select(anchor, caret) {
      const model = instance.getModel(); if (retired || !model) return false;
      instance.setSelection(monaco.Selection.fromPositions(model.getPositionAt(anchor), model.getPositionAt(caret)));
      instance.revealPosition(model.getPositionAt(caret)); return true;
    },
    moveOriginal(args) {
      const model = instance.getModel(); if (retired || !model || model.getValue() !== args.text) return false;
      const before = instance.getSelection(), start = Number(args.start), selecting = args.selecting === 'true';
      if (model.getOffsetAt(before.getPosition()) !== start) adapter.select(selecting ? Number(args.anchor) : start, start);
      instance.trigger('works.keyboard', 'cursorMove', { to: args.direction === 'UP' ? 'up' : 'down', by: 'wrappedLine', value: 1, select: selecting });
      return true;
    },
    action(word) {
      if (retired) return false;
      const id = actionIds[word]; if (!id) return false;
      if (['cut', 'paste', 'undo', 'redo'].includes(word) && instance.getOption(monaco.editor.EditorOption.readOnly)) return false;
      const action = instance.getAction(id); if (action?.isSupported && !action.isSupported()) return false;
      instance.focus(); if (action) action.run(); else instance.trigger('works.keyboard', id, null); return true;
    },
  };
  registry.set(element, adapter); win.__worksDesktopKeyboard?.changedEditors();
  const disposed = instance.onDidDispose(() => release());
  function release() {
    if (retired) return; retired = true;
    if (registry.get(element) === adapter) registry.delete(element);
    disposed?.dispose(); win.__worksDesktopKeyboard?.changedEditors();
  }
  return release;
}

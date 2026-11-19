// Works desktop adapter for the existing Monaco factory (monaco.js, 00f6337bd729).
// Visual positions use Monaco 0.57's view model/rendered ranges, reviewed against
// the archived VS Code codeEditorWidget/viewModel/cursorMoveOperations sources.
export function createMonacoKeyboardAdapter(editor, monaco, win = window) {
  const element = editor.getDomNode();
  const boundaries = text => [0, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
    part => part.index + part.segment.length)];
  function geometry(step = {}) {
    const model = editor.getModel(), vm = editor._modelData?.viewModel;
    if (!model || !vm) return { text: '', lines: [], revision: 'disposed' };
    const text = model.getValue(), all = boundaries(text), box = element.getBoundingClientRect();
    const lowerBound = offset => { let lo = 0, hi = all.length; while (lo < hi) {
      const mid = (lo + hi) >>> 1; if (all[mid] < offset) lo = mid + 1; else hi = mid;
    } return lo; };
    const layout = editor.getLayoutInfo();
    const clip = win.worksKeyboard?.textClip(element) || { left: box.left, top: box.top,
      right: box.right, bottom: box.bottom };
    const current = vm.coordinatesConverter.convertModelPositionToViewPosition(editor.getPosition());
    // Let the editor reveal the actual adjacent view line before measuring a small
    // step beyond the viewport. This uses its existing scrolling/rendering path.
    if (!step.big && ['UP', 'DOWN'].includes(step.direction)) {
      const row = Math.max(1, Math.min(vm.getLineCount(), current.lineNumber + (step.direction === 'UP' ? -1 : 1)));
      const pos = vm.coordinatesConverter.convertViewPositionToModelPosition(new monaco.Position(row, vm.getLineMinColumn(row)));
      const y = vm.viewLayout.getVerticalOffsetForLineNumber(row) - editor.getScrollTop();
      const height = vm.viewLayout.getLineHeightForLineNumber(row);
      if (box.top + y < clip.top || box.top + y + height > clip.bottom) editor.revealPositionIfOutsideViewport(pos, monaco.editor.ScrollType.Immediate);
    }
    const lines = [];
    for (let row = 1; row <= vm.getLineCount(); row++) {
      const min = vm.getLineMinColumn(row), max = vm.getLineMaxColumn(row);
      const position = col => vm.coordinatesConverter.convertViewPositionToModelPosition(new monaco.Position(row, col));
      const first = position(min), last = position(max), start = model.getOffsetAt(first), end = model.getOffsetAt(last);
      const top = box.top + vm.viewLayout.getVerticalOffsetForLineNumber(row) - editor.getScrollTop();
      const height = vm.viewLayout.getLineHeightForLineNumber(row);
      const visible = top + height > clip.top && top < clip.bottom;
      const points = [], visibleOffsets = [], renderedOffsets = new Set();
      // getScrolledVisiblePosition flushes pending rendering. Its x already includes
      // horizontal scrolling. Direct view ranges also preserve the end of a wrap row.
      if (visible) editor.getScrolledVisiblePosition(first);
      const rangeAt = col => editor._modelData?.view?._viewLines?.visibleRangeForPosition(new monaco.Position(row, col));
      for (let index = lowerBound(start); index < all.length && all[index] <= end; index++) {
        const offset = all[index];
        const pos = model.getPositionAt(offset);
        const viewPos = vm.coordinatesConverter.convertModelPositionToViewPosition(pos);
        const col = offset === end ? max : offset === start ? min : viewPos.column;
        const rendered = visible ? rangeAt(col) : null;
        const x = rendered ? box.left + layout.contentLeft + rendered.left - editor.getScrollLeft() : null;
        if (rendered) renderedOffsets.add(offset);
        points.push({ offset, x: x ?? 0 });
      }
      for (let index = 0; index < points.length - 1; index++) {
        const a = points[index], b = points[index + 1];
        if (visible && renderedOffsets.has(a.offset) && renderedOffsets.has(b.offset) && Math.max(a.x, b.x) > Math.max(clip.left, box.left + layout.contentLeft) && Math.min(a.x, b.x) < clip.right) visibleOffsets.push(a.offset, b.offset);
      }
      if (visible && start === end) visibleOffsets.push(start);
      lines.push({ start, end, points, visibleOffsets: [...new Set(visibleOffsets)], visible });
    }
    return { text, lines, revision: JSON.stringify([model.getVersionId(), editor.getScrollTop(), editor.getScrollLeft(), layout, lines.map(row => [row.start, row.end, row.visibleOffsets, row.visible])]) };
  }
  return {
    element, singleLine: false,
    get editable() { return !editor.getRawOptions().readOnly; },
    geometry,
    selection() { const model = editor.getModel(), s = editor.getSelection(); return {
      anchor: model.getOffsetAt(s.getSelectionStart()), caret: model.getOffsetAt(s.getPosition()),
    }; },
    apply(s) { const model = editor.getModel(); if (!model) return;
      editor.setSelection(monaco.Selection.fromPositions(model.getPositionAt(s.anchor), model.getPositionAt(s.caret)));
      editor.revealPositionIfOutsideViewport(model.getPositionAt(s.caret), monaco.editor.ScrollType.Immediate);
    },
    focus: () => editor.focus(),
    pause() { win.worksKeyboard?.pause(element); },
    available(word) {
      const model = editor.getModel();
      if (word === 'undo') return model?.canUndo() === true;
      if (word === 'redo') return model?.canRedo() === true;
      return true;
    },
    edit(word) {
      const command = { selectall: 'editor.action.selectAll', copy: 'editor.action.clipboardCopyAction',
        paste: 'editor.action.clipboardPasteAction', cut: 'editor.action.clipboardCutAction', undo: 'undo', redo: 'redo' }[word];
      if (command) editor.trigger('works-keyboard', command, null);
    },
  };
}

export function registerMonacoKeyboard(editor, monaco, win = window) {
  const adapter = createMonacoKeyboardAdapter(editor, monaco, win);
  let unregister;
  const ready = () => { if (!unregister && win.worksKeyboard) unregister = win.worksKeyboard.registerEditor(adapter); };
  win.addEventListener('works-keyboard-ready', ready); ready();
  const disposable = editor.onDidDispose(() => { unregister?.(); win.removeEventListener('works-keyboard-ready', ready); disposable.dispose(); });
  return adapter;
}

export function installMonacoKeyboard(monaco, win = window) {
  return monaco.editor.onDidCreateEditor(editor => registerMonacoKeyboard(editor, monaco, win));
}

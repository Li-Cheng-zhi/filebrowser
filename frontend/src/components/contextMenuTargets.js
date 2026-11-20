// Original ContextMenu.vue prompt functions at 1a762e08, extracted at function
// granularity. Mouse actions and desktop commands share these same explicit items.
export function contextMenuTargetPrompt(mutations, word, items, base = null, parentItems = []) {
  if (word === 'delete') mutations.closeTopPrompt(); else mutations.closeHovers();
  const props = word === 'rename' ? { item: items[0], parentItems } :
    word === 'newFile' || word === 'newDir' ? { base } :
      { items, ...(word === 'copy' || word === 'move' ? { operation: word } : {}) };
  mutations.showPrompt({ name: word, props });
  return { kind: 'ORIGINAL_ACCEPTED' };
}

/** Metadata and permissions come from the original resource reader. A command
 * cannot substitute the current page/selection for a missing explicit target. */
export function desktopContextMenuTargets({ mutations, getters, read }) {
  return async (word, args) => {
    if (!args?.source || typeof args.path !== 'string') throw new Error('缺少明确文件目标');
    const item = await read(args.source, args.path);
    if (!item || item.source !== args.source || item.path !== args.path) throw new Error('文件目标已改变');
    const permission = { renameTarget: 'modify', copyTarget: 'download', moveTarget: 'modify', deleteTarget: 'delete', newFileTarget: 'create', newDirTarget: 'create' }[word];
    if (!permission || !getters.sourcePermissions(args.source)[permission]) throw new Error('当前文件权限不允许此操作');
    if (word === 'newFileTarget' || word === 'newDirTarget') {
      if (!(item.isDir || item.type === 'directory')) throw new Error('新建目标必须是目录');
      return contextMenuTargetPrompt(mutations, word === 'newFileTarget' ? 'newFile' : 'newDir', [], { source: item.source, path: item.path });
    }
    return contextMenuTargetPrompt(mutations, { renameTarget: 'rename', copyTarget: 'copy', moveTarget: 'move', deleteTarget: 'delete' }[word], [item]);
  };
}

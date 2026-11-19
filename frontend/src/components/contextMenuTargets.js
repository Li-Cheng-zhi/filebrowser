// Explicit-target prompt methods extracted from ContextMenu.vue at 00f6337bd729.
// Mouse and Works commands use the same existing prompts without changing selected.
export function showContextTarget(name, props, { state, getters, mutations }) {
  const items = props.items || (props.item ? [props.item] : []);
  const source = item => item?.source || state.req?.source || state.sources?.current || '';
  const permission = (item, key) => !!getters.sourcePermissions(source(item))[key];
  const canCopy = getters.isShare()
    ? items.every(item => permission(item, 'modify'))
    : items.every(item => permission(item, 'download')) && (state.user?.scopes || []).some(scope => getters.canCreateInSource(scope.name));
  const allowed = name === 'rename' ? !!props.item && permission(props.item, 'modify')
    : name === 'move' ? items.length > 0 && items.every(item => permission(item, 'modify'))
      : name === 'copy' ? items.length > 0 && canCopy
        : name === 'delete' ? items.length > 0 && items.every(item => permission(item, 'delete'))
          : ['newFile', 'newDir'].includes(name) && permission(props.base, 'create');
  if (!allowed) return false;
  if (name === 'delete') mutations.closeTopPrompt(); else mutations.closeHovers();
  mutations.showPrompt({ name, props });
  return true;
}

export function withContextTargets(original, dependencies) {
  const show = (name, props) => showContextTarget(name, props, dependencies);
  return { ...original, methods: { ...original.methods,
    showRenamePrompt() { return show('rename', { item: this.selectedCount === 1 ? this.firstSelected : dependencies.state.req, parentItems: [] }); },
    showRenamePromptForPreview() { return show('rename', { item: dependencies.state.req, parentItems: dependencies.state.navigation.listing || [] }); },
    showMovePrompt() { return show('move', { items: this.providedItems, operation: 'move' }); },
    showCopyPrompt() { return show('copy', { items: this.providedItems, operation: 'copy' }); },
    showDeletePrompt() { return show('delete', { items: this.providedItems }); },
    createFromTemplate(initialName) { return show('newFile', { base: this.templateBase(), initialName }); },
    createEmptyFile() { return show('newFile', { base: this.templateBase() }); },
    showNewDirPrompt() { return show('newDir', { base: this.firstSelected?.isDir ? {
      source: this.firstSelected.source, path: this.firstSelected.path,
    } : null }); },
  } };
}

export function contextTargetCommands(dependencies, fetchFiles) {
  const command = (name, create = false) => async ({ source, path } = {}) => {
    if (typeof source !== 'string' || typeof path !== 'string') return false;
    const loaded = await fetchFiles(source, path, false, true);
    if (create && !(loaded.isDir || loaded.type === 'directory')) return false;
    const item = { ...loaded, source, path };
    const props = create ? { base: { source, path } }
      : name === 'rename' ? { item, parentItems: [] }
        : { items: [item], ...(['copy', 'move'].includes(name) ? { operation: name } : {}) };
    return showContextTarget(name, props, dependencies);
  };
  return { renameTarget: command('rename'), copyTarget: command('copy'), moveTarget: command('move'),
    deleteTarget: command('delete'), newFileTarget: command('newFile', true), newDirTarget: command('newDir', true) };
}

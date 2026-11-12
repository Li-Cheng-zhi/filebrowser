// Hosted resource chrome. Baseline API/FilePage/DirectoryPager: Quantum 3d0e705edf75.
// This explicit document flag keeps standalone pages and the old CEF regression path intact.
const initialURL = typeof location === 'undefined' ? null : new URL(location.href);
const initialHosted = initialURL?.searchParams.get('worksChrome') === '1';
const initialDocumentKey = initialURL?.searchParams.get('worksPage') || '';

export function hostChromeEnabled(route) {
  return initialHosted || route?.query?.worksChrome === '1';
}

export function hostRequest(request) {
  if (!initialHosted) return request;
  return { ...request, documentKey: initialDocumentKey };
}

export function activateHostChrome() {
  if (!initialHosted) return false;
  document.documentElement.classList.add('works-hosted-chrome');
  return true;
}

/** Commands are bound to one component's existing host, not a second global file implementation. */
export function attachHostCommands(host, commands, publish, reportError) {
  host.runCommand = async (name, arguments_ = {}) => {
    try {
      const command = commands[name];
      if (!command) throw new Error('当前页面不支持此操作');
      await command(arguments_);
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    } finally {
      await publish();
    }
  };
  return host;
}

/** A departing component must not delete a newer component's bridge registration. */
export function cleanHost(owner, baselineCleanup) {
  const current = window.worksFilesHost;
  baselineCleanup();
  if (current && current !== owner) window.worksFilesHost = current;
}

export function fileChromeState(page) {
  return {
    action: 'chromeState', ready: page.loaded, busy: page.busy,
    canonicalPath: page.canonical, source: page.source, path: page.path,
    state: page.status, message: page.message,
    dirty: page.office ? page.officeDirty : !!page.saver?.dirty,
    mode: page.mode,
    modes: page.right ? [] : page.modes.map(item => item.value),
    saveAs: !page.right && (page.textFile || page.office),
  };
}

export function directoryChromeState(page, request, selection) {
  return {
    action: 'chromeState', ready: true, busy: page.busy, mode: 'view',
    canonicalPath: request.canonicalPath, source: request.source, path: request.path,
    selectedCount: selection.length, filter: page.filter, message: page.message,
  };
}

<script>
// Renderer: DirectoryPager.vue; lifecycle migrated from HostedDirectoryPager.vue at 3629da70da9e.
// Pagination/selection/anchor methods remain in DirectoryPager.vue, baseline 3d0e705edf75.
import DirectoryPager from './DirectoryPager.vue';
import { markRaw, nextTick } from 'vue';
import DefaultBar from '@/views/bars/Default.vue';
import { state, mutations, getters } from '@/store';
import { bridge } from './api.js';
import { activateHostChrome, attachHostCommands, cleanHost, directoryChromeState } from './hostChrome.js';
import './hostChrome.css';
import { desktopContextMenuTargets } from '@/components/contextMenuTargets.js';
import { resourcesApi } from '@/api';

/** @type {import('vue').ComponentOptions} */
const hostedDirectoryLifecycle = {
  extends: { ...DirectoryPager, mounted: undefined, beforeUnmount: undefined },
  data() { return { chromeHost: null, chromeClosed: false }; },
  watch: {
    busy() { this.publishChrome(); }, message() { this.publishChrome(); },
    filter() { this.queueReport(); this.publishChrome(); },
    'state.selected': { deep: true, handler() { this.publishChrome(); } },
  },
  async mounted() {
    activateHostChrome();
    mutations.closeSidebar();
    if (this.native) {
      try { this.side = !!(await bridge({ action: 'context' }))?.right; } catch { /* existing default remains */ }
      if (this.chromeClosed) return;
    }
    this.chromeHost = markRaw({
      refresh: change => { if (!change?.canonicalPath) return this.refresh(); },
      openMain: () => bridge({ action: 'open', source: state.req.source, path: state.req.path, target: 'main' }),
    });
    window.worksFilesHost = this.chromeHost;
    const targetAction = desktopContextMenuTargets({ mutations, getters, read: async (source, path) => {
      const result = await resourcesApi.fetchFiles(source, path, false, true);
      return { ...result, source: result.source || source, path: result.path ?? path, name: result.name || path.split('/').filter(Boolean).at(-1) || '.', isDir: result.isDir || result.type === 'directory' };
    } });
    attachHostCommands(this.chromeHost, {
      ...Object.fromEntries(['renameTarget', 'copyTarget', 'moveTarget', 'deleteTarget', 'newFileTarget', 'newDirTarget'].map(word => [word, args => targetAction(word, args)])),
      refresh: () => this.refresh(), open: () => this.openSelected(),
      newTab: () => this.openNewTab(), openRight: () => this.openRight(),
      trash: () => bridge({ action: 'trash' }),
      filter: ({ value } = {}) => {
        const next = typeof value === 'string' ? value : window.prompt('筛选已加载项', this.filter);
        if (next !== null) this.setFilter(next);
      },
      sidebar: () => mutations.toggleSidebar(),
      viewMode: () => {
        if (getters.viewModeChangeLocked()) return;
        const methods = DefaultBar.methods;
        methods.switchView.call({
          viewModes: ['list', 'normal', 'icons'],
          viewModeCycleIndex: methods.viewModeCycleIndex,
          resolveViewModeForFamily: methods.resolveViewModeForFamily,
        });
      },
      menu: () => DefaultBar.methods.toggleOverflow(),
      openMain: () => bridge({ action: 'open', source: state.req.source, path: state.req.path, target: 'main' }),
    }, () => this.publishChrome(), message => { this.message = message; });
    window.addEventListener('scroll', this.scrolled, true);
    window.addEventListener('click', this.queueReport, true);
    const restore = await this.report();
    if (this.chromeClosed) return;
    if (typeof restore?.filter === 'string') this.setFilter(restore.filter);
    await nextTick();
    if (this.chromeClosed) return;
    if (restore?.anchor) this.restoreAnchor(restore.anchor);
    else if (restore?.scroll) { const root = this.root(); if (root) root.scrollTop = restore.scroll; }
    if (restore?.selected) this.selectPaths(restore.selected);
    this.restored = true;
    this.lastScroll = this.root()?.scrollTop || 0;
    await this.report();
  },
  beforeUnmount() { this.chromeClosed = true; cleanHost(this.chromeHost, () => DirectoryPager.beforeUnmount.call(this)); },
  methods: {
    report() {
      const anchor = this.anchor(); const url = new URL(location.href);
      if (anchor?.cursor) url.searchParams.set('fcursor', anchor.cursor);
      this.publishChrome();
      return bridge({ action: 'navigation', canonicalPath: state.req.canonicalPath,
        source: state.req.source, path: state.req.path, url: url.pathname + url.search,
        scroll: this.root()?.scrollTop || 0, anchor, filter: this.filter,
        selected: this.selectedPaths(), sorting: getters.sorting(), restore: !this.restored });
    },
    publishChrome() { return bridge(directoryChromeState(this, state.req, state.selected)).catch(error => { console.warn('[WorksFiles] directory chrome', error.message); }); },
    openNewTab() {
      const item = state.req.items?.[state.selected?.[0]];
      return bridge({ action: 'open', source: item?.source || state.req.source,
        path: item?.path || state.req.path, target: 'new' });
    },
  },
};

/** @type {import('vue').ComponentOptions} */
const hostedDirectoryControls = {
  name: 'HostedDirectoryControls',
  extends: hostedDirectoryLifecycle,
  __scopeId: DirectoryPager.__scopeId,
  render: DirectoryPager.render,
  mounted() { this.$el.classList.add('works-hosted-directory-controls'); },
};

export default hostedDirectoryControls;
</script>

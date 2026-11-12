<template>
  <div class="works-hosted-pager">
    <button v-if="windowPages.first.page.previousCursor" :disabled="busy" title="加载前段" aria-label="加载前段" @click="loadMore('previous')"><i class="material-symbols">arrow_upward</i></button>
    <small>{{ firstIndex === 1 && !windowPages.last.page.nextCursor ? '共 ' + page.total + ' 项' : '已加载第 ' + firstIndex + '—' + lastIndex + ' 页 / 共 ' + page.total + ' 项' }}</small>
    <button v-if="windowPages.last.page.nextCursor" :disabled="busy" title="继续加载" aria-label="继续加载" @click="loadMore('next')"><i class="material-symbols">arrow_downward</i></button>
    <small v-if="filter" class="works-filter-label">筛选：{{ filter }}</small>
    <small v-if="message" role="status">{{ message }}</small>
  </div>
</template>
<script>
// Pagination/selection/anchor methods remain in DirectoryPager.vue, baseline 3d0e705edf75.
import DirectoryPager from './DirectoryPager.vue';
import { markRaw, nextTick } from 'vue';
import DefaultBar from '@/views/bars/Default.vue';
import { state, mutations, getters } from '@/store';
import { bridge } from './api.js';
import { activateHostChrome, attachHostCommands, cleanHost, directoryChromeState } from './hostChrome.js';
import './hostChrome.css';

/** @type {import('vue').ComponentOptions} */
const hostedDirectoryOptions = {
  name: 'HostedDirectoryPager',
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
    attachHostCommands(this.chromeHost, {
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
export default hostedDirectoryOptions;
</script>

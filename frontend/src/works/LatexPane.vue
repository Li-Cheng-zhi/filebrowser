<script>
// Independent file-page renderer. FileBrowser 876200c0 HostedFilePage factory selects this.
// The main frame owns the existing desktop bridge; the iframe reuses OpenLeaf's state/saveAll.
import { markRaw } from 'vue';
import { bridge } from './api.js';
import { attachHostCommands, cleanHost } from './hostChrome.js';

export default {
  name: 'WorksLatexPage',
  data() { return { chromeHost: null, message: '' }; },
  computed: {
    url() { const query = new URLSearchParams({ source: String(this.$route.query.source || 'home'), path: String(this.$route.query.path || '') }); return '/works/latex/?' + query; },
  },
  mounted() {
    document.title = String(this.$route.query.path || '').split('/').pop() + ' · Works LaTeX';
    this.chromeHost = markRaw({
      publish: () => this.publishChrome(),
      prepareClose: token => this.prepareClose(token),
      discardClose: token => this.discardClose(token),
      cancelClose: () => this.publishChrome(),
    });
    attachHostCommands(this.chromeHost, { save: () => this.save() },
      () => this.publishChrome(), message => { this.message = message; });
    window.worksFilesHost = this.chromeHost;
    this.publishChrome();
  },
  beforeUnmount() { cleanHost(this.chromeHost, () => { delete window.worksFilesHost; }); },
  methods: {
    editor() { return this.$refs.editorFrame?.contentWindow?.__ol; },
    async publishChrome() {
      if (!this.chromeHost || window.worksFilesHost !== this.chromeHost) return;
      const frame = this.$refs.editorFrame?.contentWindow;
      const tabs = frame?.__ol?.state.openTabs || [];
      const dirty = tabs.some(tab => tab.kind === 'text' && tab.dirty);
      const busy = tabs.some(tab => tab.kind === 'text' && tab.savePending);
      const ready = frame?.__olReady === true;
      const state = !ready ? 'loading' : busy ? 'saving' : dirty ? (this.message ? 'failed' : 'dirty') : 'saved';
      if (ready && !dirty && !busy) this.message = '';
      await bridge({ action: 'chromeState', ready, dirty, busy, state, message: this.message,
        source: String(this.$route.query.source || 'home'), path: String(this.$route.query.path || ''),
        mode: 'edit', modes: [], saveAs: false }).catch(error => { console.warn('[WorksFiles] LaTeX chrome state', error.message); });
    },
    async save() {
      const editor = this.editor();
      if (!editor) throw new Error('LaTeX 编辑器尚未就绪');
      this.message = '';
      await editor.saveAll();
    },
    async prepareClose(token) {
      try {
        const tabs = this.editor()?.state.openTabs || [];
        if (tabs.some(tab => tab.kind === 'text' && (tab.dirty || tab.savePending))) await this.save();
        if (tabs.some(tab => tab.kind === 'text' && (tab.dirty || tab.savePending))) throw new Error('仍有未保存修改');
        await bridge({ action: 'closeReady', token });
      } catch (error) {
        this.message = error.message;
        await bridge({ action: 'closeFailed', token, message: error.message });
      } finally { await this.publishChrome(); }
    },
    async discardClose(token) {
      this.editor()?.discardClose?.();
      await bridge({ action: 'closeReady', token });
    },
  },
};
</script>
<template><iframe ref="editorFrame" class="works-latex-frame" :src="url" title="LaTeX 工程编辑器" @load="publishChrome"></iframe></template>
<style scoped>.works-latex-frame{position:fixed;inset:0;width:100vw;height:100vh;border:0;display:block;background:var(--background)}</style>

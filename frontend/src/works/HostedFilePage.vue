<script>
// File behavior is inherited from FilePage.vue, Quantum baseline 3d0e705edf75.
// Only lifecycle/host wiring changes; the original renderer/save implementation remains callable.
import { h, markRaw } from 'vue';
import FilePage from './FilePage.vue';
import { bridge } from './api.js';
import { activateHostChrome, attachHostCommands, cleanHost, fileChromeState, hostChromeEnabled } from './hostChrome.js';
import './hostChrome.css';

const baselineOptions = { ...FilePage, mounted: undefined, beforeUnmount: undefined, beforeRouteLeave: undefined };
const HostedFile = {
  name: 'HostedWorksFile',
  __scopeId: FilePage.__scopeId,
  extends: baselineOptions,
  data() { return { chromeHost: null }; },
  watch: {
    loaded() { this.publishChrome(); }, busy() { this.publishChrome(); },
    status() { this.publishChrome(); }, mode() { this.publishChrome(); },
    message() { this.publishChrome(); }, officeDirty() { this.publishChrome(); },
    allowedModes: { deep: true, handler() { this.publishChrome(); } },
  },
  async mounted() {
    activateHostChrome();
    const loading = FilePage.mounted.call(this);
    window.removeEventListener('beforeunload', this.beforeUnload);
    this.chromeHost = markRaw(window.worksFilesHost);
    attachHostCommands(this.chromeHost, {
      view: () => this.switchMode('view'), edit: () => this.switchMode('edit'),
      review: () => this.switchMode('review'), save: () => this.save(),
      saveAs: () => this.saveAs(), refresh: () => this.reload(false),
      openMain: () => this.openMain(),
    }, () => this.publishChrome(), message => { this.message = message; });
    // Relocation must retain the document identity and hosted flag in history.replaceState.
    const relocate = this.chromeHost.relocate;
    this.chromeHost.relocate = async (...args) => {
      const previous = new URL(location.href);
      await relocate(...args);
      const current = new URL(location.href);
      for (const key of ['worksChrome', 'worksPage', 'right']) {
        if (previous.searchParams.has(key)) current.searchParams.set(key, previous.searchParams.get(key));
      }
      history.replaceState(null, '', current.pathname + current.search);
      await this.publishChrome();
    };
    await loading;
    await this.publishChrome();
  },
  beforeUnmount() { cleanHost(this.chromeHost, () => FilePage.beforeUnmount.call(this)); },
  methods: {
    publishChrome() { return bridge(fileChromeState(this)).catch(error => { console.warn('[WorksFiles] chrome state', error.message); }); },
    publish(force = false) { FilePage.methods.publish.call(this, force); this.publishChrome(); },
  },
};

export default {
  name: 'WorksFilePageFactory',
  render() { return h(hostChromeEnabled(this.$route) ? HostedFile : FilePage, {
    ref: 'page', key: [this.$route.query.source, this.$route.query.path, this.$route.query.right].join('\u0000'),
  }); },
  async beforeRouteLeave(to, from) {
    const page = this.$refs.page; const guard = page?.$options.beforeRouteLeave;
    return typeof guard === 'function' ? guard.call(page, to, from) : true;
  },
  async beforeRouteUpdate(to, from) {
    if (to.query.source === from.query.source && to.query.path === from.query.path) return true;
    const page = this.$refs.page; const guard = page?.$options.beforeRouteLeave;
    return typeof guard === 'function' ? guard.call(page, to, from) : true;
  },
};
</script>

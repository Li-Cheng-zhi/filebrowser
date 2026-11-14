<script>
// Independent file-page renderer. FileBrowser 876200c0 HostedFilePage factory selects this.
export default {
  name: 'WorksLatexPage',
  computed: {
    url() { const query = new URLSearchParams({ source: String(this.$route.query.source || 'home'), path: String(this.$route.query.path || '') }); return '/works/latex/?' + query; },
  },
  mounted() { document.title = String(this.$route.query.path || '').split('/').pop() + ' · Works LaTeX'; },
};
</script>
<template><iframe class="works-latex-frame" :src="url" title="LaTeX 工程编辑器"></iframe></template>
<style scoped>.works-latex-frame{position:fixed;inset:0;width:100vw;height:100vh;border:0;display:block;background:var(--background)}</style>

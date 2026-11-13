<script>
// Renderer: DirectoryPager.vue; hosted lifecycle: HostedDirectoryPager.vue at 2a49438602ae.
// Keep their original methods, document bridge and scoped styles; restore the complete built-in tools.
import DirectoryPager from './DirectoryPager.vue';
import HostedDirectoryPager from './HostedDirectoryPager.vue';

/** @type {import('vue').ComponentOptions} */
const hostedDirectoryControls = {
  name: 'HostedDirectoryControls',
  extends: HostedDirectoryPager,
  __scopeId: DirectoryPager.__scopeId,
  render: DirectoryPager.render,
  mounted() { this.$el.classList.add('works-hosted-directory-controls'); },
};
export default hostedDirectoryControls;
</script>

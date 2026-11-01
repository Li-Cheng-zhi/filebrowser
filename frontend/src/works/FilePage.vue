<template>
 <main class="works-file" @keydown.capture="shortcut">
  <header><span class="filename" :title="canonical">{{ name }}</span><span v-if="!right && (office || textFile)" class="modes" role="group" aria-label="文件模式"><button v-for="item in modes" :key="item.value" :class="{selected:mode===item.value}" :disabled="busy" @click="switchMode(item.value)">{{ item.label }}</button></span><button v-if="mode!=='view'" :disabled="busy" @click="save">保存</button><span class="status" :title="message">{{ statusLabel }}</span><button v-if="right" @click="openMain">主区域打开</button><button :disabled="busy" @click="reload(false)">刷新</button></header>
  <div v-if="message" class="message" role="status">{{ message }}</div>
  <div v-if="conflict" class="conflict"><span>磁盘内容已变化，当前编辑内容仍保留。</span><button @click="keep">继续编辑</button><button @click="reload(true)">重新载入磁盘版本</button><button @click="overwrite">确认覆盖当前磁盘版本</button><button @click="saveAs">另存为</button></div>
  <div ref="body" class="body">
   <OfficePane v-if="loaded&&office" :key="generation" ref="office" :source="source" :path="path" :mode="mode" :owner="owner" @state="officeState" @ready="officeReady" />
   <MarkdownViewer v-else-if="loaded&&textFile&&markdown&&mode==='view'" class="markdown" :splitMode="true" :liveContent="content" />
   <div v-else-if="loaded&&textFile" ref="editor" class="editor"></div>
   <iframe v-else-if="raw" :src="raw" title="文件预览" sandbox="allow-scripts allow-downloads"></iframe>
   <span v-else-if="!loaded">正在读取…</span>
  </div>
  <div v-if="busy" class="busy" tabindex="0">正在确认原文件保存，请保持页面打开…</div>
 </main>
</template>
<script>
import { markRaw } from 'vue';
import MarkdownViewer from '@/views/files/MarkdownViewer.vue';
import { mutations } from '@/store';
import { resourcesApi } from '@/api';
import { api,json,bridge,fileURL,pageId } from './api.js';
import { TextSave,restoreText } from './save.js';
import OfficePane from './OfficePane.vue';
const OFFICE=/\.(docx?|docm|dotx?|odt|rtf|xlsx?|xlsm|xltx|ods|csv|pptx?|pptm|odp|ppsx)$/i;
export default {
 components:{OfficePane,MarkdownViewer},
 data(){return {source:String(this.$route.query.source||''),path:String(this.$route.query.path||''),canonical:'',mode:'view',right:this.$route.query.right==='1',owner:pageId(),loaded:false,textFile:false,office:false,original:'',status:'loading',message:'',conflict:null,raw:'',model:null,editorInstance:null,saver:null,busy:false,autosave:null,maxsave:null,generation:0,officeEnded:false,officeDirty:false,monaco:null,content:'',rendered:'',unsubscribe:null,baseVersion:''}},
 computed:{name(){return this.path.split('/').pop()},markdown(){return /\.(md|markdown|mdown)$/i.test(this.path)},modes(){const modes=[{value:'view',label:'预览'},{value:'edit',label:'编辑'}];if(/\.(docx?|docm|odt)$/i.test(this.path))modes.push({value:'review',label:'审阅'});return modes},statusLabel(){return {loading:'读取中',saved:'已保存',dirty:'未保存',saving:'保存中',conflict:'保存冲突',failed:'保存失败'}[this.status]||this.status}},
 async mounted(){
  window.worksFilesHost={openMain:()=>this.openMain(),cancelClose:()=>{if(this.officeEnded){this.officeEnded=false;this.generation++}},prepareClose:async token=>{try{await this.prepareClose();await bridge({action:'closeReady',token})}catch(e){this.message=e.message;await bridge({action:'closeFailed',token,message:e.message})}},refresh:()=>{if(this.mode==='view')this.reload(false)},relocate:async(source,path,canonical)=>{if(this.office&&this.mode!=='view')throw new Error('Office 编辑中不可移动');this.source=source;this.path=path;this.canonical=canonical;const query=new URLSearchParams({source,path});history.replaceState(null,'',`/works/file?${query}`);document.title=this.name;if(this.textFile){await this.mountEditor();await this.renderMarkdown()}else await this.reload(false)}};
  window.addEventListener('beforeunload',this.beforeUnload);await this.load();
 },
 beforeUnmount(){this.disposeEditor();clearTimeout(this.autosave);clearTimeout(this.maxsave);window.removeEventListener('beforeunload',this.beforeUnload);delete window.worksFilesHost},
 async beforeRouteLeave(){try{await this.prepareClose();return true}catch(e){this.message=e.message;return false}},
 methods:{
  async load(){try{
   const metadata=await api('works/file',{source:this.source,path:this.path,metadata:'true'});this.canonical=metadata.canonicalPath;mutations.replaceRequest({...metadata,name:this.name,type:this.markdown?"text/markdown":metadata.type});this.office=OFFICE.test(this.path)&&!this.path.toLowerCase().endsWith('.csv');document.title=this.name;
   if(!this.office){try{
    const file=await this.read();this.original=file.text;this.content=file.text;this.textFile=true;
    this.saver=new TextSave(()=>this.read(),(text,version)=>api('resources',{source:this.source,path:this.path},{method:'PUT',headers:{'If-Match':`"${version}"`},body:text}),()=>this.changed());this.saver.load(file);
   }catch(e){if(e.status!==415&&e.status!==413)throw e;const item=await resourcesApi.fetchFiles(this.source,this.path);this.raw=resourcesApi.getRawViewURL(this.source,this.path,item.viewToken);this.textFile=false;}}
   this.loaded=true;this.status='saved';await this.$nextTick();await this.mountEditor();await this.renderMarkdown();await bridge({action:'identity',canonicalPath:this.canonical,source:this.source,path:this.path,title:this.name});this.publish();
  }catch(e){this.status='failed';this.message=e.message;this.loaded=true}},
  read(){return api('works/file',{source:this.source,path:this.path})},
  changed(){if(!this.saver)return;this.status=this.saver.state;this.conflict=this.saver.conflict;this.content=this.saver.text;this.publish()},
  publish(){bridge({action:'state',state:this.status,dirty:this.office?this.officeDirty:!!this.saver?.dirty,mode:this.mode,canonicalPath:this.canonical}).catch(e=>{this.message=e.message})},
  disposeEditor(){this.unsubscribe?.dispose();this.unsubscribe=null;this.editorInstance?.dispose();this.model?.dispose();this.editorInstance=null;this.model=null},
  async mountEditor(){this.disposeEditor();if(!this.textFile||(this.markdown&&this.mode==='view'))return;
   this.monaco=(await import('./monaco.js')).default;await this.$nextTick();if(!this.$refs.editor)return;
   const uri=this.monaco.Uri.parse('file://'+this.canonical);this.model=markRaw(this.monaco.editor.createModel(this.saver.text,undefined,uri));this.editorInstance=markRaw(this.monaco.editor.create(this.$refs.editor,{model:this.model,readOnly:this.mode==='view'||this.right,automaticLayout:true,minimap:{enabled:false},fontSize:14,wordWrap:this.markdown?'on':'off',scrollBeyondLastLine:false}));
   this.unsubscribe=this.model.onDidChangeContent(()=>{if(this.mode==='view'||this.right)return;this.saver.edit(restoreText(this.model.getValue(),this.original));this.scheduleSave()});
   console.warn('[WorksFiles] Monaco mounted',JSON.stringify({width:this.$refs.editor.clientWidth,height:this.$refs.editor.clientHeight,lines:this.model.getLineCount()}));
   this.editorInstance.addCommand(this.monaco.KeyMod.CtrlCmd|this.monaco.KeyCode.KeyS,()=>{this.save()});
  },
  async renderMarkdown(){},
  scheduleSave(){clearTimeout(this.autosave);if(this.conflict)return;this.autosave=setTimeout(()=>this.save(),1500);if(!this.maxsave)this.maxsave=setTimeout(()=>{this.maxsave=null;this.save()},10000)},
  async save(){if(this.right||this.mode==='view')return;clearTimeout(this.autosave);clearTimeout(this.maxsave);this.maxsave=null;try{if(this.office)await this.$refs.office.save();else await this.saver.save();this.message=''}catch(e){this.message=e.message}this.publish()},
  async prepareClose(){if(this.busy)throw new Error('保存尚在进行');if(this.conflict)throw new Error('请先处理保存冲突，页面仍保留');this.busy=true;try{if(this.office){await this.$refs.office?.close(false);this.officeEnded=true}else if(this.saver){await this.saver.save();if(this.saver.dirty)throw new Error('仍有未保存修改')}return true}finally{this.busy=false}},
  async switchMode(mode){if(mode===this.mode||this.right)return;try{this.busy=true;if(this.office){await this.$refs.office?.close(false);this.mode=mode;this.generation++}else{if(this.saver?.dirty)await this.saver.save();this.mode=mode;await this.$nextTick();await this.mountEditor();await this.renderMarkdown()}this.publish()}catch(e){this.message=e.message}finally{this.busy=false}},
  async reload(discard){if(!discard&&(this.saver?.dirty||this.officeDirty||this.conflict)){this.message='当前有未保存内容，请使用冲突选项处理，或先保存';return}if(discard&&!window.confirm('重新载入将放弃当前页面的未保存修改，是否继续？'))return;
   try{if(this.office){await this.$refs.office?.close(discard);this.generation++}else{await this.saver?.reload();this.original=this.saver.text;await this.mountEditor();await this.renderMarkdown()}this.conflict=null;this.message=''}catch(e){this.message=e.message}},
  keep(){this.message='自动保存已暂停；编辑内容仍保留，处理冲突后恢复。'},
  async overwrite(){try{let result;if(this.office){const state=await api('works/office/status',{key:this.$refs.office.config.works.key});if(state.absent)throw new Error('原文件已删除，请另存为');if(!window.confirm('确认用当前编辑内容覆盖现有磁盘版本？'))return;result=await this.$refs.office.overwrite(state.actualVersion);this.conflict=null}else{const current=await this.read();if(!window.confirm('确认用当前编辑内容覆盖刚读取的磁盘版本？'))return;await this.saver.save(current.version)}this.message='';this.publish()}catch(e){this.message=e.message}},
  async saveAs(){const path=window.prompt('另存为（当前 source 内的完整路径，不覆盖已有文件）',this.path);if(!path)return;try{let result;if(this.office)result=await this.$refs.office.saveAs(this.source,path);else result=await api('works/file',{source:this.source,path},{method:'POST',body:this.saver.text});this.message='副本已保存到 '+result.canonicalPath;await bridge({action:'changed',source:this.source,path});const target=fileURL(this.source,path);const opened=await bridge({action:'open',source:this.source,path,target:'main'});if(opened===null)window.open(target,'_blank');}catch(e){this.message=e.message}},
  officeState(event){this.status=event.state;this.message=event.error;this.officeDirty=event.dirty;if(event.state==='conflict')this.conflict=event.session;this.publish()},
  officeReady(metadata){this.baseVersion=metadata.version;this.canonical=metadata.canonicalPath;this.publish()},
  async openMain(){const result=await bridge({action:'open',source:this.source,path:this.path,target:'main'});if(result===null)window.open(fileURL(this.source,this.path),'_blank')},
  shortcut(event){if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();this.save()}},
  beforeUnload(event){if(this.officeDirty||this.saver?.dirty||this.status==='saving'||this.conflict){event.preventDefault();event.returnValue='文件有未保存修改'}},
 }
}
</script>
<style scoped>
.works-file{position:fixed!important;inset:0!important;margin:0!important;padding:0!important;width:100vw!important;max-width:none!important;height:100vh;display:flex;flex-direction:column;background:#fff;color:#252525;font:13px system-ui;position:relative}header{position:static!important;background:#fff!important;color:#252525!important;width:auto!important;box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:44px;padding:0 12px;border-bottom:1px solid #ddd;flex-shrink:0}.filename{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;margin-right:auto}.modes{display:inline-flex;flex-shrink:0;border-radius:7px;padding:2px;background:#ececec}.works-file button{background:transparent;border:0;border-radius:5px;padding:5px 9px;cursor:pointer;color:inherit}.modes button.selected{background:white;box-shadow:0 1px 4px #bbb}.status{font-size:11px;color:#777;white-space:nowrap}.body{flex:1;min-height:0;position:relative;display:flex;flex-direction:column;overflow:hidden}.body>.editor{flex:1;min-height:0;position:relative!important;padding:0!important;margin:0!important;min-width:0!important}.editor,iframe{height:100%;width:100%;border:0}.markdown{padding:20px 32px;overflow:auto;height:100%;box-sizing:border-box;line-height:1.7}.markdown :deep(pre){overflow:auto;background:#f5f5f5;padding:12px}.message,.conflict{padding:8px 12px;background:#fff3d4;overflow-wrap:anywhere}.conflict{display:flex;gap:8px;flex-wrap:wrap}.conflict button{background:#fff}.busy{position:absolute;inset:44px 0 0;background:#ffffff99;display:flex;justify-content:center;align-items:center;z-index:100}.works-file:has(.busy) .body{pointer-events:none}
</style>

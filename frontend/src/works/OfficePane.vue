<template>
 <div class="office-pane" :inert="frozen"><DocumentEditor v-if="config" :key="identity" :id="identity" :documentServerUrl="server" :config="config" :events_onDocumentStateChange="documentState" :events_onDocumentReady="documentReady" :events_onError="editorError" :onLoadComponentError="editorError" /></div>
</template>
<script>
import { DocumentEditor } from '@onlyoffice/document-editor-vue';
import { globalVars } from '@/utils/constants';
import { api,json,pageId } from './api.js';
export default {
 components:{DocumentEditor},props:{source:String,path:String,mode:String,owner:String},emits:['state','ready'],
 data(){return {config:null,identity:'office-'+pageId(),server:globalVars.onlyOfficeUrl,revision:0,savedRevision:0,candidateRevision:-1,accepted:true,frozen:false,ready:false,autosavePaused:false,pending:null,last:null,timer:null}},
 async mounted(){try{this.config=await api('office/config',{source:this.source,path:this.path,mode:this.mode,owner:this.owner});this.timer=setInterval(()=>{if(!this.autosavePaused&&this.revision>this.savedRevision&&this.accepted&&!this.pending&&this.last?.state!=='conflict')this.save().catch(()=>{})},10000)}catch(e){this.editorError(e)}},
 beforeUnmount(){clearInterval(this.timer);if(this.mode==='view'&&this.config)this.command('end',{discard:true}).catch(()=>{})},
 methods:{
  documentReady(){this.ready=true;this.$emit('ready',this.config.works);this.report('saved')},
  documentState(event){this.accepted=!event.data;if(event.data)this.revision++;this.report(this.revision>this.savedRevision?'dirty':'saved')},
  report(state,error=''){this.$emit('state',{state,error,dirty:this.revision>this.savedRevision,session:this.last})},
  editorError(error){this.report('failed',error?.message||JSON.stringify(error?.data||error))},
  command(action,extra={}){return api('works/office/command',{},json({key:this.config.works.key,owner:this.owner,action,...extra}))},
  async save(freeze=false){
   if(this.mode==='view')return;if(this.pending)return this.pending;
   if(!this.ready)throw new Error('文档尚未就绪，请稍后重试');
   this.frozen=freeze;document.activeElement?.blur();
   this.pending=(async()=>{try{
    // Fast coediting must acknowledge deltas before a force-save can snapshot them.
    const start=Date.now();while(!this.accepted){if(Date.now()-start>60000)throw new Error('文档服务器尚未确认修改，编辑内容仍保留，请保持页面打开');await new Promise(r=>setTimeout(r,100))}
    const revision=this.revision;this.report('saving');let result=await this.command(this.last?.candidate?'convert':'save');const request=result.pending||result.savedRequest;
    while(result.state==='saving'){if(Date.now()-start>90000)throw new Error('保存仍未确认，尚未关闭页面，可再次检查保存状态');await new Promise(r=>setTimeout(r,500));const status=await api('works/office/status',{key:this.config.works.key});result=status.session;result.actualVersion=status.actualVersion;result.absent=status.absent;}
    this.last=result;if(result.candidate)this.candidateRevision=revision;if(result.state!=='saved'||result.savedRequest!==request)throw new Error(result.error||'原文件尚未保存');this.savedRevision=revision;this.report(this.revision>revision?'dirty':'saved');return result;
   }catch(e){this.report(this.last?.state==='conflict'?'conflict':'failed',e.message);throw e}finally{this.pending=null;this.frozen=false}})();return this.pending;
  },
  async close(discard=false){if(!this.config)return;if(this.mode!=='view'&&!discard)await this.save(true);await this.command('end',{discard})},
  async latestCandidate(){if(this.revision>this.candidateRevision){try{await this.save(true)}catch(e){if(this.last?.state!=='conflict'||!this.last.candidate)throw e}}},
  async overwrite(expectedVersion){await this.latestCandidate();const result=await this.command('overwrite',{expectedVersion});this.last=result;this.savedRevision=this.revision;this.report('saved');return result},
  async saveAs(source,path){
   this.autosavePaused=true;if(this.pending)await this.pending.catch(()=>{});if(this.mode!=='view'){
    this.frozen=true;try{const start=Date.now();while(!this.accepted){if(Date.now()-start>60000)throw new Error('修改尚未提交到文档服务器');await new Promise(r=>setTimeout(r,100))}
     const revision=this.revision;let result=await this.command('convertOnly');const request=result.pending||result.savedRequest;while(result.state==='saving'){if(Date.now()-start>90000)throw new Error('另存转换尚未确认，编辑内容仍保留');await new Promise(r=>setTimeout(r,500));result=(await api('works/office/status',{key:this.config.works.key})).session}
     this.last=result;if(result.state!=='converted'||result.savedRequest!==request)throw new Error(result.error||'尚未生成完整转换结果');this.candidateRevision=revision;
    }finally{this.frozen=false}
   }
   return this.command('saveAs',{source,path})
  },
 }
}
</script>
<style scoped>.office-pane{height:100%;width:100%}.office-pane[inert]{pointer-events:none;opacity:.8}</style>

import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
window.__worksWorkerStatus={};
function observe(worker,label){window.__worksWorkerStatus[label]="started";worker.addEventListener("message",()=>{window.__worksWorkerStatus[label]="ready"},{once:true});worker.addEventListener("error",()=>{window.__worksWorkerStatus[label]="failed"},{once:true});return worker;}
window.MonacoEnvironment={getWorker(_id,label){if(label==='json')return observe(new JsonWorker(),label);if(label==='typescript'||label==='javascript')return observe(new TsWorker(),label);if(['css','scss','less'].includes(label))return observe(new CssWorker(),label);if(['html','handlebars','razor'].includes(label))return observe(new HtmlWorker(),label);return observe(new EditorWorker(),label);}};
export default monaco;

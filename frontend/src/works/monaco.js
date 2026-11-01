import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
window.MonacoEnvironment={getWorker(_id,label){if(label==='json')return new JsonWorker();if(label==='typescript'||label==='javascript')return new TsWorker();if(['css','scss','less'].includes(label))return new CssWorker();if(['html','handlebars','razor'].includes(label))return new HtmlWorker();return new EditorWorker();}};
export default monaco;

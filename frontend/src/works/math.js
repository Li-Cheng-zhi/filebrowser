const escape = text => text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function readInlineMath(src){
 let open,close;
 if(src.startsWith('\\(')){open='\\(';close='\\)'}else if(src.startsWith('\\[')){open='\\[';close='\\]'}else if(src.startsWith('$$')){open='$$';close='$$'}
 if(open){const end=src.indexOf(close,open.length);if(end<0)return;const text=src.slice(open.length,end).trim();if(!text)return;const raw=src.slice(0,end+close.length);return {raw,text,source:raw,displayMode:false}}
 if(!src.startsWith('$')||!src[1]||/\s/.test(src[1]))return;
 for(let i=1;i<src.length;i++){if(src[i]==='\\'){i++;continue}if(src[i]==='\n')return;if(src[i]==='$'){if(/\s/.test(src[i-1])||/\d/.test(src[i+1]||''))return;const text=src.slice(1,i);if(text.trim())return {raw:src.slice(0,i+1),source:src.slice(0,i+1),text,displayMode:false};return}}
}
export function mathExtensions(temml){
 const render=token=>{if(token.text.length>16384)return escape(token.source);return `<span class="works-math" data-works-math="${encodeURIComponent(token.source)}">${temml.renderToString(token.text,{throwOnError:false,displayMode:token.displayMode})}</span>`+(token.displayMode?'\n':'')};
 return [{name:'worksInlineMath',level:'inline',start(src){const i=src.search(/\$|\\[([]/);return i<0?undefined:i},tokenizer(src){const token=readInlineMath(src);if(token)return {...token,type:'worksInlineMath'}},renderer:render},
 {name:'worksBlockMath',level:'block',start(src){const i=src.search(/(?:^|\n) {0,3}(?:\$\$|\\\[)/);return i<0?undefined:i},tokenizer(src){const match=src.match(/^ {0,3}(\$\$|\\\[)/);if(!match)return;const open=match[1],close=open==='$$'?'$$':'\\]';const end=src.indexOf(close,match[0].length);if(end<0||!/^[ \t]*(?:\n|$)/.test(src.slice(end+close.length)))return;const text=src.slice(match[0].length,end).trim();if(!text)return;const tail=src.slice(end+close.length).match(/^[ \t]*(?:\n|$)/)[0];const source=src.slice(0,end+close.length);return {type:'worksBlockMath',raw:source+tail,source,text,displayMode:true}},renderer:render}];
}
function textOf(node){if(node.nodeType===3)return node.nodeValue||'';if(node.nodeType!==1&&node.nodeType!==11)return '';if(node.nodeName==='BR')return '\n';let text=[...node.childNodes].map(textOf).join('');if(/^(P|DIV|PRE|LI|H[1-6]|BLOCKQUOTE|TR)$/.test(node.nodeName)&&!text.endsWith('\n'))text+='\n';return text;}
export function mathSelectionSource(root,selection){
 if(!selection?.rangeCount||selection.isCollapsed)return null;let changed=false;const range=selection.getRangeAt(0).cloneRange();
 for(const math of root.querySelectorAll('.works-math[data-works-math]')){if(!range.intersectsNode(math))continue;changed=true;if(math.contains(range.startContainer))range.setStartBefore(math);if(math.contains(range.endContainer))range.setEndAfter(math)}
 if(!changed)return null;const fragment=range.cloneContents();for(const math of fragment.querySelectorAll('.works-math[data-works-math]'))math.replaceWith(root.ownerDocument.createTextNode(decodeURIComponent(math.getAttribute('data-works-math'))));return textOf(fragment);
}
export function copyMathSource(event,root){if(!root)return;const text=mathSelectionSource(root,root.ownerDocument.getSelection());if(text===null)return;event.clipboardData?.setData('text/plain',text);event.preventDefault();}

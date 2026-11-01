import { getApiPath } from '@/utils/url.js';
export async function api(path, params = {}, options = {}) {
 const response = await fetch(getApiPath(path,params),{credentials:'same-origin',...options});
 const text=await response.text();let data;try{data=JSON.parse(text)}catch{data={message:text}}
 if(!response.ok){const error=new Error(data.message||data.error||text||`HTTP ${response.status}`);error.status=response.status;error.data=data;throw error}return data;
}
export const json = body => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
export function bridge(request){return new Promise((resolve,reject)=>{if(!window.cefQuery){resolve(null);return;}window.cefQuery({request:JSON.stringify({worksFiles:1,...request}),onSuccess:value=>{try{resolve(JSON.parse(value))}catch{resolve(value)}},onFailure:(_code,message)=>reject(new Error(message))});});}
export function fileURL(source,path,right=false){const q=new URLSearchParams({source,path,...(right?{right:'1'}:{})});return `/works/file?${q}`;}
// ZeroTier HTTP is intentionally not a browser secure context. randomUUID is
// unavailable there; getRandomValues is supported in insecure contexts too.
export function pageId(){const bytes=new Uint8Array(16);globalThis.crypto.getRandomValues(bytes);return Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');}

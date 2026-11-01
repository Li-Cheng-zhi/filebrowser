import { api,bridge,fileURL } from './api.js';
import { adjustedData } from '@/api/utils';
import { getters,state,mutations } from '@/store';
export async function directoryPage(source,path,cursor=String(state.route?.query?.fcursor||'')){
 if(state.route?.query?.forder)mutations.updateListingSortConfig({field:String(state.route.query.forder),asc:state.route.query.fdescending!=='true'});const sorting=getters.sorting();const data=await api('works/directory',{source,path,...(cursor?{cursor}:{}),order:sorting.by||'name',descending:sorting.asc?'false':'true',pageSize:'200'});return adjustedData(data);
}
export function openItem(source,path,right=false){
 if(window.cefQuery)return bridge({action:'open',source,path,target:right?'right':'main'});
 if(right)return Promise.resolve(null);window.open(fileURL(source,path),'_blank');return Promise.resolve(null);
}

import { describe, it, expect } from 'vitest';
import { TextSave, restoreText } from './save.js';
describe('file page save boundary', () => {
 it('never acknowledges later typing as saved',async()=>{let finish;const s=new TextSave(null,()=>new Promise(r=>finish=r));s.load({text:'old',version:'v1'});s.edit('request');const promise=s.save();s.edit('later');finish({version:'v2'});await promise;expect(s.baseText).toBe('request');expect(s.dirty).toBe(true);expect(s.state).toBe('dirty');});
 it('keeps conflict buffer and requires a new explicit baseline',async()=>{let seen;const s=new TextSave(null,async(text,version)=>{seen=version;if(version==='old'){const e=new Error('changed');e.status=409;e.data={actualVersion:'agent'};throw e;}return {version:'saved'};});s.load({text:'disk',version:'old'});s.edit('mine');await expect(s.save()).rejects.toThrow();expect(s.text).toBe('mine');expect(s.conflict.actualVersion).toBe('agent');await s.save('agent');expect(seen).toBe('agent');expect(s.state).toBe('saved');});
 it('preserves BOM CRLF and Unicode exactly',()=>{expect(restoreText('中文 😀\r\n','\ufeffold\r\n')).toBe('\ufeff中文 😀\r\n');});
});

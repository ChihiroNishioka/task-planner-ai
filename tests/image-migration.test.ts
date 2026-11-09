import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { InputStore } from '../src/adapters/input-store';
import { ImageProposalStore } from '../src/adapters/image-proposal-store';
it('M-01 M-03 M-04 既存行とblobを維持し新表だけを追加する',()=>{
 const dir=mkdtempSync(join(tmpdir(),'image-migration-'));const path=join(dir,'db');const blobs=join(dir,'blobs');
 mkdirSync(blobs);const oldBlob=join(blobs,'acb30cba-f74e-41fb-9845-e8778bf3512d.blob');writeFileSync(oldBlob,Buffer.from([137,80,78,71,13,10,26,10]));
 const legacy=new Database(path);legacy.exec(`CREATE TABLE upload_batches(task_id TEXT NOT NULL,operation_key TEXT NOT NULL,request_hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(task_id,operation_key));
 CREATE TABLE task_inputs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,input_type TEXT NOT NULL,mime TEXT NOT NULL,name TEXT NOT NULL,blob_name TEXT NOT NULL,content_hash TEXT NOT NULL,created_at TEXT NOT NULL,sort_order INTEGER NOT NULL,operation_key TEXT NOT NULL);
 CREATE INDEX task_inputs_task_order ON task_inputs(task_id,sort_order);
 INSERT INTO task_inputs VALUES('acb30cba-f74e-41fb-9845-e8778bf3512d','task','IMAGE','image/png','old.png','acb30cba-f74e-41fb-9845-e8778bf3512d.blob','old-hash','2026-11-09T00:00:00Z',0,'old');`);legacy.close();
 const db=new Database(path);const before=db.prepare('SELECT * FROM task_inputs').all();const hash=createHash('sha256').update(readFileSync(oldBlob)).digest('hex');
 try{for(let i=0;i<3;i++){const proposals=new ImageProposalStore(path,blobs);proposals.close();}
 expect(db.prepare('SELECT * FROM task_inputs').all()).toEqual(before);expect(createHash('sha256').update(readFileSync(oldBlob)).digest('hex')).toBe(hash);
 expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('image_proposals','task_input_analyses') ORDER BY name").all()).toEqual([{name:'image_proposals'},{name:'task_input_analyses'}]);
 const inputs=new InputStore(path,blobs);expect(inputs.list('task')[0]?.analysisStatus).toBe('NOT_PROCESSED');inputs.close();
 db.prepare("INSERT INTO task_input_analyses VALUES('synthetic-new-input','synthetic-task','ai','合成文','synthetic-proposal','2026-11-09T00:00:00Z')").run();expect(db.prepare('SELECT * FROM task_inputs').all()).toEqual(before);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
it('M-02 2プロセスが同時起動して新表を初期化できる',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'image-migration-process-'));
 const run=()=>new Promise<number|null>((resolve,reject)=>{const child=spawn(process.execPath,['--experimental-strip-types','tests/fixtures/image-migration-child.mjs',join(dir,'db'),join(dir,'blobs')],{stdio:'pipe',timeout:10000});child.on('error',reject);child.on('exit',resolve);});
 try{expect(await Promise.all([run(),run()])).toEqual([0,0]);}finally{rmSync(dir,{recursive:true,force:true});}
});

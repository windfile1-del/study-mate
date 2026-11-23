import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { workspace, deferred } from './helpers';
import { ScheduleService, nextDaily } from '../apps/desktop/src/core/schedules';

const input={title:'复习',time:'09:00',instruction:'根据笔记出练习题'};
async function until(predicate:()=>boolean){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('等待任务超时');}
test('每日任务在重启后补跑每个错过的时间，且不会重复执行',async t=>{
  const dir=await workspace(t),file=path.join(dir,'schedule.json');let now=new Date(2026,9,20,8),seen:string[]=[];
  let service=new ScheduleService(file,async(_task,due)=>{seen.push(due);return '题目';},()=>now);
  await service.initialize();await service.create(input,'vault');await service.close();
  now=new Date(2026,9,22,10);service=new ScheduleService(file,async(_task,due)=>{seen.push(due);return '题目';},()=>now);
  await service.initialize();await until(()=>service.list().runs.filter(r=>r.status==='succeeded').length===3);
  assert.equal(new Set(seen).size,3);assert.equal(service.list().schedules[0].nextAt,nextDaily(input.time,now).toISOString());
  service.kick();await new Promise(r=>setTimeout(r,30));assert.equal(seen.length,3);await service.close();
});
test('失败保留原定时间，可重试；暂停期间不补跑',async t=>{
  const dir=await workspace(t);let now=new Date(2026,9,20,8),fail=true;
  const service=new ScheduleService(path.join(dir,'schedule.json'),async()=>{if(fail)throw Error('模型不可用');return '完成';},()=>now);
  await service.initialize();const task=await service.create(input,'vault');now=new Date(2026,9,20,10);service.kick();await until(()=>service.list().runs[0]?.status==='failed');
  const first=service.list().runs[0];assert.match(first.error!,/模型不可用/);fail=false;await service.retry(first.id);await until(()=>service.list().runs[0]?.status==='succeeded');assert.equal(service.list().runs[0].dueAt,first.dueAt);
  await service.enable(task.id,false);now=new Date(2026,9,25,10);await service.enable(task.id,true);service.kick();await new Promise(r=>setTimeout(r,30));assert.equal(service.list().runs.length,1);await service.close();
});
test('运行中关闭后，下一次启动恢复同一到期记录',async t=>{
  const dir=await workspace(t),file=path.join(dir,'schedule.json');let now=new Date(2026,9,20,8);const started=deferred<void>();
  let service=new ScheduleService(file,async(_t,_d,signal)=>{started.resolve();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('stopped'))));},()=>now);
  await service.initialize();await service.create(input,'vault');now=new Date(2026,9,20,10);service.kick();await started.promise;const id=service.list().runs[0].id;await service.close();
  service=new ScheduleService(file,async()=> '恢复成功',()=>now);await service.initialize();await until(()=>service.list().runs[0]?.status==='succeeded');assert.equal(service.list().runs.length,1);assert.equal(service.list().runs[0].id,id);await service.close();
});

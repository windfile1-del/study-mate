import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, SerialQueue } from './storage';
import { scheduleInput, type Schedule, type ScheduleInput, type ScheduleRun, type ScheduleState } from '../shared/schedules';

// Local civil time is intentional: daily tasks follow the computer's current time zone.
export function nextDaily(time: string, after: Date): Date {
  const [hour, minute] = time.split(':').map(Number);
  const next = new Date(after); next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= after.getTime()) next.setDate(next.getDate()+1);
  return next;
}
export class ScheduleService extends EventEmitter {
  private state: ScheduleState = {schedules: [], runs: []};
  private queue = new SerialQueue();
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopped = false;
  private controller = new AbortController();
  constructor(private file: string, private runTask: (task: Schedule, dueAt: string, signal: AbortSignal) => Promise<string>, private now = () => new Date()) { super(); }
  async initialize() {
    this.state = await readJson<ScheduleState>(this.file, {schedules: [], runs: []});
    if (!Array.isArray(this.state.schedules) || !Array.isArray(this.state.runs)) throw Error('定时任务记录格式不正确');
    // A process crash leaves the occurrence pending; generation has no write tools.
    await this.save();
    this.timer = setInterval(() => this.kick(), 30000);
    this.kick();
  }
  private async save() { await atomicJson(this.file, this.state); this.emit('changed'); }
  list(): ScheduleState { return structuredClone(this.state); }
  async create(input: ScheduleInput, vaultId: string) {
    return this.queue.run(async () => { const task=scheduleInput.parse(input), now=this.now(); const row:Schedule={...task,id:randomUUID(),vaultId,enabled:true,createdAt:now.toISOString(),nextAt:nextDaily(task.time,now).toISOString()}; this.state.schedules.push(row); await this.save(); return structuredClone(row); });
  }
  async update(id:string,input:ScheduleInput) { await this.queue.run(async()=>{const task=this.find(id); Object.assign(task,scheduleInput.parse(input)); task.nextAt=nextDaily(task.time,this.now()).toISOString(); await this.save();}); }
  async enable(id:string,enabled:boolean) { await this.queue.run(async()=>{const task=this.find(id); if(task.enabled!==enabled){task.enabled=enabled;if(enabled)task.nextAt=nextDaily(task.time,this.now()).toISOString();await this.save();}}); }
  async remove(id:string) { await this.queue.run(async()=>{this.find(id);this.state.schedules=this.state.schedules.filter(t=>t.id!==id);await this.save();}); }
  async retry(id:string) { await this.queue.run(async()=>{const run=this.state.runs.find(r=>r.id===id);if(!run||run.status!=='failed')throw Error('只能重试失败的任务');const task=this.find(run.scheduleId);if(!task.enabled)throw Error('请先启用该任务');run.status='running';run.startedAt=this.now().toISOString();run.error=undefined;run.finishedAt=undefined;await this.save();}); this.kick(); }
  private find(id:string) { const task=this.state.schedules.find(t=>t.id===id);if(!task)throw Error('定时任务不存在');return task; }
  kick() { if(this.stopped || this.active)return; this.active=this.process().catch(e=>{this.emit('service-error',e);}).finally(()=>{this.active=undefined;}); }
  private async process() {
    while(!this.stopped) {
      const selected=await this.queue.run(async()=>{
        let run=this.state.runs.find(r=>r.status==='running');
        if(run){const task=this.state.schedules.find(t=>t.id===run!.scheduleId);if(task)return {run:structuredClone(run),task:structuredClone(task)};run.status='failed';run.error='任务已删除';run.finishedAt=this.now().toISOString();await this.save();}
        const task=this.state.schedules.filter(t=>t.enabled && new Date(t.nextAt).getTime()<=this.now().getTime()).sort((a,b)=>a.nextAt.localeCompare(b.nextAt))[0];
        if(!task)return null;
        run={id:randomUUID(),scheduleId:task.id,title:task.title,dueAt:task.nextAt,status:'running',startedAt:this.now().toISOString()};
        this.state.runs.unshift(run); task.nextAt=nextDaily(task.time,new Date(task.nextAt)).toISOString(); await this.save(); return {run:structuredClone(run),task:structuredClone(task)};
      });
      if(!selected)return;
      let output:string|undefined, error:string|undefined;
      try { output=await this.runTask(selected.task,selected.run.dueAt,this.controller.signal);if(!output.trim())throw Error('模型没有返回内容'); } catch(e){error=e instanceof Error?e.message:String(e);}
      if(this.stopped)return;
      await this.queue.run(async()=>{const run=this.state.runs.find(r=>r.id===selected.run.id);if(!run)return;run.status=error?'failed':'succeeded';run.finishedAt=this.now().toISOString();run.output=output;run.error=error;await this.save();});
      this.emit('finished',selected.run.title,!!error);
    }
  }
  async close(){this.stopped=true;this.controller.abort();if(this.timer)clearInterval(this.timer);await this.active;await this.queue.flush();}
}

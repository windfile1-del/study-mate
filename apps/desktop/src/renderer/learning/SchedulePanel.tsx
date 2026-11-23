import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { remarkReadableMath } from '../notes/readable-math';
import type { ScheduleInput, ScheduleRequest, ScheduleState } from '../../shared/schedules';
import './schedules.css';

const blank: ScheduleInput={title:'',time:'20:00',instruction:''};
export function SchedulePanel({onClose}:{onClose:()=>void}) {
  const [state,setState]=useState<ScheduleState>({schedules:[],runs:[]});
  const [form,setForm]=useState<ScheduleInput>(blank),[editing,setEditing]=useState<string|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const refresh=()=>window.studyMate.schedules({action:'list'}).then(setState).catch(e=>setError(e.message));
  useEffect(()=>{void refresh();return window.studyMate.onChanged(()=>void refresh());},[]);
  const request=async(input:ScheduleRequest)=>{setBusy(true);setError('');try{setState(await window.studyMate.schedules(input));return true;}catch(e){setError(e instanceof Error?e.message:String(e));return false;}finally{setBusy(false);}};
  const save=async(e:React.FormEvent)=>{e.preventDefault();if(await request(editing?{action:'update',id:editing,task:form}:{action:'create',task:form})){setForm(blank);setEditing(null);}};
  return <div className="modal-overlay"><section className="schedule-panel" role="dialog" aria-modal="true" aria-label="定时学习任务">
    <header><div><h2>定时学习任务</h2><p>按电脑本地时间每天执行。软件关闭时的任务会在下次启动后补跑。</p></div><button onClick={onClose} aria-label="关闭"><X size={20}/></button></header>
    <div className="schedule-body"><div><form onSubmit={save} className="schedule-form"><h3>{editing?'修改任务':'新建每日任务'}</h3>
      <label>任务名称<input required maxLength={120} value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="例如：每日复习练习"/></label>
      <label>每天时间<input required type="time" value={form.time} onChange={e=>setForm({...form,time:e.target.value})}/></label>
      <label>任务要求<textarea required maxLength={4000} rows={4} value={form.instruction} onChange={e=>setForm({...form,instruction:e.target.value})} placeholder="例如：根据我的学习进度和相关笔记，出五道练习题并提供答案。"/></label>
      <div><button disabled={busy} type="submit">{editing?'保存修改':'创建任务'}</button>{editing&&<button type="button" onClick={()=>{setEditing(null);setForm(blank);}}>取消</button>}</div>
      <small>也可以在伴学对话中直接告诉 AI 任务要求与每天的时间。执行会调用当前模型并读取相关学习记录和笔记。</small></form>
      <h3>我的任务</h3>{!state.schedules.length&&<p>还没有定时任务。</p>}{state.schedules.map(t=><article className="schedule-card" key={t.id}><strong>{t.title}</strong><p>每天 {t.time} · {t.enabled?'已启用':'已暂停'}</p><p>{t.instruction}</p><small>下次：{t.enabled?new Date(t.nextAt).toLocaleString():'暂停中'}</small><div><button disabled={busy} onClick={()=>{setForm({title:t.title,time:t.time,instruction:t.instruction});setEditing(t.id);}}>编辑</button><button disabled={busy} onClick={()=>void request({action:'enable',id:t.id,enabled:!t.enabled})}>{t.enabled?'暂停':'启用'}</button><button disabled={busy} onClick={()=>{if(window.confirm('删除这个定时任务？已有结果会保留。'))void request({action:'delete',id:t.id});}}>删除</button></div></article>)}</div>
      <div><h3>执行记录</h3>{!state.runs.length&&<p>任务执行后，结果会显示在这里。</p>}{state.runs.map(r=><article className="schedule-card" key={r.id}><strong>{r.title}</strong><p>原定 {new Date(r.dueAt).toLocaleString()} · {r.status==='running'?'执行中':r.status==='succeeded'?'已完成':'失败'}</p>{r.error&&<p className="schedule-error">{r.error}</p>}{r.output&&<details><summary>查看结果</summary><div className="schedule-result"><ReactMarkdown remarkPlugins={[remarkGfm,remarkMath,remarkReadableMath]} rehypePlugins={[rehypeKatex]} components={{img:()=>null}}>{r.output}</ReactMarkdown></div></details>}{r.status==='failed'&&state.schedules.some(t=>t.id===r.scheduleId)&&<button disabled={busy} onClick={()=>void request({action:'retry',id:r.id})}>重试</button>}</article>)}</div>
    </div>{error&&<p role="alert" className="schedule-error">{error}</p>}</section></div>;
}

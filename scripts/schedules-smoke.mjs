import { _electron } from 'playwright-core';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root=process.cwd(),data=path.join(root,'.cache','schedules-smoke-'+Date.now());
await fs.mkdir(data,{recursive:true});
const requests=[];
const server=http.createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  const payload=JSON.parse(body), messages=payload.messages, result=messages.filter(m=>m.role==='tool');
  const scheduled=messages.some(m=>typeof m.content==='string'&&m.content.includes('你正在独立执行用户设置的定时学习任务'));
  requests.push({scheduled,tools:(payload.tools||[]).map(t=>t.function.name),result});
  let delta,finish_reason;
  if(!scheduled&&!result.length){delta={tool_calls:[{index:0,id:'create-1',type:'function',function:{name:'create_daily_task',arguments:JSON.stringify({title:'每日复习',time:'09:00',instruction:'根据笔记出题'})}}]};finish_reason='tool_calls';}
  else if(scheduled&&result.length===0){delta={tool_calls:[{index:0,id:'recent-1',type:'function',function:{name:'list_recent_learning',arguments:'{"limit":5}'}}]};finish_reason='tool_calls';}
  else if(scheduled&&result.length===1){delta={tool_calls:[{index:0,id:'read-1',type:'function',function:{name:'read_note',arguments:JSON.stringify({path:'开始使用.md',start_line:1,line_count:20})}}]};finish_reason='tool_calls';}
  else {delta={content:scheduled?'复习题：请解释这篇笔记中的开始学习步骤。':'已创建每日复习任务。'};finish_reason='stop';}
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\ndata: [DONE]\n\n');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const env={...process.env,STUDYMATE_DATA_DIR:data,STUDYMATE_SMOKE:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
let app;
async function launch(){app=await _electron.launch({executablePath:electronPath,args:[root],cwd:root,env,timeout:30000});const page=await app.firstWindow();await page.getByRole('button',{name:'定时学习任务'}).waitFor();return page;}
async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('等待条件超时');}
try {
  let page=await launch();
  await page.evaluate(async base=>{const state=await window.studyMate.ai({action:'state'});await window.studyMate.ai({action:'configure',config:{...state.config,preset:'custom',protocol:'chat',baseUrl:base,model:'fixture',contextSize:32768,maxOutput:1024}});},base);
  await page.evaluate(()=>window.studyMate.ai({action:'send',text:'每天九点根据笔记出题'}));
  await until(()=>page.evaluate(()=>window.studyMate.ai({action:'state'}).then(s=>!s.busy)));
  let state=await page.evaluate(()=>window.studyMate.schedules({action:'list'}));assert.equal(state.schedules.length,1);
  await page.getByRole('button',{name:'定时学习任务'}).click();await page.getByText('每日复习',{exact:true}).waitFor();await app.close();
  const file=path.join(data,'state','schedules.json'),saved=JSON.parse(await fs.readFile(file,'utf8'));const due=new Date(Date.now()-60000).toISOString();saved.schedules[0].nextAt=due;await fs.writeFile(file,JSON.stringify(saved));
  page=await launch();await until(()=>page.evaluate(()=>window.studyMate.schedules({action:'list'}).then(s=>s.runs.some(r=>r.status==='succeeded'))));
  state=await page.evaluate(()=>window.studyMate.schedules({action:'list'}));assert.equal(state.runs[0].dueAt,due);assert.match(state.runs[0].output,/复习题/);
  const executed=requests.filter(r=>r.scheduled);assert.ok(executed.some(r=>r.result.some(x=>x.content.includes('欢迎来到 Study Mate'))),JSON.stringify(executed));assert.ok(executed.every(r=>!r.tools.includes('save_note')&&!r.tools.includes('create_daily_task')));
  await page.getByRole('button',{name:'定时学习任务'}).click();await page.getByText('查看结果').click();await page.getByText(/复习题：/).waitFor();
  console.log('PASS: 对话创建、界面查看、重启补跑、真实笔记读取和只读工具限制');
} finally {if(app)await app.close().catch(()=>{});server.close();}

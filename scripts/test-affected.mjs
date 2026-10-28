import fs from'node:fs/promises';import path from'node:path';import{createHash}from'node:crypto';import{spawn}from'node:child_process';
const root=process.cwd(),folder=path.join(root,'artifacts/0.13'),file=path.join(folder,'affected-checks.json');await fs.mkdir(folder,{recursive:true});let ledger={policy:'Only rerun affected successful checks after their test body or dependencies change',checks:{}};try{ledger=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
const dependencies={
 'vault.test.ts':['core/vault.ts','core/storage.ts','shared/library.ts'],
 'chat-context.test.ts':['core/chat-context.ts','core/history-lookup.ts','core/ai-providers.ts'],
 'ai-tools-wire.test.ts':['core/ai-wire.ts','core/ai-providers.ts','core/study-tools.ts','shared/ai.ts'],
 'video-evidence.test.ts':['core/learning.ts','core/sources.ts','core/video-cache.ts'],
 'compression-evidence-013.test.ts':['core/chat-context.ts','core/history-lookup.ts'],
 'conversation-recovery-013.test.ts':['core/conversations.ts'],
};
for(const[target,deps]of Object.entries(dependencies)){
 const source=await fs.readFile('tests/'+target,'utf8'),positions=[...source.matchAll(/^test\('([^']+)'/gm)],cases=positions.map((m,i)=>({name:m[1],body:source.slice(m.index,positions[i+1]?.index),fingerprint:''})).filter(c=>target!=='video-evidence.test.ts'||c.name.startsWith('按时间读取已缓存'));
 for(const c of cases){const hash=createHash('sha256').update(source.slice(0,positions[0].index)).update(c.body).update(await fs.readFile('tests/helpers.ts'));for(const dep of deps)hash.update(dep).update(await fs.readFile('apps/desktop/src/'+dep));c.fingerprint=hash.digest('hex');}
 if(process.argv.includes('--import-compression-evidence')){if(target==='compression-evidence-013.test.ts'){const log=await fs.readFile('artifacts/0.13/compression-evidence.tap','utf8');for(const c of cases)if(log.split('\n').some(line=>/^ok \d+ - /.test(line)&&line.includes(c.name)))ledger.checks[c.name]={passed:true,fingerprint:c.fingerprint,evidence:'artifacts/0.13/compression-evidence.tap'};}continue;}
 if(process.argv.includes('--seed')){const log=(await Promise.all(['.cache/013-affected.tap','.cache/013-wire-fix.tap','.cache/013-freeze.tap'].map(p=>fs.readFile(p,'utf8')))).join('\n');for(const c of cases)if(log.split('\n').some(line=>/^ok \d+ - /.test(line)&&line.includes(c.name)&&!line.includes('# SKIP')))ledger.checks[c.name]={passed:true,fingerprint:c.fingerprint,evidence:'initial affected TAP plus focused fix/freeze TAP'};continue;}
 const selected=cases.filter(c=>!ledger.checks[c.name]?.passed||ledger.checks[c.name].fingerprint!==c.fingerprint);if(!selected.length){console.log(target+': reused '+cases.length+' successes');continue;}
 const pattern=selected.map(c=>'^'+c.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$').join('|'),child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','--test','--test-reporter=tap','--test-name-pattern='+pattern,'tests/'+target],{cwd:root,windowsHide:true,env:{...process.env,TEMP:path.join(root,'.cache/temp'),TMP:path.join(root,'.cache/temp')},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);}),log=path.join(folder,'affected-'+target+'-'+Date.now()+'.tap');await fs.writeFile(log,output);for(const c of selected)ledger.checks[c.name]={passed:output.split('\n').some(line=>/^ok \d+ - /.test(line)&&line.includes(c.name)&&!line.includes('# SKIP')),fingerprint:c.fingerprint,evidence:path.relative(root,log)};console.log(target+': executed '+selected.length+', reused '+(cases.length-selected.length));if(code!==0){console.log(output);process.exitCode=1;}
}
await fs.writeFile(file,JSON.stringify(ledger,null,2));

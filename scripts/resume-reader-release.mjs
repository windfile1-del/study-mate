import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';

const root=process.cwd(),reportPath=path.join(root,'artifacts/standalone/result.json');
const result=JSON.parse(await fs.readFile(reportPath,'utf8'));
const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
assert.equal(version,'0.12.0');assert.equal(result.copyMethod,'physical copy');
// Keep screenshot acceptance separate from archive compression.
const archive=path.join(root,'release',version,`Study-Mate-${version}-Windows-x64.zip`);
const archiveDeadline=Date.now()+15*60*1000;
while(true){
  let complete=false;
  const file=await fs.open(archive,'r');
  try{const stat=await file.stat();if(stat.size>=22){const tail=Buffer.alloc(22);await file.read(tail,0,22,stat.size-22);complete=tail.readUInt32LE(0)===0x06054b50;}}finally{await file.close();}
  if(complete)break;
  if(Date.now()>archiveDeadline)throw Error('ZIP封装尚未完成，未并行启动界面验收');
  await new Promise(resolve=>setTimeout(resolve,1000));
}
const executable=await fs.realpath(result.isolatedExecutable),isolated=path.dirname(path.dirname(executable));
assert.equal(path.dirname(isolated).toLowerCase(),'d:\\studymateacceptance');
assert.match(path.basename(isolated),/^study-mate-0\.12\.0-[a-z0-9]+$/i);
assert.equal((await fs.lstat(isolated)).isSymbolicLink(),false);
for(const name of ['Study Mate.exe','resources/app.asar']){
  const [original,copy]=await Promise.all([fs.readFile(path.join(root,'release',version,'win-unpacked',name)),fs.readFile(path.dirname(executable)+'/'+name)]);
  assert.equal(createHash('sha256').update(original).digest('hex'),createHash('sha256').update(copy).digest('hex'),'验收副本与当前构建不一致');
}
const earlyLog=path.join(root,'.cache/0.12-video-hidden-screenshot.log');
try{await fs.access(earlyLog);}catch{await fs.copyFile(path.join(root,'.cache/standalone-video.log'),earlyLog);}
result.passed=false;delete result.error;result.resumedSameImmutablePackage=true;
const checkpoint=()=>fs.writeFile(reportPath,JSON.stringify(result,null,2));
try{
  for(const name of ['reader','video','chinese','learning','notes','media','workspace-ai','polish','documents']){
    if(result.results[name]?.passed)continue;
    console.log('Validating '+name);
    const log=createWriteStream(path.join(root,'.cache/standalone-'+name+'.log'));
    const child=spawn(process.execPath,[path.join(root,'scripts',name+'-smoke.mjs'),'--packed'],{cwd:root,env:{...process.env,STUDYMATE_PACKED_EXE:executable},windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
    await new Promise(resolve=>log.end(resolve));
    const details=JSON.parse(await fs.readFile(path.join(root,'artifacts',name+'-packed/result.json'),'utf8'));
    result.results[name]={passed:code===0&&details.passed,checks:details.checks.length,performance:details.performance};await checkpoint();
    if(!result.results[name].passed)throw Error(name+'回归失败：'+(details.error||details.failure||'查看验收日志'));
  }
  const actual=await fs.realpath(isolated);
  assert.equal(actual.toLowerCase(),isolated.toLowerCase());
  assert.equal(path.dirname(actual).toLowerCase(),'d:\\studymateacceptance');
  assert.equal((await fs.lstat(actual)).isSymbolicLink(),false);
  await fs.rm(actual,{recursive:true,force:true});
  result.temporaryCopyRemoved=true;result.passed=true;
}catch(error){result.error=error.stack||String(error);process.exitCode=1;}
await checkpoint();console.log(JSON.stringify(result,null,2));

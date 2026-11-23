import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {remoteNoteRef,remoteVideoRef,clientStudyContext,chatSubmit,pairSubmit,pairPoll,playbackStart,playbackProgress,playbackHandoff,noteInkSync,noteInkSyncAll} from '../apps/desktop/src/shared/remote';

const models={RemoteNoteRef:remoteNoteRef,RemoteVideoRef:remoteVideoRef,ClientStudyContext:clientStudyContext,ChatSubmit:chatSubmit,PairSubmit:pairSubmit,PairPoll:pairPoll,PlaybackStart:playbackStart,PlaybackProgress:playbackProgress,PlaybackHandoff:playbackHandoff,NoteInkSync:noteInkSync,NoteInkSyncAll:noteInkSyncAll};
const schemas=Object.fromEntries(Object.entries(models).map(([name,schema])=>[name,z.toJSONSchema(schema,{target:'draft-2020-12',unrepresentable:'any'})]));
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'},link=object({base:string,target:string,wiki:{type:'boolean'}});
const request=(schema:unknown)=>({required:true,content:{'application/json':{schema}}});
const response={description:'Business response; failures use {error:{code,message}}',content:{'application/json':{schema:{type:'object'}}}};
const operation=(summary:string,body?:unknown,publicRoute=false)=>({summary,...(body?{requestBody:request(body)}:{}),...(publicRoute?{security:[]}:{}),responses:{'200':response,'400':response,'401':response,'403':response,'409':response}});
const reference=(name:string)=>({$ref:'#/components/schemas/'+name});
const idParameter={name:'id',in:'path',required:true,schema:{type:'string'}};
const api={openapi:'3.1.0',info:{title:'Study Mate LAN API',version:'1.1.0',description:'Android stages 0–3. Bearer-authenticated, read-only learning with explicit playback handoff. AI secrets and desktop IPC are never exported.'},security:[{deviceToken:[]}],paths:{
 '/v1/hello':{get:operation('Protocol and capability handshake',undefined,true)},
 '/v1/openapi.json':{get:operation('Read this versioned API contract')},
 '/v1/pair':{post:operation('Create pending pairing; requires desktop approval',reference('PairSubmit'),true)},
 '/v1/pair/status':{post:operation('Poll pairing result with one-time poll token',reference('PairPoll'),true)},
 '/v1/auth/refresh':{post:operation('Rotate refresh credentials',object({refreshToken:string}),true)},
 '/v1/session':{get:operation('Current desktop learning session')},
 '/v1/videos':{get:operation('Registered courses with desktop position and this device checkpoints')},
 '/v1/playback/start':{post:operation('Start a sequenced playback session for a registered course',reference('PlaybackStart'))},
 '/v1/playback/progress':{post:operation('Save this device position without changing desktop playback',reference('PlaybackProgress'))},
 '/v1/playback/handoff':{post:operation('Offer a frozen position; desktop confirmation is required',reference('PlaybackHandoff'))},
 '/v1/notes':{get:operation('Current authorized vault tree')},
 '/v1/notes/read':{post:operation('Read a UTF-8 note',object({path:string}))},
 '/v1/notes/ink/sync':{post:operation('Bidirectionally merge persistent handwriting pads for one note',reference('NoteInkSync'))},
 '/v1/notes/ink/sync-all':{post:operation('Bidirectionally merge persistent handwriting pads for the authorized vault',reference('NoteInkSyncAll'))},
 '/v1/notes/resolve':{post:operation('Resolve a note or attachment link',link)},
 '/v1/notes/image':{get:{...operation('Read an authorized image'),parameters:[{name:'base',in:'query',required:true,schema:string},{name:'target',in:'query',required:true,schema:string},{name:'wiki',in:'query',required:true,schema:{type:'string',enum:['true','false']}}]}},
 '/v1/knowledge/search':{post:operation('Search the desktop knowledge index',object({query:string}))},
 '/v1/conversations':{get:operation('Active conversation and history'),post:operation('Create or switch the shared conversation',object({operation:{type:'string',enum:['create','switch']},id:string},['operation']))},
 '/v1/chat/requests':{post:{...operation('Submit an idempotent read-only AI request',reference('ChatSubmit')),responses:{'202':response,'400':response,'401':response,'403':response,'409':response}}},
 '/v1/chat/requests/{id}':{get:{...operation('Query submitted request status'),parameters:[idParameter]}},
 '/v1/chat/requests/{id}/cancel':{post:{...operation('Cancel a request initiated by this device'),parameters:[idParameter]}},
 '/v1/media/{id}':{get:{...operation('Read a registered local media file with Range'),parameters:[idParameter,{name:'Range',in:'header',schema:string}]},head:{...operation('Read local media metadata'),parameters:[idParameter]}},
 '/v1/media/{id}/prepare':{post:{...operation('Prepare registered local media or authorized Bilibili H.264/AAC tracks; returns opaque LAN paths',object({})),parameters:[idParameter]}},
 '/v1/media/{id}/tracks/{track}':{get:{...operation('Proxy one prepared course track; no upstream URL or browser credentials exported'),parameters:[idParameter,{name:'track',in:'path',required:true,schema:{type:'string',format:'uuid'}},{name:'Range',in:'header',schema:string}]},head:{...operation('Read prepared track headers'),parameters:[idParameter,{name:'track',in:'path',required:true,schema:{type:'string',format:'uuid'}}]}},
 '/v1/events':{get:{...operation('Upgrade to WSS; sequenced deltas and replay/reset'),description:'Authenticated WebSocket. Client sends {after:number}. Server events contain sequence, type, data; chat.delta includes append and UTF-16 offset.'}},
},components:{securitySchemes:{deviceToken:{type:'http',scheme:'bearer'}},schemas}};

const overrides:Record<string,Record<string,string>>={ChatSubmit:{context:'ClientStudyContext'},ClientStudyContext:{resources:'List<RemoteResourceRef>'}};
const kotlinType=(name:string,field:string,schema:any):string=>overrides[name]?.[field]||(schema.type==='string'||schema.const!==undefined?'String':schema.type==='integer'?'Int':schema.type==='number'?'Double':schema.type==='boolean'?'Boolean':schema.type==='array'?'List<JSONObject>':'JSONObject');
const classes=Object.entries(schemas).map(([name,schema])=>{
 const entries=Object.entries(schema.properties||{}) as [string,any][];
 const fields=entries.map(([field,value])=>`    val ${field}: ${kotlinType(name,field,value)}${typeof value.const==='string'?' = '+JSON.stringify(value.const):''}`).join(',\n');
 const parent=name==='RemoteNoteRef'||name==='RemoteVideoRef'?'RemoteResourceRef':'RemoteWireObject';
 const body=entries.map(([field,value])=>{const type=kotlinType(name,field,value),serialized=type.startsWith('List<')?`JSONArray(${field}.map { if (it is RemoteWireObject) it.toJson() else it })`:type==='ClientStudyContext'?`${field}.toJson()`:field;return`        .put("${field}", ${serialized})`;}).join('\n');
 return`data class ${name}(\n${fields}\n) : ${parent} {\n    override fun toJson(): JSONObject = JSONObject()\n${body}\n}\n`;
}).join('\n');
const kotlin='// Generated by scripts/generate-remote-contracts.ts. Do not edit.\npackage dev.studymate.mobile\n\nimport org.json.JSONArray\nimport org.json.JSONObject\n\ninterface RemoteWireObject { fun toJson(): JSONObject }\nsealed interface RemoteResourceRef : RemoteWireObject\n\n'+classes;
const outputs=[['docs/api/study-mate-v1.openapi.json',JSON.stringify(api,null,2)+'\n'],['apps/mobile/android/app/src/main/java/dev/studymate/mobile/RemoteContract.kt',kotlin]];
for(const[file,content]of outputs){if(process.argv.includes('--check')){if(await fs.readFile(file,'utf8')!==content)throw Error('Remote contract needs regeneration: '+file);}else{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);}}
console.log(process.argv.includes('--check')?'Remote contracts are current.':'Generated OpenAPI and Kotlin request types.');

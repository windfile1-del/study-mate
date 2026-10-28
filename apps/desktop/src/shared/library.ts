import {z} from 'zod';
const target=z.string().min(1).max(500);
export const libraryRequest=z.discriminatedUnion('action',[
 z.object({action:z.literal('backups'),path:target.optional()}).strict(),
 z.object({action:z.literal('backup-content'),id:target}).strict(),
 z.object({action:z.literal('restore'),id:target,path:target,version:z.string().nullable()}).strict(),
 z.object({action:z.literal('clean-backups'),ids:z.array(target).min(1).max(1000)}).strict(),
 z.object({action:z.literal('remove'),kind:z.enum(['note','document','course']),id:target,version:z.string().optional()}).strict(),
 z.object({action:z.literal('recent-learning')}).strict(),
]);
export interface NoteBackup{id:string;path:string;version:string;createdAt:string;bytes:number;reason:string}
export interface LibraryReply{content?:string;backupPath?:string;backups?:NoteBackup[];restored?:string;removed?:boolean;recent?:LearningVisit[]}
export interface LearningVisit{id:string;sourceId:string;title:string;startedAt:string;lastSeenAt:string;position:number;duration:number;ranges:[number,number][];inferred?:boolean}

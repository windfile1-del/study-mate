import{z}from'zod';import{documentContextSchema}from'./documents';
export const workspaceResource=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('note'),path:z.string().min(1).max(500),vaultId:z.string().max(80)}).strict(),
 z.object({kind:z.literal('document'),context:documentContextSchema}).strict(),
 z.object({kind:z.literal('video'),sourceId:z.string().regex(/^[a-f0-9]{24}$/)}).strict(),
]);
export type WorkspaceResource=z.infer<typeof workspaceResource>;
export function visibleResources(input:{main?:WorkspaceResource;side?:WorkspaceResource;sideVisible:boolean}){return [input.main,...(input.sideVisible?[input.side]:[])].filter((v):v is WorkspaceResource=>!!v).filter((v,i,all)=>all.findIndex(x=>JSON.stringify(x)===JSON.stringify(v))===i);}

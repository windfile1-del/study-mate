import { z } from 'zod';

export const scheduleInput = z.object({
  title: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(4000),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
}).strict();
export type ScheduleInput = z.infer<typeof scheduleInput>;
export interface Schedule extends ScheduleInput {
  id: string; enabled: boolean; nextAt: string; createdAt: string; vaultId: string;
}
export interface ScheduleRun {
  id: string; scheduleId: string; title: string; dueAt: string; status: 'running'|'succeeded'|'failed';
  startedAt: string; finishedAt?: string; output?: string; error?: string;
}
export const scheduleRequest = z.discriminatedUnion('action', [
  z.object({action:z.literal('list')}).strict(),
  z.object({action:z.literal('create'), task:scheduleInput}).strict(),
  z.object({action:z.literal('update'), id:z.string().uuid(), task:scheduleInput}).strict(),
  z.object({action:z.literal('enable'), id:z.string().uuid(), enabled:z.boolean()}).strict(),
  z.object({action:z.literal('delete'), id:z.string().uuid()}).strict(),
  z.object({action:z.literal('retry'), id:z.string().uuid()}).strict(),
]);
export type ScheduleRequest = z.infer<typeof scheduleRequest>;
export interface ScheduleState { schedules: Schedule[]; runs: ScheduleRun[] }

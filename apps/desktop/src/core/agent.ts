import { z } from 'zod';
import type { ContextAnchor, LearningContext } from '../shared/contracts';
import { AppError } from './errors';
import { VaultService } from './vault';

export interface ToolScope {
  readonly anchor: ContextAnchor;
  readonly vaultId: string;
  readonly allowWrite: boolean;
}
interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface ProviderTurn {
  text?: string;
  toolCalls?: ToolCall[];
}
export interface ProviderInput {
  prompt: string;
  context: LearningContext;
  toolResults: Array<{ id: string; name: string; value: unknown }>;
}
export interface AgentProvider {
  readonly name: string;
  next(input: ProviderInput, signal: AbortSignal): Promise<ProviderTurn>;
}
const createSchema = z
  .object({ path: z.string(), content: z.string().max(2_000_000), operationId: z.string().min(1) })
  .strict();
const patchSchema = createSchema.extend({ expectedVersion: z.string().min(1) });
export class ToolBroker {
  constructor(
    private readonly vault: () => VaultService,
    private readonly context: (anchor: ContextAnchor, signal: AbortSignal) => Promise<LearningContext>,
  ) {}
  async execute(name: string, input: unknown, scope: ToolScope, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.vault().id !== scope.vaultId)
      throw new AppError('STALE_VAULT', '知识库已经切换，请重新发起任务。');
    if (name === 'get_learning_context') {
      z.object({}).strict().parse(input);
      return this.context(scope.anchor, signal);
    }
    if (name === 'read_note')
      return this.vault().read(z.object({ path: z.string() }).strict().parse(input).path);
    if (name === 'search_notes')
      return this.vault().search(
        z
          .object({ query: z.string().max(200) })
          .strict()
          .parse(input).query,
      );
    if (!['create_note', 'patch_note'].includes(name))
      throw new AppError('TOOL_DENIED', '该工具不在允许的工具列表中。');
    if (!scope.allowWrite) throw new AppError('WRITE_NOT_AUTHORIZED', '当前请求只允许读取笔记。');
    if (name === 'create_note') {
      const args = createSchema.parse(input);
      return this.vault().write({
        ...args,
        expectedVersion: null,
        operationId: scope.anchor.requestId + ':' + args.operationId,
      });
    }
    const args = patchSchema.parse(input);
    return this.vault().write({ ...args, operationId: scope.anchor.requestId + ':' + args.operationId });
  }
}
export class AgentRuntime {
  constructor(
    private readonly broker: ToolBroker,
    private provider: AgentProvider | null = null,
  ) {}
  get configured(): boolean {
    return this.provider !== null;
  }
  setProvider(provider: AgentProvider | null): void {
    this.provider = provider;
  }
  async run(
    prompt: string,
    context: LearningContext,
    scope: ToolScope,
    signal: AbortSignal,
    stepLimit = 8,
  ): Promise<string> {
    const provider = this.provider;
    if (!provider) throw new AppError('NO_PROVIDER', '模型尚未连接，当前可以读取课程上下文和编辑笔记。');
    if (!Number.isInteger(stepLimit) || stepLimit < 1 || stepLimit > 16)
      throw new AppError('STEP_LIMIT', '工具步骤预算不正确。');
    const toolResults: ProviderInput['toolResults'] = [];
    for (let step = 0; step < stepLimit; step++) {
      signal.throwIfAborted();
      const turn = await provider.next({ prompt, context, toolResults: [...toolResults] }, signal);
      signal.throwIfAborted();
      if (!turn.toolCalls?.length) return turn.text || '';
      if (turn.toolCalls.length > 8) throw new AppError('TOOL_BUDGET', '单步工具调用超过预算。');
      for (const call of turn.toolCalls) {
        const value = await this.broker.execute(call.name, call.input, scope, signal);
        toolResults.push({ id: call.id, name: call.name, value });
      }
    }
    throw new AppError('STEP_LIMIT', '已达到本次工具调用步骤上限。');
  }
}

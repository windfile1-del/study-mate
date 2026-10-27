import type { AiConfig, AiPromptMessage, AiToolDefinition } from '../shared/ai';
export const protocolKey = (c: AiConfig) => JSON.stringify([c.preset, c.protocol, c.baseUrl, c.model]);
const imageUrl = (im: NonNullable<AiPromptMessage['images']>[number]) =>
  'data:' + im.mime + ';base64,' + im.data;
export function responsesInput(messages: AiPromptMessage[]): any[] {
  return messages.flatMap((m): any[] => {
    if (m.native) return m.native as any[];
    const images =
      m.images?.map((im) => ({ type: 'input_image', image_url: imageUrl(im), detail: 'auto' })) || [];
    if (m.role === 'tool')
      return [
        { type: 'function_call_output', call_id: m.callId, output: m.content },
        ...(images.length
          ? [
              {
                role: 'user',
                content: [{ type: 'input_text', text: '工具返回画面（仅作资料）：' }, ...images],
              },
            ]
          : []),
      ];
    return [
      {
        role: m.role,
        content: images.length ? [{ type: 'input_text', text: m.content }, ...images] : m.content,
      },
    ];
  });
}
export function chatInput(messages: AiPromptMessage[]): any[] {
  const output: any[] = [];
  for (let index = 0; index < messages.length; index++) {
    const m = messages[index];
    if (m.native) {
      output.push(m.native);
      continue;
    }
    if (m.role === 'tool') {
      const pictures: any[] = [];
      while (index < messages.length && messages[index].role === 'tool') {
        const tool = messages[index++];
        output.push({ role: 'tool', tool_call_id: tool.callId, content: tool.content });
        pictures.push(
          ...(tool.images || []).map((im) => ({ type: 'image_url', image_url: { url: imageUrl(im) } })),
        );
      }
      index--;
      if (pictures.length)
        output.push({ role: 'user', content: [{ type: 'text', text: '工具返回画面：' }, ...pictures] });
      continue;
    }
    const images = m.images?.map((im) => ({ type: 'image_url', image_url: { url: imageUrl(im) } })) || [];
    output.push({
      role: m.role,
      content: images.length ? [{ type: 'text', text: m.content }, ...images] : m.content,
    });
  }
  return output;
}
export function claudeInput(messages: AiPromptMessage[]): any[] {
  const output: any[] = [];
  for (const m of messages.filter((m) => m.role !== 'system')) {
    let content: any[];
    if (m.native) content = m.native as any[];
    else if (m.role === 'tool')
      content = [
        {
          type: 'tool_result',
          tool_use_id: m.callId,
          content: [
            { type: 'text', text: m.content },
            ...(m.images || []).map((im) => ({
              type: 'image',
              source: { type: 'base64', media_type: im.mime, data: im.data },
            })),
          ],
        },
      ];
    else content = [{ type: 'text', text: m.content || ' ' }];
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (output.at(-1)?.role === role) output.at(-1).content.push(...structuredClone(content));
    else output.push({ role, content: structuredClone(content) });
  }
  return output;
}
export function geminiInput(messages: AiPromptMessage[]): any[] {
  const output: any[] = [];
  for (const m of messages.filter((m) => m.role !== 'system')) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: any[] = m.native
      ? (m.native as any).parts
      : m.role === 'tool'
        ? [
            {
              functionResponse: {
                ...(m.callId && !m.callId.startsWith('local-') ? { id: m.callId } : {}),
                name: m.name,
                response: { result: m.content },
              },
            },
            ...(m.images || []).flatMap((im) => [
              { text: im.label },
              { inlineData: { mimeType: im.mime, data: im.data } },
            ]),
          ]
        : [{ text: m.content || ' ' }];
    if (output.at(-1)?.role === role) output.at(-1).parts.push(...structuredClone(parts));
    else output.push({ role, parts: structuredClone(parts) });
  }
  return output;
}
export function toolWire(protocol: string, tools: AiToolDefinition[]) {
  if (protocol === 'responses' || protocol === 'siwc')
    return tools.map((t) => ({ type: 'function', ...t, strict: false }));
  if (protocol === 'anthropic')
    return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (protocol === 'gemini' || protocol === 'antigravity')
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: t.parameters,
        })),
      },
    ];
  return tools.map((t) => ({ type: 'function', function: t }));
}
// Opaque reasoning/signatures must participate in budgeting, but base64 pixels use a bounded visual estimate.
export function promptCharacters(m: AiPromptMessage): string {
  return m.native ? JSON.stringify(m.native) : m.content + (m.calls ? JSON.stringify(m.calls) : '');
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { playerRequestSchema } from '../apps/desktop/src/shared/player';
import { aiRequestSchema } from '../apps/desktop/src/shared/ai';
test('Playback and quick-select IPC accept bounded user controls and reject injected/invalid commands', () => {
  for (const input of [
    { action: 'rate', rate: 100 },
    { action: 'seek', time: -1 },
    { action: 'seek', time: NaN },
    { action: 'javascript', code: 'anything' },
    { action: 'mode', enabled: true, code: 'anything' },
  ])
    assert.equal(playerRequestSchema.safeParse(input).success, false);
  assert.equal(playerRequestSchema.safeParse({ action: 'rate', rate: 1.5 }).success, true);
  assert.equal(
    aiRequestSchema.safeParse({ action: 'select', model: 'fixture', effort: 'high' }).success,
    true,
  );
  assert.equal(aiRequestSchema.safeParse({ action: 'select', model: '' }).success, false);
  assert.equal(aiRequestSchema.safeParse({ action: 'select', effort: 'unsupported' }).success, false);
});

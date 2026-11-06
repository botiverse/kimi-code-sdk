import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentConversationUndoService } from '#/agent/undo/undo';
import {
  hashLlmRequestMessages,
  rebuildLastLlmRequest,
} from '#/agent/llmRequester/llmRequestRebuild';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ExecutableTool } from '#/tool/toolContract';
import type { Message } from '#/llm-adapter/contract/message';
import type { WireRecord } from '#/wire/record';

import { createTestAgent, type TestAgentContext } from '../../harness';
import type { GenerateCall } from '../../harness/snapshots';

const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const lookupTool: ExecutableTool<{ query: string }> = {
  name: 'Lookup',
  description: 'Look up a short test value.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  resolveExecution: () => ({
    approvalRule: 'Lookup',
    execute: async () => ({ output: 'lookup-result' }),
  }),
};

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function roundTrip(records: readonly WireRecord[]): WireRecord[] {
  return records.map((record) => JSON.parse(JSON.stringify(record)) as WireRecord);
}

function withoutLlmRequestField(records: readonly WireRecord[], field: string): WireRecord[] {
  return records.map((record) => {
    if (record.type !== 'llm.request') return record;
    const { [field]: _dropped, ...rest } = record;
    void _dropped;
    return rest as WireRecord;
  });
}

function editLastLlmRequest(
  records: readonly WireRecord[],
  edit: Record<string, unknown>,
): WireRecord[] {
  const last = records.map((record) => record.type).lastIndexOf('llm.request');
  return records.map((record, index) => (index === last ? { ...record, ...edit } : record));
}

describe('rebuildLastLlmRequest', () => {
  let ctx: TestAgentContext;

  beforeEach(async () => {
    ctx = createTestAgent();
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  async function runTurn(text: string, reply: string): Promise<void> {
    ctx.mockNextResponse({ type: 'text', text: reply });
    await ctx.rpc.prompt({ input: [{ type: 'text', text }] });
    await ctx.untilTurnEnd();
  }

  async function runToolTurn(): Promise<void> {
    ctx.get(IAgentProfileService).update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);
    ctx.mockNextResponse(
      { type: 'text', text: 'I will look it up.' },
      { type: 'function', id: 'call_lookup', name: 'Lookup', arguments: '{"query":"moon"}' },
    );
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
    ctx.mockNextResponse({ type: 'text', text: 'It is lookup-result.' });
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();
  }

  function expectSameAsLive(rebuilt: readonly Message[], live: GenerateCall): void {
    const summarize = (messages: readonly Pick<Message, 'role' | 'toolCalls' | 'content'>[]) =>
      messages.map((message) => ({
        role: message.role,
        text: message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
        toolCalls: message.toolCalls.map((call) => call.id),
      }));
    expect(summarize(rebuilt)).toEqual(summarize(live.history as readonly Message[]));
  }

  async function records(): Promise<WireRecord[]> {
    return roundTrip(await ctx.persistedWireRecords());
  }

  it('rebuilds what the model received, across turns and tool calls, and verifies it', async () => {
    await runTurn('Hello', 'Hi');
    await runToolTurn();
    const live = ctx.llmCalls.at(-1)!;

    const rebuilt = rebuildLastLlmRequest(await records());

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'verified' });
    if (rebuilt.status !== 'rebuilt') return;
    expectSameAsLive(rebuilt.messages, live);
    expect(rebuilt.systemPrompt).toBe(live.systemPrompt);
    expect(rebuilt.tools.map((tool) => tool.name)).toEqual(['Lookup']);
    expect(rebuilt.response?.content).toEqual([{ type: 'text', text: 'It is lookup-result.' }]);
  });

  it('picks the request before the point of interest when the records stop there', async () => {
    await runTurn('First', 'One');
    const firstTurn = await records();
    await runTurn('Second', 'Two');
    const firstLength = firstTurn.length;

    const rebuilt = rebuildLastLlmRequest((await records()).slice(0, firstLength));

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'verified' });
    if (rebuilt.status !== 'rebuilt') return;
    expect(rebuilt.messages).toHaveLength(1);
    expect(rebuilt.response?.content).toEqual([{ type: 'text', text: 'One' }]);
  });

  it('replays undo', async () => {
    await runTurn('First', 'One');
    await runTurn('Second', 'Two');
    await ctx.get(IAgentConversationUndoService).undo(1);
    await runTurn('Third', 'Three');
    const live = ctx.llmCalls.at(-1)!;

    const rebuilt = rebuildLastLlmRequest(await records());

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'verified' });
    if (rebuilt.status !== 'rebuilt') return;
    expectSameAsLive(rebuilt.messages, live);
  });

  it('replays a compaction', async () => {
    await runTurn('First', 'One');
    await runTurn('Second', 'Two');
    await runTurn('Third', 'Three');
    const completed = ctx.once('compaction.completed');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep it short.' });
    await completed;
    await runTurn('Fourth', 'Four');
    const live = ctx.llmCalls.at(-1)!;
    const all = await records();
    expect(all.some((record) => record.type === 'context.apply_compaction')).toBe(true);

    const rebuilt = rebuildLastLlmRequest(all);

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'verified' });
    if (rebuilt.status !== 'rebuilt') return;
    expectSameAsLive(rebuilt.messages, live);
  });

  it('verifies a turn with a small inline image', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'A pixel.' });
    await ctx.rpc.prompt({
      input: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', imageUrl: { url: ONE_PIXEL_PNG } },
      ],
    });
    await ctx.untilTurnEnd();

    const rebuilt = rebuildLastLlmRequest(await records());

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'verified' });
  });

  it('rebuilds an undo the way restore does, keeping an unowned injection', async () => {
    await runTurn('First', 'One');
    await runTurn('Second', 'Two');
    ctx.context.append({
      role: 'user',
      content: [{ type: 'text', text: 'reminder' }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'system_reminder' },
    });
    await ctx.get(IAgentConversationUndoService).undo(1);
    await runTurn('Third', 'Three');
    const live = ctx.llmCalls.at(-1)!;

    const rebuilt = rebuildLastLlmRequest(await records());

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'verified' });
    if (rebuilt.status !== 'rebuilt') return;
    expectSameAsLive(rebuilt.messages, live);
    expect(JSON.stringify(rebuilt.messages)).toContain('reminder');
  });

  it('replays a legacy undo record with no branch switch', async () => {
    await runTurn('First', 'One');
    await runTurn('Second', 'Two');
    const beforeUndo = (await records()).length;
    await runTurn('Third', 'Three');
    const all = await records();
    const sent = all.filter((record) => record.type === 'llm.request').at(-1)!;
    const withUndo: WireRecord[] = [
      ...all.slice(0, beforeUndo),
      { type: 'context.undo', agentId: 'main', count: 1 },
      ...all.slice(beforeUndo),
    ];

    const rebuilt = rebuildLastLlmRequest(
      withoutLlmRequestField(
        editLastLlmRequest(withUndo, { messageCount: (sent['messageCount'] as number) - 2 }),
        'messagesHash',
      ),
    );

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'count_matched' });
    if (rebuilt.status !== 'rebuilt') return;
    expect(JSON.stringify(rebuilt.messages)).not.toContain('Second');
  });

  it('keeps a system prompt change made on an undone branch, as a restore does', async () => {
    await runTurn('First', 'One');
    await runTurn('Second', 'Two');
    ctx.get(IAgentProfileService).update({ systemPrompt: 'CHANGED PROMPT' });
    await ctx.get(IAgentConversationUndoService).undo(1);
    await runTurn('Third', 'Three');
    const live = ctx.llmCalls.at(-1)!;
    expect(live.systemPrompt).toBe('CHANGED PROMPT');

    const rebuilt = rebuildLastLlmRequest(await records());

    expect(rebuilt).toMatchObject({
      status: 'rebuilt',
      verification: 'verified',
      systemPrompt: 'CHANGED PROMPT',
    });
  });

  it('stops looking for the response at a record that rewrites history', async () => {
    await runTurn('Hello', 'Hi');
    const all = await records();

    const rebuilt = rebuildLastLlmRequest([
      ...all,
      { type: 'context.clear', agentId: 'main' },
      {
        type: 'context.append_message',
        agentId: 'main',
        message: { role: 'assistant', content: [{ type: 'text', text: 'after' }], toolCalls: [] },
      },
    ]);

    expect(rebuilt).toMatchObject({ status: 'rebuilt' });
    if (rebuilt.status !== 'rebuilt') return;
    expect(rebuilt.response?.content).toEqual([{ type: 'text', text: 'Hi' }]);
  });

  it('does not take a later message for the response when the step dropped its empty one', async () => {
    await runTurn('Hello', 'Hi');
    const all = await records();
    const request = all.findIndex((record) => record.type === 'llm.request');
    const step = all.find(
      (record) =>
        record.type === 'context.append_loop_event' &&
        (record['event'] as { type: string }).type === 'step.begin',
    )!;

    const rebuilt = rebuildLastLlmRequest([
      ...all.slice(0, request + 1),
      {
        type: 'context.append_loop_event',
        agentId: 'main',
        event: { type: 'step.end', uuid: (step['event'] as { uuid: string }).uuid },
      },
      {
        type: 'context.append_message',
        agentId: 'main',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'BLOCKED BY HOOK' }],
          toolCalls: [],
        },
      },
    ]);

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'verified' });
    if (rebuilt.status !== 'rebuilt') return;
    expect(rebuilt.response).toBeUndefined();
  });

  it('refuses a corrupt record rather than throwing', async () => {
    await runTurn('Hello', 'Hi');
    const all = await records();
    const firstMessage = all.findIndex((record) => record.type === 'context.append_message');
    const corrupt = all.map((record, index) =>
      index === firstMessage
        ? { ...record, message: { role: 'user', content: 'not parts', toolCalls: [] } }
        : record,
    );

    expect(rebuildLastLlmRequest(corrupt)).toMatchObject({
      status: 'refused',
      reason: 'replay_failed',
    });
  });

  it('rebuilds records with no metadata line', async () => {
    await runTurn('Hello', 'Hi');
    const all = (await records()).filter((record) => record.type !== 'metadata');

    expect(rebuildLastLlmRequest(all)).toMatchObject({ status: 'rebuilt', verification: 'verified' });
  });

  it('replays a clear', async () => {
    await runTurn('First', 'One');
    ctx.context.clear();
    await runTurn('Second', 'Two');

    const rebuilt = rebuildLastLlmRequest(await records());

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'verified' });
    if (rebuilt.status !== 'rebuilt') return;
    expect(rebuilt.messages).toHaveLength(1);
  });

  it('skips a compaction request and keeps the loop response a later compaction rewrote', async () => {
    await runTurn('First', 'One');
    await runTurn('Second', 'Two');
    await runTurn('Third', 'Three');
    const completed = ctx.once('compaction.completed');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep it short.' });
    await completed;
    const all = await records();
    expect(
      all.filter((record) => record.type === 'llm.request').map((record) => record['kind']),
    ).toEqual(['loop', 'loop', 'loop', 'compaction']);

    const rebuilt = rebuildLastLlmRequest(all);

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'verified' });
    if (rebuilt.status !== 'rebuilt') return;
    expect(rebuilt.request.kind).toBe('loop');
    expect(rebuilt.messages).toHaveLength(5);
    expect(rebuilt.response?.content).toEqual([{ type: 'text', text: 'Three' }]);
  });

  it('keeps the response when a compaction rewrites history without shrinking it past the response', async () => {
    await runTurn('First', 'One');
    await runTurn('Second', 'Two');
    await runTurn('Third', 'Three');
    const completed = ctx.once('compaction.completed');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep it short.' });
    await completed;
    const all = (await records()).filter(
      (record) => !(record.type === 'llm.request' && record['kind'] === 'compaction'),
    );

    const rebuilt = rebuildLastLlmRequest(all);

    expect(rebuilt).toMatchObject({ status: 'rebuilt' });
    if (rebuilt.status !== 'rebuilt') return;
    expect(rebuilt.response?.content).toEqual([{ type: 'text', text: 'Three' }]);
  });

  it('returns the response as far as the records reach, as at a tool call in flight', async () => {
    await runToolTurn();
    const all = await records();
    const toolCall = all.findIndex(
      (record) =>
        record.type === 'context.append_loop_event' &&
        (record['event'] as { type: string }).type === 'tool.call',
    );

    const rebuilt = rebuildLastLlmRequest(all.slice(0, toolCall + 1));

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'verified' });
    if (rebuilt.status !== 'rebuilt') return;
    expect(rebuilt.messages).toHaveLength(1);
    expect(rebuilt.response?.toolCalls.map((call) => call.id)).toEqual(['call_lookup']);
    expect(rebuilt.response?.content).toEqual([{ type: 'text', text: 'I will look it up.' }]);
  });

  it('has no response when the records stop at the request', async () => {
    await runTurn('Hello', 'Hi');
    const all = await records();
    const request = all.findIndex((record) => record.type === 'llm.request');

    for (const records of [all.slice(0, request + 1), all.slice(0, request + 2)]) {
      const rebuilt = rebuildLastLlmRequest(records);

      expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'verified' });
      if (rebuilt.status !== 'rebuilt') return;
      expect(rebuilt.response).toBeUndefined();
    }
  });

  it('applies the strict projection a retried request used', async () => {
    ctx.context.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'leading assistant' }],
      toolCalls: [],
    });
    await runTurn('Hello', 'Hi');
    const all = withoutLlmRequestField(await records(), 'messagesHash');

    const rebuilt = rebuildLastLlmRequest(
      editLastLlmRequest(all, { projection: 'strict', messageCount: 1 }),
    );

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'count_matched' });
    if (rebuilt.status !== 'rebuilt') return;
    expect(rebuilt.messages.map((message) => message.role)).toEqual(['user']);
  });

  it('strips dynamic tool context with tool select off, and keeps it with tool select on', async () => {
    const schema = { name: 'mcp__x__y', description: 'd', parameters: { type: 'object' } };
    ctx.context.append({
      role: 'user',
      content: [{ type: 'text', text: 'keep me' }],
      toolCalls: [],
      tools: [schema],
    });
    await runTurn('Hello', 'Hi');
    const all = await records();

    const off = rebuildLastLlmRequest(all);
    expect(off).toMatchObject({ status: 'rebuilt', verification: 'verified' });
    if (off.status !== 'rebuilt') return;
    expect(off.messages.some((message) => message.tools !== undefined)).toBe(false);

    const on = rebuildLastLlmRequest(
      withoutLlmRequestField(editLastLlmRequest(all, { toolSelect: true }), 'messagesHash'),
    );
    expect(on).toMatchObject({ status: 'rebuilt', verification: 'count_matched' });
    if (on.status !== 'rebuilt') return;
    expect(on.messages.some((message) => message.tools !== undefined)).toBe(true);
  });

  it('verifies a turn whose image the wire stores as a blob reference', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'A picture.' });
    await ctx.rpc.prompt({
      input: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', imageUrl: { url: `data:image/png;base64,${'A'.repeat(200_000)}` } },
      ],
    });
    await ctx.untilTurnEnd();
    const all = await records();
    expect(JSON.stringify(all)).toContain('blobref:');

    expect(rebuildLastLlmRequest(all)).toMatchObject({ status: 'rebuilt', verification: 'verified' });
  });

  it('refuses a request whose image was replaced to fit the media budget', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'No picture.' });
    await ctx.rpc.prompt({
      input: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', imageUrl: { url: `data:image/png;base64,${'A'.repeat(32_000_000)}` } },
      ],
    });
    await ctx.untilTurnEnd();
    expect(JSON.stringify(ctx.llmCalls.at(-1)!.history)).toContain('omitted');

    expect(rebuildLastLlmRequest(await records())).toMatchObject({
      status: 'refused',
      reason: 'messages_hash_mismatch',
    });
  });

  it('replays the swarm reminder removal', async () => {
    await runTurn('First', 'One');
    ctx.context.append({
      role: 'user',
      content: [{ type: 'text', text: 'swarm on' }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'swarm_mode' },
    });
    const all = await records();
    const sessionHasReminder = all.length;
    await runTurn('Second', 'Two');
    const after = await records();
    const withExit: WireRecord[] = [
      ...after.slice(0, sessionHasReminder),
      { type: 'swarm_mode.exit', agentId: 'main' },
      ...after.slice(sessionHasReminder),
    ];

    const sent = after.filter((record) => record.type === 'llm.request').at(-1)!;

    const rebuilt = rebuildLastLlmRequest(
      withoutLlmRequestField(
        editLastLlmRequest(withExit, { messageCount: (sent['messageCount'] as number) - 1 }),
        'messagesHash',
      ),
    );

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'count_matched' });
    if (rebuilt.status !== 'rebuilt') return;
    expect(JSON.stringify(rebuilt.messages)).not.toContain('swarm on');
  });

  it('migrates a session written with an older wire protocol', () => {
    const tools: never[] = [];
    const rebuilt = rebuildLastLlmRequest([
      { type: 'metadata', protocol_version: '1.0', created_at: 1 },
      {
        type: 'context.append_message',
        agentId: 'main',
        message: { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      },
      {
        type: 'context.append_message',
        agentId: 'main',
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [
            { type: 'function', id: 'call_1', function: { name: 'Lookup', arguments: '{}' } },
          ],
        },
      },
      {
        type: 'context.append_message',
        agentId: 'main',
        message: {
          role: 'tool',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'ok' }],
          toolCalls: [],
        },
      },
      { type: 'llm.tools_snapshot', agentId: 'main', hash: sha256(JSON.stringify(tools)), tools },
      {
        type: 'llm.request',
        agentId: 'main',
        kind: 'loop',
        provider: 'openai',
        model: 'm',
        toolSelect: false,
        systemPromptHash: sha256(''),
        toolsHash: sha256(JSON.stringify(tools)),
        messageCount: 3,
      },
    ]);

    expect(rebuilt).toMatchObject({
      status: 'rebuilt',
      verification: 'count_matched',
      protocolVersion: '1.0',
    });
    if (rebuilt.status !== 'rebuilt') return;
    expect(rebuilt.messages[1]?.toolCalls[0]).toMatchObject({ id: 'call_1', name: 'Lookup' });
  });

  it('counts media parts by type, so a dehydrated wire still verifies', () => {
    const message = (url: string): Message => ({
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url } }],
      toolCalls: [],
    });

    expect(hashLlmRequestMessages([message('data:image/png;base64,AAAA')])).toBe(
      hashLlmRequestMessages([message('blob:abc')]),
    );
  });

  it('hashes independently of key order but not of content', () => {
    const a: Message = { role: 'user', content: [{ type: 'text', text: 'x' }], toolCalls: [] };
    const b = { toolCalls: [], content: [{ text: 'x', type: 'text' }], role: 'user' } as Message;
    const c: Message = { role: 'user', content: [{ type: 'text', text: 'y' }], toolCalls: [] };

    expect(hashLlmRequestMessages([a])).toBe(hashLlmRequestMessages([b]));
    expect(hashLlmRequestMessages([a])).not.toBe(hashLlmRequestMessages([c]));
  });

  it('reports a session written before messagesHash as count-matched, not verified', async () => {
    await runTurn('Hello', 'Hi');

    const rebuilt = rebuildLastLlmRequest(withoutLlmRequestField(await records(), 'messagesHash'));

    expect(rebuilt).toMatchObject({ status: 'rebuilt', verification: 'count_matched' });
  });

  it.each([
    ['messagesHash', { messagesHash: 'not-the-hash' }, 'messages_hash_mismatch'],
    ['messageCount', { messageCount: 99 }, 'message_count_mismatch'],
    ['systemPromptHash', { systemPromptHash: 'not-the-hash' }, 'system_prompt_mismatch'],
    ['toolsHash', { toolsHash: 'not-the-hash' }, 'tools_unavailable'],
    ['projection', { projection: 'media-stripped' }, 'media_projection'],
    ['strict projection', { projection: 'strict-media-degraded' }, 'media_projection'],
  ])('refuses when %s does not hold', async (_field, edit, reason) => {
    await runTurn('Hello', 'Hi');

    const rebuilt = rebuildLastLlmRequest(editLastLlmRequest(await records(), edit));

    expect(rebuilt).toMatchObject({ status: 'refused', reason });
  });

  it('refuses a tool snapshot that does not match its hash', async () => {
    await runToolTurn();
    const tampered = (await records()).map((record) =>
      record.type === 'llm.tools_snapshot' ? { ...record, tools: [] } : record,
    );

    expect(rebuildLastLlmRequest(tampered)).toMatchObject({
      status: 'refused',
      reason: 'tools_mismatch',
    });
  });

  it('refuses records with no request and sessions from a newer wire protocol', () => {
    expect(rebuildLastLlmRequest([])).toMatchObject({ status: 'refused', reason: 'no_request' });
    expect(
      rebuildLastLlmRequest([{ type: 'metadata', protocol_version: '99.0', created_at: 1 }]),
    ).toMatchObject({ status: 'refused', reason: 'newer_wire_version' });
    expect(rebuildLastLlmRequest([{ type: 'metadata', protocol_version: '99.0' }])).toMatchObject({
      status: 'refused',
      reason: 'newer_wire_version',
    });
  });
});

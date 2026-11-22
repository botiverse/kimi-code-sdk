import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeSessionById, getLiveSessionById } from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T = unknown> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
}

interface MockLlm {
  readonly port: number;
  readonly hits: string[];
  readonly close: () => Promise<void>;
}

function sseText(text: string): string {
  return (
    [
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      }),
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
    ]
      .map((event) => `data: ${event}\n\n`)
      .join('') + 'data: [DONE]\n\n'
  );
}

async function startMockLlm(
  respond: (body: string, hitIndex: number) => string | Promise<string>,
): Promise<MockLlm> {
  const hits: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const index = hits.length;
      hits.push(body);
      void Promise.resolve(respond(body, index)).then((payload) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(payload);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('LLM mock missing port');
  }
  return {
    port: address.port,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function configToml(llmPort: number): string {
  return [
    'default_model = "stub"',
    '',
    '[providers.stub]',
    'type = "openai"',
    `base_url = "http://127.0.0.1:${String(llmPort)}"`,
    'api_key = "stub"',
    '',
    '[models.stub]',
    'provider = "stub"',
    'model = "stub"',
    'max_context_size = 100000',
    '',
  ].join('\n');
}

function systemPromptFromHit(rawBody: string): string {
  const parsed = JSON.parse(rawBody) as {
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  const systemMsg = parsed.messages?.find((msg) => msg.role === 'system');
  if (typeof systemMsg?.content === 'string') return systemMsg.content;
  return JSON.stringify(systemMsg?.content ?? '');
}

describe('KAP per-session append_system_prompt', () => {
  let home: string | undefined;
  let workspace: string | undefined;
  let server: RunningServer | undefined;
  let llm: MockLlm | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (llm !== undefined) {
      await llm.close();
      llm = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      workspace = undefined;
    }
  });

  async function boot(): Promise<string> {
    home = await mkdtemp(join(tmpdir(), 'kimi-kap-append-home-'));
    workspace = await mkdtemp(join(tmpdir(), 'kimi-kap-append-ws-'));
    if (llm !== undefined) {
      await writeFile(join(home, 'config.toml'), configToml(llm.port), 'utf8');
    }
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    return `http://127.0.0.1:${String(server.port)}`;
  }

  async function callJson<T>(
    base: string,
    method: string,
    path: string,
    rawBody?: string,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(
        server as RunningServer,
        rawBody === undefined ? {} : { 'content-type': 'application/json' },
      ),
      body: rawBody,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function waitIdle(base: string, sid: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const wait = await callJson<{ session: { activity: string } }>(
        base,
        'POST',
        `/api/v1/sessions/${encodeURIComponent(sid)}:wait`,
        JSON.stringify({ timeout_ms: 5000 }),
      );
      if (wait.body.code === 0 && wait.body.data.session.activity === 'idle') return;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for session ${sid} to become idle`);
      }
    }
  }

  it('advertises capabilities.session_append_system_prompt', async () => {
    const base = await boot();
    const meta = await callJson<{ capabilities: Record<string, boolean> }>(
      base,
      'GET',
      '/api/v1/meta',
    );
    expect(meta.body.code).toBe(0);
    expect(meta.body.data.capabilities['session_append_system_prompt']).toBe(true);
  });

  it('isolates append_system_prompt per session and supports preserve, update, live update, and clear on resume', async () => {
    llm = await startMockLlm(() => sseText('ok'));
    const base = await boot();

    const createA = await callJson<{ id: string }>(
      base,
      'POST',
      '/api/v1/sessions',
      JSON.stringify({ cwd: workspace, append_system_prompt: 'MARKER_A_CREATE' }),
    );
    expect(createA.body.code).toBe(0);
    const sidA = createA.body.data.id;

    const createB = await callJson<{ id: string }>(
      base,
      'POST',
      '/api/v1/sessions',
      JSON.stringify({ cwd: workspace }),
    );
    expect(createB.body.code).toBe(0);
    const sidB = createB.body.data.id;

    const pA1 = await callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}/prompts`,
      JSON.stringify({ content: [{ type: 'text', text: 'turn A1' }], model: 'stub', permission_mode: 'yolo' }),
    );
    expect(pA1.body.code).toBe(0);
    await waitIdle(base, sidA);
    expect(systemPromptFromHit(llm.hits[0]!)).toContain('MARKER_A_CREATE');

    const pB1 = await callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidB)}/prompts`,
      JSON.stringify({ content: [{ type: 'text', text: 'turn B1' }], model: 'stub', permission_mode: 'yolo' }),
    );
    expect(pB1.body.code).toBe(0);
    await waitIdle(base, sidB);
    expect(systemPromptFromHit(llm.hits[1]!)).not.toContain('MARKER_A_CREATE');

    await closeSessionById(server!.core.accessor, sidA);
    expect(getLiveSessionById(server!.core.accessor, sidA)).toBeUndefined();

    const coldPreserve = await callJson<{ id: string }>(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}:resume`,
      JSON.stringify({}),
    );
    expect(coldPreserve.body.code).toBe(0);

    const pA2 = await callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}/prompts`,
      JSON.stringify({ content: [{ type: 'text', text: 'turn A2' }], model: 'stub', permission_mode: 'yolo' }),
    );
    expect(pA2.body.code).toBe(0);
    await waitIdle(base, sidA);
    expect(systemPromptFromHit(llm.hits[2]!)).toContain('MARKER_A_CREATE');

    await closeSessionById(server!.core.accessor, sidA);
    const coldReplace = await callJson<{ id: string }>(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}:resume`,
      JSON.stringify({ append_system_prompt: 'MARKER_A_COLD' }),
    );
    expect(coldReplace.body.code).toBe(0);

    const pA3 = await callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}/prompts`,
      JSON.stringify({ content: [{ type: 'text', text: 'turn A3' }], model: 'stub', permission_mode: 'yolo' }),
    );
    expect(pA3.body.code).toBe(0);
    await waitIdle(base, sidA);
    expect(systemPromptFromHit(llm.hits[3]!)).toContain('MARKER_A_COLD');
    expect(systemPromptFromHit(llm.hits[3]!)).not.toContain('MARKER_A_CREATE');

    const liveReplace = await callJson<{ id: string }>(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}:resume`,
      JSON.stringify({ append_system_prompt: 'MARKER_A_LIVE' }),
    );
    expect(liveReplace.body.code).toBe(0);

    const pA4 = await callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}/prompts`,
      JSON.stringify({ content: [{ type: 'text', text: 'turn A4' }], model: 'stub', permission_mode: 'yolo' }),
    );
    expect(pA4.body.code).toBe(0);
    await waitIdle(base, sidA);
    expect(systemPromptFromHit(llm.hits[4]!)).toContain('MARKER_A_LIVE');
    expect(systemPromptFromHit(llm.hits[4]!)).not.toContain('MARKER_A_COLD');

    await closeSessionById(server!.core.accessor, sidA);
    const coldClear = await callJson<{ id: string }>(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}:resume`,
      JSON.stringify({ append_system_prompt: '' }),
    );
    expect(coldClear.body.code).toBe(0);

    const pA5 = await callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}/prompts`,
      JSON.stringify({ content: [{ type: 'text', text: 'turn A5' }], model: 'stub', permission_mode: 'yolo' }),
    );
    expect(pA5.body.code).toBe(0);
    await waitIdle(base, sidA);
    const clearedSystem = systemPromptFromHit(llm.hits[5]!);
    expect(clearedSystem).not.toContain('MARKER_A_CREATE');
    expect(clearedSystem).not.toContain('MARKER_A_COLD');
    expect(clearedSystem).not.toContain('MARKER_A_LIVE');
  }, 45_000);

  it('refuses live :resume with append_system_prompt while a turn is active', async () => {
    let releaseLlm!: () => void;
    const llmGate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });
    llm = await startMockLlm(async () => {
      await llmGate;
      return sseText('done');
    });
    const base = await boot();

    const created = await callJson<{ id: string }>(
      base,
      'POST',
      '/api/v1/sessions',
      JSON.stringify({ cwd: workspace }),
    );
    const sid = created.body.data.id;

    const prompt = await callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sid)}/prompts`,
      JSON.stringify({ content: [{ type: 'text', text: 'hold on' }], model: 'stub' }),
    );
    expect(prompt.body.code).toBe(0);

    const busyResume = await callJson<null>(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sid)}:resume`,
      JSON.stringify({ append_system_prompt: 'SHOULD_FAIL' }),
    );
    expect(busyResume.body.code).toBe(ErrorCode.SESSION_BUSY);

    releaseLlm();
    await waitIdle(base, sid);
  }, 30_000);
});

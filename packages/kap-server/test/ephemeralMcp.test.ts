import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAIN_AGENT_ID, closeSessionById, getLiveSessionById } from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T = unknown> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
  readonly details?: { path: string; message: string }[];
}

interface HttpMcpMock {
  readonly url: string;
  readonly authHeadersSeen: string[];
  readonly toolCallsSeen: unknown[];
  readonly close: () => Promise<void>;
}

interface MockLlm {
  readonly port: number;
  readonly hits: string[];
  readonly close: () => Promise<void>;
}

function sseLines(...events: readonly string[]): string {
  return events.map((event) => `data: ${event}\n\n`).join('') + 'data: [DONE]\n\n';
}

function sseText(text: string): string {
  return sseLines(
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
  );
}

function sseToolCall(id: string, name: string, args: string): string {
  return sseLines(
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }],
          },
          finish_reason: null,
        },
      ],
    }),
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
    }),
  );
}

async function startHttpMcpServer(): Promise<HttpMcpMock> {
  const authHeadersSeen: string[] = [];
  const toolCallsSeen: unknown[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string') {
      authHeadersSeen.push(auth);
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'mock-http-mcp', version: '1.0.0' },
            },
          }),
        );
        return;
      }
      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                {
                  name: 'ping',
                  description: 'Echoes text over ephemeral HTTP MCP',
                  inputSchema: {
                    type: 'object',
                    properties: { note: { type: 'string' } },
                    required: ['note'],
                  },
                },
              ],
            },
          }),
        );
        return;
      }
      if (msg.method === 'tools/call') {
        toolCallsSeen.push(msg.params);
        const args = (msg.params?.['arguments'] as Record<string, unknown> | undefined) ?? {};
        const note = typeof args['note'] === 'string' ? args['note'] : '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: `pong:${note}` }] },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('MCP mock missing port');
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    authHeadersSeen,
    toolCallsSeen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
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

describe('KAP per-session ephemeral mcp_servers', () => {
  let home: string | undefined;
  let workspace: string | undefined;
  let server: RunningServer | undefined;
  let mcpServer: HttpMcpMock | undefined;
  let llm: MockLlm | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (mcpServer !== undefined) {
      await mcpServer.close();
      mcpServer = undefined;
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
    home = await mkdtemp(join(tmpdir(), 'kimi-kap-eph-mcp-home-'));
    workspace = await mkdtemp(join(tmpdir(), 'kimi-kap-eph-mcp-ws-'));
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

  it('advertises capabilities.session_ephemeral_mcp and rejects reserved server names', async () => {
    const base = await boot();

    const meta = await callJson<{ capabilities: Record<string, boolean> }>(
      base,
      'GET',
      '/api/v1/meta',
    );
    expect(meta.body.code).toBe(0);
    expect(meta.body.data.capabilities['session_ephemeral_mcp']).toBe(true);

    for (const badName of ['__proto__', 'constructor', 'prototype', '   ']) {
      const raw = JSON.stringify({ cwd: workspace })
        .slice(0, -1)
        .concat(
          `,"mcp_servers":{${JSON.stringify(badName)}:{"transport":"http","url":"http://127.0.0.1:9999/mcp"}}}`,
        );
      const res = await callJson<null>(base, 'POST', '/api/v1/sessions', raw);
      expect(res.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    }

    const valid = await callJson<{ id: string }>(
      base,
      'POST',
      '/api/v1/sessions',
      JSON.stringify({ cwd: workspace }),
    );
    expect(valid.body.code).toBe(0);

    const badResumeRaw = `{"mcp_servers":{"__proto__":{"transport":"http","url":"http://127.0.0.1:9999/mcp"}}}`;
    const badResume = await callJson<null>(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(valid.body.data.id)}:resume`,
      badResumeRaw,
    );
    expect(badResume.body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('isolates ephemeral MCP servers per session, never writes mcp.json, and rotates on resume', async () => {
    mcpServer = await startHttpMcpServer();
    llm = await startMockLlm((body) => {
      const parsed = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const hasPing = parsed.tools?.some((t) => t.function?.name === 'mcp__ephe__ping') ?? false;
      const messages = parsed.messages ?? [];
      if (messages.at(-1)?.role === 'tool') {
        return sseText('tool done');
      }
      let lastNonUserIndex = -1;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role !== 'user') {
          lastNonUserIndex = i;
          break;
        }
      }
      const pendingUserText = messages
        .slice(lastNonUserIndex + 1)
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
        .join('\n');
      if (hasPing && pendingUserText.includes('CALL_PING')) {
        return sseToolCall('call_ping_1', 'mcp__ephe__ping', JSON.stringify({ note: 'hello' }));
      }
      return sseText(hasPing ? 'has_ping' : 'no_ping');
    });
    const base = await boot();

    const createA = await callJson<{ id: string; metadata?: Record<string, unknown> }>(
      base,
      'POST',
      '/api/v1/sessions',
      JSON.stringify({
        cwd: workspace,
        mcp_servers: {
          ephe: {
            transport: 'http',
            url: mcpServer.url,
            headers: { Authorization: 'Bearer tok-1' },
          },
        },
      }),
    );
    expect(createA.body.code).toBe(0);
    const sidA = createA.body.data.id;
    expect(createA.body.data.metadata).toBeUndefined();
    expect(existsSync(join(home as string, 'mcp.json'))).toBe(false);

    const createB = await callJson<{ id: string }>(
      base,
      'POST',
      '/api/v1/sessions',
      JSON.stringify({ cwd: workspace }),
    );
    expect(createB.body.code).toBe(0);
    const sidB = createB.body.data.id;

    const pB = await callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidB)}/prompts`,
      JSON.stringify({ content: [{ type: 'text', text: 'check tools' }], model: 'stub', permission_mode: 'yolo' }),
    );
    expect(pB.body.code).toBe(0);
    await waitIdle(base, sidB);
    const bHit = JSON.parse(llm.hits[0]!) as { tools?: Array<{ function?: { name?: string } }> };
    expect(bHit.tools?.some((t) => t.function?.name === 'mcp__ephe__ping')).toBe(false);

    const pA1 = await callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}/prompts`,
      JSON.stringify({ content: [{ type: 'text', text: 'CALL_PING 1' }], model: 'stub', permission_mode: 'yolo' }),
    );
    expect(pA1.body.code).toBe(0);
    await waitIdle(base, sidA);

    expect(mcpServer.toolCallsSeen.length).toBe(1);
    expect(mcpServer.authHeadersSeen).toContain('Bearer tok-1');
    expect(existsSync(join(home as string, 'mcp.json'))).toBe(false);

    await closeSessionById(server!.core.accessor, sidA);
    expect(getLiveSessionById(server!.core.accessor, sidA)).toBeUndefined();

    const coldResume = await callJson<{ id: string }>(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}:resume`,
      JSON.stringify({
        mcp_servers: {
          ephe: {
            transport: 'http',
            url: mcpServer.url,
            headers: { Authorization: 'Bearer tok-2' },
          },
        },
      }),
    );
    expect(coldResume.body.code).toBe(0);
    expect(coldResume.body.data.id).toBe(sidA);

    const authCountBefore2 = mcpServer.authHeadersSeen.length;
    const pA2 = await callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}/prompts`,
      JSON.stringify({ content: [{ type: 'text', text: 'CALL_PING 2' }], model: 'stub', permission_mode: 'yolo' }),
    );
    expect(pA2.body.code).toBe(0);
    await waitIdle(base, sidA);
    expect(mcpServer.authHeadersSeen.slice(authCountBefore2)).toContain('Bearer tok-2');

    const liveResume = await callJson<{ id: string }>(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}:resume`,
      JSON.stringify({
        mcp_servers: {
          ephe: {
            transport: 'http',
            url: mcpServer.url,
            headers: { Authorization: 'Bearer tok-3' },
          },
        },
      }),
    );
    expect(liveResume.body.code).toBe(0);

    const authCountBefore3 = mcpServer.authHeadersSeen.length;
    const pA3 = await callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sidA)}/prompts`,
      JSON.stringify({ content: [{ type: 'text', text: 'CALL_PING 3' }], model: 'stub', permission_mode: 'yolo' }),
    );
    expect(pA3.body.code).toBe(0);
    await waitIdle(base, sidA);
    expect(mcpServer.authHeadersSeen.slice(authCountBefore3)).toContain('Bearer tok-3');

    const turnsA = await callJson<{ turns: Array<{ items: Array<{ type: string; text?: string }> }> }>(
      base,
      'GET',
      `/api/v1/sessions/${encodeURIComponent(sidA)}/agents/${MAIN_AGENT_ID}/turns`,
    );
    expect(turnsA.body.code).toBe(0);
    expect(turnsA.body.data.turns.length).toBeGreaterThanOrEqual(3);
  }, 45_000);

  it('refuses :resume with mcp_servers while a turn is active', async () => {
    let releaseLlm!: () => void;
    const llmGate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });
    llm = await startMockLlm(async () => {
      await llmGate;
      return sseText('unblocked');
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
      JSON.stringify({
        mcp_servers: {
          ephe: { transport: 'http', url: 'http://127.0.0.1:9999/mcp' },
        },
      }),
    );
    expect(busyResume.body.code).toBe(ErrorCode.SESSION_BUSY);

    releaseLlm();
    await waitIdle(base, sid);
  }, 30_000);
});

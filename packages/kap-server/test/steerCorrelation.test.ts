import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  IAgentLoopService,
  MAIN_AGENT_ID,
  getLiveSessionById,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders, bearerToken } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T = unknown> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
}

interface TurnHeaderWire {
  readonly turn_id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly turn_number?: number;
  readonly steered_from_turn_id?: string;
  readonly steered_from_turn_number?: number;
  readonly steered_from_prompt_id?: string;
}

interface WsFrameWire {
  readonly type: string;
  readonly agent_id?: string;
  readonly turn?: TurnHeaderWire;
}

interface PausedMcpMock {
  readonly url: string;
  readonly waitToolEntered: () => Promise<void>;
  readonly releaseTool: () => void;
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

async function startPausedHttpMcpServer(): Promise<PausedMcpMock> {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
              serverInfo: { name: 'mock-pause-mcp', version: '1.0.0' },
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
                  name: 'pause',
                  description: 'Blocks until released',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }),
        );
        return;
      }
      if (msg.method === 'tools/call') {
        markEntered();
        void gate.then(() => {
          if (res.writableEnded) return;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: 'pause-released' }] },
            }),
          );
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('Paused MCP mock missing port');
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    waitToolEntered: () => entered,
    releaseTool: () => releaseGate(),
    close: () => {
      releaseGate();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
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

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

describe('KAP steered turn parent correlation', () => {
  let home: string | undefined;
  let workspace: string | undefined;
  let server: RunningServer | undefined;
  let mcpServer: PausedMcpMock | undefined;
  let llm: MockLlm | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.close();
    ws = undefined;
    if (mcpServer !== undefined) {
      await mcpServer.close();
      mcpServer = undefined;
    }
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

  async function bootAtHome(homeDir: string): Promise<string> {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir,
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

  it('advertises capabilities.steer_parent_correlation', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-kap-steer-meta-home-'));
    const base = await bootAtHome(home);
    const meta = await callJson<{ capabilities: Record<string, boolean> }>(
      base,
      'GET',
      '/api/v1/meta',
    );
    expect(meta.body.code).toBe(0);
    expect(meta.body.data.capabilities['steer_parent_correlation']).toBe(true);
  });

  it('emits steered_from_* on live WS turn frames and retains them across server restart', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-kap-steer-home-'));
    workspace = await mkdtemp(join(tmpdir(), 'kimi-kap-steer-ws-'));
    mcpServer = await startPausedHttpMcpServer();
    llm = await startMockLlm((body) => {
      const parsed = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const messages = parsed.messages ?? [];
      if (messages.at(-1)?.role === 'tool') {
        return sseText('tool-finished');
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
      if (pendingUserText.includes('RUN_PAUSE')) {
        return sseToolCall('call_pause_1', 'mcp__gate__pause', '{}');
      }
      return sseText('steer-finished');
    });
    await writeFile(join(home, 'config.toml'), configToml(llm.port), 'utf8');
    const base = await bootAtHome(home);

    const created = await callJson<{ id: string }>(
      base,
      'POST',
      '/api/v1/sessions',
      JSON.stringify({
        cwd: workspace,
        mcp_servers: {
          gate: { transport: 'http', url: mcpServer.url },
        },
      }),
    );
    expect(created.body.code).toBe(0);
    const sid = created.body.data.id;

    const frames: WsFrameWire[] = [];
    ws = new WebSocket(
      `ws://127.0.0.1:${String(server!.port)}/api/v1/ws`,
      [`kimi-code.bearer.${bearerToken(server!)}`],
    );
    ws.on('message', (data) => {
      try {
        frames.push(JSON.parse(rawToString(data)) as WsFrameWire);
      } catch {
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', () => resolve());
      ws!.once('error', reject);
    });
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        request_id: 'sub-1',
        session_id: sid,
        agent_ids: [MAIN_AGENT_ID],
      }),
    );
    await vi.waitFor(
      () => expect(frames.some((frame) => frame.type === 'turns' && frame.agent_id === MAIN_AGENT_ID)).toBe(true),
      { timeout: 10_000 },
    );

    const submitParent = await callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sid)}/prompts`,
      JSON.stringify({
        prompt_id: 'prompt-parent',
        content: [{ type: 'text', text: 'RUN_PAUSE' }],
        model: 'stub',
        permission_mode: 'yolo',
      }),
    );
    expect(submitParent.body.code).toBe(0);

    await mcpServer.waitToolEntered();

    const steerPromise = callJson(
      base,
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sid)}/steer`,
      JSON.stringify({
        prompt_id: 'prompt-steer',
        content: [{ type: 'text', text: 'STEER_NOW' }],
      }),
    );

    await vi.waitFor(() => {
      const session = getLiveSessionById(server!.core.accessor, sid);
      const main = session?.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
      const handle = main?.accessor.get(IAgentLoopService).promptHandle('prompt-steer');
      expect(handle).toBeDefined();
    }, { timeout: 10_000 });

    mcpServer.releaseTool();
    const steerRes = await steerPromise;
    expect(steerRes.body.code).toBe(0);
    await waitIdle(base, sid);

    const startedTurns = frames
      .filter(
        (frame): frame is WsFrameWire & { turn: TurnHeaderWire } =>
          frame.type === 'turn.started' && frame.agent_id === MAIN_AGENT_ID && frame.turn !== undefined,
      )
      .map((frame) => frame.turn);
    const endedTurns = frames
      .filter(
        (frame): frame is WsFrameWire & { turn: TurnHeaderWire } =>
          frame.type === 'turn.ended' && frame.agent_id === MAIN_AGENT_ID && frame.turn !== undefined,
      )
      .map((frame) => frame.turn);

    const parentStarted = startedTurns.find((turn) => turn.turn_number === 0);
    const steeredStarted = startedTurns.find((turn) => turn.turn_number === 1);
    const steeredEnded = endedTurns.find((turn) => turn.turn_number === 1);

    expect(parentStarted).toBeDefined();
    expect(parentStarted?.steered_from_turn_id).toBeUndefined();
    expect(parentStarted?.steered_from_turn_number).toBeUndefined();
    expect(parentStarted?.steered_from_prompt_id).toBeUndefined();

    expect(steeredStarted).toBeDefined();
    expect(steeredStarted?.steered_from_turn_id).toBe(parentStarted!.turn_id);
    expect(steeredStarted?.steered_from_turn_number).toBe(0);
    expect(steeredStarted?.steered_from_prompt_id).toBe('prompt-parent');

    expect(steeredEnded).toBeDefined();
    expect(steeredEnded?.steered_from_turn_id).toBe(parentStarted!.turn_id);
    expect(steeredEnded?.steered_from_turn_number).toBe(0);
    expect(steeredEnded?.steered_from_prompt_id).toBe('prompt-parent');

    ws.close();
    ws = undefined;
    await server!.close();
    server = undefined;

    const restartedBase = await bootAtHome(home);
    const history = await callJson<{ turns: TurnHeaderWire[] }>(
      restartedBase,
      'GET',
      `/api/v1/sessions/${encodeURIComponent(sid)}/agents/${MAIN_AGENT_ID}/turns`,
    );
    expect(history.body.code).toBe(0);
    const persistedParent = history.body.data.turns.find((turn) => turn.turn_number === 0);
    const persistedSteered = history.body.data.turns.find((turn) => turn.turn_number === 1);
    expect(persistedParent).toBeDefined();
    expect(persistedParent?.steered_from_turn_id).toBeUndefined();
    expect(persistedSteered).toBeDefined();
    expect(persistedSteered?.steered_from_turn_id).toBe(parentStarted!.turn_id);
    expect(persistedSteered?.steered_from_turn_number).toBe(0);
    expect(persistedSteered?.steered_from_prompt_id).toBe('prompt-parent');
  }, 45_000);
});

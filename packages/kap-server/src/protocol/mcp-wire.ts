import type { GlobalMcpServerConfig } from '@moonshot-ai/agent-core-v2';
import type { McpServerConfig } from '@moonshot-ai/agent-core-v2/mcpCore/config-schema';
import { McpTimeoutMsSchema } from '@moonshot-ai/agent-core-v2/mcpCore/config-schema';
import { z } from 'zod';

export const stringRecordSchema = z.record(z.string(), z.string());
export const serverNameSchema = z.string().min(1);

const mcpServerCommonWireFields = {
  enabled: z.boolean().optional(),
  deferred: z.boolean().optional(),
  startup_timeout_ms: McpTimeoutMsSchema.optional(),
  tool_timeout_ms: McpTimeoutMsSchema.optional(),
  enabled_tools: z.array(z.string()).optional(),
  disabled_tools: z.array(z.string()).optional(),
} as const;

export const mcpServerStdioWireSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: stringRecordSchema.optional(),
  cwd: z.string().optional(),
  executor: z.enum(['local', 'kaos']).optional(),
  environment_id: z.string().min(1).optional(),
  ...mcpServerCommonWireFields,
});

export const mcpServerHttpWireSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: stringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearer_token_env_var: z.string().min(1).optional(),
  ...mcpServerCommonWireFields,
});

export const mcpServerSseWireSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: stringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearer_token_env_var: z.string().min(1).optional(),
  ...mcpServerCommonWireFields,
});

export const globalMcpServerConfigSchema = z.discriminatedUnion('transport', [
  mcpServerStdioWireSchema.extend({ name: serverNameSchema }),
  mcpServerHttpWireSchema.extend({ name: serverNameSchema }),
  mcpServerSseWireSchema.extend({ name: serverNameSchema }),
]);

export const mcpServerConfigBodySchema = z.discriminatedUnion('transport', [
  mcpServerStdioWireSchema,
  mcpServerHttpWireSchema,
  mcpServerSseWireSchema,
]);

export type McpServerConfigWire = z.infer<typeof mcpServerConfigBodySchema>;
export type GlobalMcpServerConfigWire = z.infer<typeof globalMcpServerConfigSchema>;

const RESERVED_EPHEMERAL_MCP_SERVER_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function validateEphemeralMcpServerName(name: string): string | undefined {
  if (name.trim().length === 0) {
    return 'MCP server name must not be empty or whitespace';
  }
  if (RESERVED_EPHEMERAL_MCP_SERVER_NAMES.has(name)) {
    return `MCP server name "${name}" is reserved`;
  }
  return undefined;
}

const ephemeralMcpServersRecordSchema = z.record(z.string(), mcpServerConfigBodySchema);

export const ephemeralMcpServersSchema = z.preprocess(
  (value, ctx) => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const name of Object.getOwnPropertyNames(value)) {
        const error = validateEphemeralMcpServerName(name);
        if (error !== undefined) {
          ctx.addIssue({ code: 'custom', message: error, path: [name] });
          return z.NEVER;
        }
      }
    }
    return value;
  },
  ephemeralMcpServersRecordSchema,
);

export type EphemeralMcpServersWire = z.infer<typeof ephemeralMcpServersRecordSchema>;

export function fromMcpServerConfigWire(wire: McpServerConfigWire): McpServerConfig {
  const common = {
    enabled: wire.enabled,
    deferred: wire.deferred,
    startupTimeoutMs: wire.startup_timeout_ms,
    toolTimeoutMs: wire.tool_timeout_ms,
    enabledTools: wire.enabled_tools,
    disabledTools: wire.disabled_tools,
  };
  if (wire.transport === 'stdio') {
    return {
      transport: 'stdio',
      command: wire.command,
      args: wire.args,
      env: wire.env,
      cwd: wire.cwd,
      executor: wire.executor,
      environment_id: wire.environment_id,
      ...common,
    };
  }
  return {
    transport: wire.transport,
    url: wire.url,
    headers: wire.headers,
    auth: wire.auth,
    bearerTokenEnvVar: wire.bearer_token_env_var,
    ...common,
  };
}

export function fromGlobalMcpServerConfigWire(
  wire: GlobalMcpServerConfigWire,
): GlobalMcpServerConfig {
  return { ...fromMcpServerConfigWire(wire), name: wire.name };
}

export function fromEphemeralMcpServersWire(
  wire: EphemeralMcpServersWire,
): Readonly<Record<string, McpServerConfig>> {
  const result: Record<string, McpServerConfig> = {};
  for (const name of Object.getOwnPropertyNames(wire)) {
    const error = validateEphemeralMcpServerName(name);
    if (error !== undefined) {
      throw new Error(error);
    }
    const entry = wire[name];
    if (entry === undefined) continue;
    Object.defineProperty(result, name, {
      value: fromMcpServerConfigWire(entry),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

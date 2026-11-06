import { createHash } from 'node:crypto';

import { produce } from 'immer';

import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import '#/agent/contextMemory/conversationTime';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { project, projectStrict } from '#/agent/contextProjector/projection';
import { profileKey, type ProfileModelState } from '#/agent/profile/profileOps';
import { stripDynamicToolContext } from '#/agent/toolSelect/dynamicTools';
import '#/features/swarm/swarmOps';
import type { Message } from '#/llm-adapter/contract/message';
import { expandedStateFolds, type FoldContext, type ReplayableStateKey, type StateFold } from '#/state/state';
import {
  isNewerWireVersion,
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
} from '#/wire/migration/migration';
import type { WireRecord } from '#/wire/record';
import { flattenChain } from '#/wire/tree/fork';
import { AGENT_SWITCHED_TYPE } from '#/wire/tree/tree';

import {
  LlmRequest,
  type LlmRequestPayload,
  type LlmRequestToolSchema,
  LlmToolsSnapshot,
} from './llmRequestOps';

export type LlmRequestRebuildRefusal =
  | 'no_request'
  | 'newer_wire_version'
  | 'replay_failed'
  | 'media_projection'
  | 'system_prompt_mismatch'
  | 'tools_unavailable'
  | 'tools_mismatch'
  | 'message_count_mismatch'
  | 'messages_hash_mismatch';

export type LlmRequestRebuild =
  | {
      readonly status: 'rebuilt';
      readonly verification: 'verified' | 'count_matched';
      readonly request: LlmRequestPayload;
      readonly protocolVersion?: string;
      readonly systemPrompt: string;
      readonly tools: readonly LlmRequestToolSchema[];
      readonly messages: readonly Message[];
      readonly response?: ContextMessage;
    }
  | {
      readonly status: 'refused';
      readonly reason: LlmRequestRebuildRefusal;
      readonly detail: string;
    };

const NOOP_FOLD_CONTEXT: FoldContext = {
  silent: true,
  checkpoint: () => {},
  clearCheckpoints: () => {},
  undoToCheckpoint: () => {},
  emit: () => {},
};

function foldsByType<S>(key: ReplayableStateKey<S>): ReadonlyMap<string, StateFold<S, any>> {
  const folds = new Map<string, StateFold<S, any>>();
  for (const [cls, fold] of expandedStateFolds(key)) folds.set(cls.type, fold);
  return folds;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

const MEDIA_PART_TYPES: ReadonlySet<string> = new Set(['image_url', 'audio_url', 'video_url']);

export function hashLlmRequestMessages(messages: readonly Message[]): string {
  const hash = createHash('sha256');
  for (const message of messages) {
    const content = message.content.map((part) =>
      MEDIA_PART_TYPES.has(part.type) ? { type: part.type } : part,
    );
    hash.update(canonicalJson({ ...message, content }));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function refused(reason: LlmRequestRebuildRefusal, detail: string): LlmRequestRebuild {
  return { status: 'refused', reason, detail };
}

const HISTORY_REWRITING_RECORD_TYPES: ReadonlySet<string> = new Set([
  'context.apply_compaction',
  'context.clear',
  'context.undo',
  AGENT_SWITCHED_TYPE,
]);

function isWireVersionRecord(
  record: WireRecord,
): record is WireRecord & { readonly protocol_version: string } {
  return record.type === 'metadata' && typeof record['protocol_version'] === 'string';
}

export function rebuildLastLlmRequest(records: Iterable<WireRecord>): LlmRequestRebuild {
  const contextFolds = foldsByType(contextMemoryKey as ReplayableStateKey<ContextMessage[]>);
  const profileFolds = foldsByType(profileKey as ReplayableStateKey<ProfileModelState>);
  const foldContext = (state: ContextMessage[], record: WireRecord): ContextMessage[] => {
    const fold = contextFolds.get(record.type);
    if (fold === undefined) return state;
    return produce(
      state,
      (draft) => fold(draft, record, NOOP_FOLD_CONTEXT) as typeof draft | undefined,
    );
  };
  const foldProfile = (state: ProfileModelState, record: WireRecord): ProfileModelState => {
    const fold = profileFolds.get(record.type);
    if (fold === undefined) return state;
    return produce(
      state,
      (draft) => fold(draft, record, NOOP_FOLD_CONTEXT) as typeof draft | undefined,
    );
  };

  const toolSnapshots = new Map<string, readonly LlmRequestToolSchema[]>();
  let protocolVersion: string | undefined;
  let request: LlmRequestPayload | undefined;
  let systemPrompt = '';
  let historyAtRequest: ContextMessage[] = [];
  let historyAfterResponse: ContextMessage[] = [];
  let responseIndex = -1;
  let messages: readonly Message[] = [];
  let rebuiltHash = '';

  try {
    const wire: WireRecord[] = [];
    let migrations: readonly WireMigration[] = [];
    let targetIndex = -1;
    for (const source of records) {
      if (isWireVersionRecord(source)) {
        protocolVersion = source.protocol_version;
        if (isNewerWireVersion(protocolVersion)) {
          return refused(
            'newer_wire_version',
            `The session was written with wire protocol ${protocolVersion}, newer than this SDK reads.`,
          );
        }
        migrations = resolveWireMigrations(protocolVersion);
      }
      const record = migrateWireRecord(source, migrations);
      wire.push(record);
      if (record.type === LlmToolsSnapshot.type) {
        const snapshot = record as unknown as LlmToolsSnapshot;
        toolSnapshots.set(snapshot.hash, snapshot.tools);
      } else if (record.type === LlmRequest.type && record['kind'] === 'loop') {
        targetIndex = wire.length - 1;
      }
    }
    if (targetIndex === -1) {
      return refused('no_request', 'The records hold no loop request to rebuild.');
    }
    request = LlmRequest.schema.parse(wire[targetIndex]) as LlmRequestPayload;

    const upToRequest = wire.slice(0, targetIndex + 1);
    for (const record of flattenChain(upToRequest)) {
      historyAtRequest = foldContext(historyAtRequest, record);
    }
    let profile = profileKey.initial() as ProfileModelState;
    for (const record of upToRequest) {
      profile = foldProfile(profile, record);
    }
    systemPrompt = request.systemPrompt ?? profile.systemPrompt;

    responseIndex = historyAtRequest.findLastIndex((message) => message.partial === true);
    if (responseIndex !== -1) {
      let history = historyAtRequest;
      for (const record of wire.slice(targetIndex + 1)) {
        if (HISTORY_REWRITING_RECORD_TYPES.has(record.type) || record.type === LlmRequest.type) break;
        history = foldContext(history, record);
        if (history.length <= responseIndex) break;
        historyAfterResponse = history;
      }
    }

    const shaped = request.toolSelect ? historyAtRequest : stripDynamicToolContext(historyAtRequest);
    messages = request.projection === 'strict' ? projectStrict(shaped) : project(shaped);
    rebuiltHash = hashLlmRequestMessages(messages);
  } catch (error) {
    return refused(
      'replay_failed',
      `Replaying the session failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (request.projection?.includes('media') === true) {
    return refused(
      'media_projection',
      `The request was retried with media removed (${request.projection}), which the session does not record enough to repeat.`,
    );
  }

  if (sha256(systemPrompt) !== request.systemPromptHash) {
    return refused('system_prompt_mismatch', 'The system prompt does not match the recorded hash.');
  }

  const tools = toolSnapshots.get(request.toolsHash);
  if (tools === undefined) {
    return refused('tools_unavailable', 'The session holds no tool snapshot for this request.');
  }
  if (sha256(JSON.stringify(tools)) !== request.toolsHash) {
    return refused('tools_mismatch', 'The tool list does not match the recorded hash.');
  }

  if (messages.length !== request.messageCount) {
    return refused(
      'message_count_mismatch',
      `Rebuilt ${messages.length} messages, but the request sent ${request.messageCount}.`,
    );
  }
  if (request.messagesHash !== undefined && rebuiltHash !== request.messagesHash) {
    return refused('messages_hash_mismatch', 'The rebuilt messages do not match the recorded hash.');
  }

  const candidate = responseIndex === -1 ? undefined : historyAfterResponse[responseIndex];
  const response =
    candidate?.role === 'assistant' && (candidate.content.length > 0 || candidate.toolCalls.length > 0)
      ? candidate
      : undefined;
  return {
    status: 'rebuilt',
    verification: request.messagesHash === undefined ? 'count_matched' : 'verified',
    request,
    protocolVersion,
    systemPrompt,
    tools,
    messages,
    ...(response === undefined ? {} : { response }),
  };
}

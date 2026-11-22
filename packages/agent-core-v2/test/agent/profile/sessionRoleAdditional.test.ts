import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { ISessionRoleAdditional, type SessionRoleAdditional } from '#/session/profile/sessionRoleAdditional';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';

import {
  createTestAgent,
  execEnvServices,
  hostEnvironmentServices,
  sessionService,
  type TestAgentContext,
} from '../../harness';

describe('ISessionRoleAdditional and refreshSystemPrompt', () => {
  let ctx: TestAgentContext | undefined;
  let homeDir: string;
  let workDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-role-add-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-role-add-work-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
    await rm(homeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  function setup(roleAdditional: SessionRoleAdditional): {
    loop: IAgentLoopService;
    catalog: ISessionAgentProfileCatalog;
  } {
    const fs = new HostFileSystem();
    ctx = createTestAgent(
      execEnvServices({ hostFs: fs }),
      hostEnvironmentServices(homeDir),
      { cwd: workDir },
      sessionService(ISessionRoleAdditional, roleAdditional),
    );
    return {
      loop: ctx.get(IAgentLoopService),
      catalog: ctx.get(ISessionAgentProfileCatalog),
    };
  }

  it('appends session roleAdditional only to the default agent profile and excludes subagents', async () => {
    const roleAdditional: SessionRoleAdditional = { value: 'UNIQUE_SESSION_DIRECTIVE_ALPHA' };
    const { loop, catalog } = setup(roleAdditional);
    await catalog.ready;

    const defaultProfile = catalog.get('agent');
    expect(defaultProfile).toBeDefined();
    await loop.applyProfile(defaultProfile!);
    expect(loop.data().systemPrompt).toContain('UNIQUE_SESSION_DIRECTIVE_ALPHA');

    const coderProfile = catalog.get('coder');
    expect(coderProfile).toBeDefined();
    await loop.applyProfile(coderProfile!);
    expect(loop.data().systemPrompt).not.toContain('UNIQUE_SESSION_DIRECTIVE_ALPHA');

    const exploreProfile = catalog.get('explore');
    expect(exploreProfile).toBeDefined();
    await loop.applyProfile(exploreProfile!);
    expect(loop.data().systemPrompt).not.toContain('UNIQUE_SESSION_DIRECTIVE_ALPHA');
  });

  it('refreshes, no-ops when unchanged, and clears on empty string via refreshSystemPrompt', async () => {
    const roleAdditional: SessionRoleAdditional = { value: 'MARKER_FIRST' };
    const { loop, catalog } = setup(roleAdditional);
    await catalog.ready;

    const defaultProfile = catalog.get('agent')!;
    await loop.applyProfile(defaultProfile);
    const initialPrompt = loop.data().systemPrompt;
    expect(initialPrompt).toContain('MARKER_FIRST');

    await loop.refreshSystemPrompt();
    expect(loop.data().systemPrompt).toBe(initialPrompt);

    roleAdditional.value = 'MARKER_SECOND';
    await loop.refreshSystemPrompt();
    expect(loop.data().systemPrompt).toContain('MARKER_SECOND');
    expect(loop.data().systemPrompt).not.toContain('MARKER_FIRST');

    roleAdditional.value = '';
    await loop.refreshSystemPrompt();
    expect(loop.data().systemPrompt).not.toContain('MARKER_FIRST');
    expect(loop.data().systemPrompt).not.toContain('MARKER_SECOND');
  });
});

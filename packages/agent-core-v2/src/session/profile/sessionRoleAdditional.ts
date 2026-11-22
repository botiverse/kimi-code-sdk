import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export interface SessionRoleAdditional {
  value: string | undefined;
}

export const ISessionRoleAdditional: ServiceIdentifier<SessionRoleAdditional> =
  createDecorator<SessionRoleAdditional>('sessionRoleAdditional');

export function sessionRoleAdditionalSeed(value: string | undefined): ScopeSeed {
  return [[ISessionRoleAdditional as ServiceIdentifier<unknown>, { value }]];
}

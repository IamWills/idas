import { IdasError, MissingCapabilityError } from '@intent-driven/contracts';
import type { AdaptationContext, Json, Requirement, SignedSandboxDescriptor, Snapshot } from '@intent-driven/contracts';
import type { Change } from '@intent-driven/core';

export interface WorkspacePreview { change: Change; reason?: string; token?: string }

export interface ExtensionProposal {
  requirement: Requirement;
  rationale?: string;
  next: string[];
  candidates: (SignedSandboxDescriptor & { canActivate: boolean })[];
}

export interface WorkspaceClient {
  snapshot(): Promise<Snapshot | null>;
  preview(intent: string): Promise<WorkspacePreview>;
  recommend(context: AdaptationContext): Promise<WorkspacePreview | null>;
  apply(preview: WorkspacePreview): Promise<Snapshot>;
  dispatch(event: string, input: Json, eventId: string): Promise<Snapshot>;
  rollback(revision: number, expectedRevision: number): Promise<Snapshot>;
  discoverExtension?(intent: string): Promise<ExtensionProposal>;
  activateExtension?(intent: string, signature: string): Promise<{ plugin: string; version: string }>;
  suggest?(requirement: Requirement): Promise<Json>;
}

export function sharedClient(token: string): WorkspaceClient {
  async function call<T>(action: string, input: Record<string, Json> = {}): Promise<T> {
    const response = await fetch('/api/idas', {
      method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...input }),
    });
    const payload = await response.json();
    if (!response.ok) {
      if (payload.requirement) throw new MissingCapabilityError(payload.requirement);
      throw new IdasError(payload.code, payload.message);
    }
    return payload as T;
  }

  return {
    async discoverExtension(intent) {
      return (await call<{ proposal: ExtensionProposal }>('suggestExtension', { intent })).proposal;
    },
    async activateExtension(intent, signature) {
      return (await call<{ activation: { plugin: string; version: string } }>('activateExtension', { intent, signature })).activation;
    },
    async snapshot() { return (await call<{ snapshot: Snapshot | null }>('snapshot')).snapshot; },
    async preview(intent) { return (await call<{ preview: WorkspacePreview }>('preview', { intent })).preview; },
    async recommend(context) { return (await call<{ preview: WorkspacePreview | null }>('recommend', { context })).preview; },
    async apply(preview) { return (await call<{ snapshot: Snapshot }>('apply', { token: preview.token! })).snapshot; },
    async dispatch(event, input, eventId) { return (await call<{ snapshot: Snapshot }>('dispatch', { event, input, eventId })).snapshot; },
    async rollback(revision, expectedRevision) {
      return (await call<{ snapshot: Snapshot }>('rollback', { revision, expectedRevision })).snapshot;
    },
  };
}

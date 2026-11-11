import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Engine, Registry } from '@intent-driven/core';
import { canonical, MissingCapabilityError, services } from '@intent-driven/contracts';
import type { Json, Snapshot, Specification, Store } from '@intent-driven/contracts';
import { diffSpecification, echoPlugin, standard } from '@intent-driven/standard';
import type { ReactComponentRegistration } from '@intent-driven/react';
import { Workspace, reactRenderer } from '@intent-driven/react';
import { badgeContract, badgeId, badgeVersion, workbenchAdaptation, workbenchBadge, workbenchCompiler, workbenchTools } from './workbench';
import { sharedClient } from './shared';
import type { ExtensionProposal, WorkspaceClient, WorkspacePreview } from './shared';

const scope = 'workspace';
const key = 'idas.example.v1';
const history = async () => JSON.parse(localStorage.getItem(key) ?? '[]') as Snapshot[];
const store: Store = {
  history,
  async read() { return (await history()).at(-1) ?? null; },
  async compareAndSwap(_scope, expected, next, signal) {
    return navigator.locks.request(key, signal ? { signal } : {}, async () => {
      const items = await history();
      if ((items.at(-1)?.revision ?? 0) !== expected) return false;
      signal?.throwIfAborted();
      localStorage.setItem(key, canonical([...items.slice(-9), next]));
      return true;
    });
  },
};
const registry = new Registry('web');
await registry.load(() => standard({ store, resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry) }));
await registry.load(echoPlugin);
await registry.load(workbenchTools);
await registry.load(workbenchBadge);
await registry.load(workbenchCompiler);
await registry.load(workbenchAdaptation);
await registry.load(reactRenderer);
const engine = new Engine(registry);
const root = createRoot(document.getElementById('root')!);
const getUI = async () => registry.invoke({ id: services.renderer, range: '^1' }, await engine.view(scope), scope,
  new AbortController().signal, 'render') as unknown as Promise<Specification['ui']>;
const localClient: WorkspaceClient = {
  snapshot: () => engine.snapshot(scope),
  async preview(intent) { return { change: await engine.preview(scope, intent) }; },
  recommend: context => engine.recommend(scope, context),
  apply: preview => engine.apply(preview.change),
  dispatch: (event, input, eventId) => engine.dispatch(scope, event, input, eventId),
  rollback: (revision, expectedRevision) => engine.rollback(scope, revision, { expectedRevision }),
  suggest: requirement => engine.suggest(scope, requirement),
};
const nativeComponents = new Map<string, ReactComponentRegistration>([
  [badgeId + '@' + badgeVersion, {
    contract: badgeContract,
    render: ({ label, values, emit }) => <div>
      <strong>{label}</strong>
      <p>{String(values.value)}</p>
      {emit && <button type="button" onClick={() => emit(null)}>Acknowledge status</button>}
    </div>,
  }],
]);
const intents = [
  '将当前应用改造成开发工作台，左侧显示文件、中间显示编辑器、右侧显示 Agent 状态。',
  '修改代码前先显示 Diff，需要我确认后才能提交。',
  '每次发布前先测试，成功后构建并上传，失败则停止并报告。',
  '把右侧 Agent 面板改到底部，并且在手机上改成独立页面。',
];

function App({ initial, initialUI, client, shared = false }: {
  initial: Snapshot | null; initialUI: Specification['ui'] | null; client: WorkspaceClient; shared?: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [ui, setUI] = useState(initialUI);
  const [view, setView] = useState('');
  const [text, setText] = useState(intents[0]!);
  const [pending, setPreview] = useState<WorkspacePreview>();
  const preview = pending?.change;
  const [extension, setExtension] = useState<{ intent: string; proposal: ExtensionProposal }>();
  const [busy, setBusy] = useState(false);
  const reason = pending?.reason;
  const [undo, setUndo] = useState<{ revision: number; expectedRevision: number }>();
  const delta = preview ? diffSpecification(snapshot?.spec ?? null, preview.spec) : null;
  const clearPreview = () => { setPreview(undefined); setExtension(undefined); };
  const [message, setMessage] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await action(); } catch (e) {
      if (e instanceof MissingCapabilityError && client.suggest) {
        try {
          const suggestion = await client.suggest(e.requirement);
          setMessage(e.message + ' · ' + canonical(suggestion));
        } catch { setMessage(e.message); }
      } else setMessage(e instanceof Error ? e.message : String(e));
    }
    finally { setBusy(false); }
  };
  const previewIntent = async () => {
    try { setPreview(await client.preview(text)); }
    catch (error) {
      if (!(error instanceof MissingCapabilityError) || !client.discoverExtension) throw error;
      setExtension({ intent: text, proposal: await client.discoverExtension(text) });
    }
  };
  const refresh = async (s: Snapshot | null) => {
    setSnapshot(s);
    setUI(s ? shared ? s.spec.ui : await getUI() : null);
  };
  return <main>
    <h1>IDAS workspace</h1>
    <p>{shared ? 'Shared workspace' : 'Offline workspace'} · Revision {snapshot?.revision ?? 0}</p>
    {shared && <button type="button" disabled={busy} onClick={() => void run(async () => {
      clearPreview();
      await refresh(await client.snapshot());
    })}>Refresh shared workspace</button>}
    <div aria-label="Example intents">{intents.map((intent, index) =>
      <button key={intent} type="button" disabled={busy} onClick={() => { setText(intent); clearPreview(); }}>
        {'ABCD'[index]} · {['Create workbench', 'Review edits', 'Gate release', 'Adapt layout'][index]}
      </button>)}</div>
    <button type="button" disabled={busy} onClick={() => {
      setText('为开发工作台添加状态指示器。');
      clearPreview();
    }}>Add a status badge</button>
    <button type="button" disabled={busy} onClick={() => {
      setText('为开发工作台添加发布设置表单。');
      clearPreview();
    }}>Add a release settings form</button>
    {shared && <button type="button" disabled={busy} onClick={() => {
      setText('为开发工作台添加检查工作区的操作。');
      clearPreview();
    }}>E · Find an inspection plugin</button>}
    <form onSubmit={e => { e.preventDefault(); clearPreview(); void run(previewIntent); }}>
      <label htmlFor="intent">Describe a change</label>
      <textarea id="intent" value={text} onChange={e => { setText(e.target.value); clearPreview(); }} required maxLength={4000} />
      <button disabled={busy}>Preview change</button>
    </form>
    {snapshot && <button type="button" disabled={busy} onClick={() => {
      clearPreview();
      void run(async () => {
        const device = matchMedia(`(max-width:${snapshot.spec.ui.collapseBelow}px)`).matches ? 'phone' : 'desktop';
        const recommendation = await client.recommend({ device, task: 'review' });
        if (recommendation) setPreview(recommendation);
        else setMessage('No layout change suggested for this screen and task.');
      });
    }}>Suggest a review layout</button>}
    {undo !== undefined && <button type="button" disabled={busy} onClick={() => void run(async () => {
      await refresh(await client.rollback(undo.revision, undo.expectedRevision));
      clearPreview();
      setUndo(undefined);
      setMessage('Previous workspace restored.');
    })}>Restore previous workspace</button>}
    {preview && pending && <section aria-label="Change preview">
      {reason && <p>{reason}</p>}
      <p>Changes: {preview.sections.join(', ')}. Tools: {preview.bindings.map(x => x.capability).join(', ') || 'none'}.</p>
      {delta && <details open><summary>Specification changes</summary><ul>{delta.entries.map(entry =>
        <li key={entry.path}><code>{entry.path}</code> {entry.operation}
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{[
            ...(entry.before === undefined ? [] : ['Before: ' + JSON.stringify(entry.before)]),
            ...(entry.after === undefined ? [] : ['After: ' + JSON.stringify(entry.after)]),
          ].join('\n')}</pre></li>)}</ul>{delta.truncated && <p>Open the candidate specification to see the complete change.</p>}</details>}
      <details><summary>Candidate specification</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(preview.spec, null, 2)}</pre></details>
      <button type="button" disabled={busy} onClick={() => void run(async () => { const applied = await client.apply(pending);
        await refresh(applied);
        setUndo(reason ? { revision: preview.base, expectedRevision: applied.revision } : undefined);
        clearPreview(); setMessage('Change applied.'); })}>Apply change</button>
      <button type="button" disabled={busy} onClick={clearPreview}>Dismiss preview</button>
    </section>}
    {extension && <section aria-label="Extension proposal">
      <h2>Missing capability</h2>
      <p><code>{extension.proposal.requirement.id}@{extension.proposal.requirement.range}</code></p>
      <p>{extension.proposal.rationale ?? 'This host has no signed candidate for the requested tool.'}</p>
      {extension.proposal.candidates.map(candidate => {
        const { manifest, image, keyId } = candidate.descriptor;
        return <article key={candidate.signature}>
          <h3>{manifest.id} {manifest.version}</h3>
          <p>Publisher {keyId} · Requested permissions: {manifest.permissions.join(', ') || 'none'}</p>
          <p style={{ overflowWrap: 'anywhere' }}><code>{image}</code></p>
          <p>Provides {manifest.provides.map(item => item.id + '@' + item.version).join(', ')}.</p>
          <button type="button" disabled={busy || !candidate.canActivate} onClick={() => void run(async () => {
            const activated = await client.activateExtension!(extension.intent, candidate.signature);
            setExtension(undefined);
            setPreview(await client.preview(extension.intent));
            setMessage(activated.plugin + ' activated. Review the new preview before applying.');
          })}>Verify and activate {manifest.id}</button>
          {!candidate.canActivate && <p>The host has not authorized activation of this candidate.</p>}
        </article>;
      })}
      <ol>{extension.proposal.next.map(step => <li key={step}>{step}</li>)}</ol>
      <button type="button" disabled={busy} onClick={() => setExtension(undefined)}>Dismiss extension proposal</button>
    </section>}
    <output aria-live="polite">{message}</output>
    {ui && snapshot && <Workspace components={nativeComponents} ui={ui} data={snapshot.data} mode={snapshot.mode} activeView={view} onNavigate={setView} disabled={busy}
      onEvent={(event: string, input: Json) => void run(async () => {
        await refresh(await client.dispatch(event, input, 'e-' + crypto.randomUUID()));
        setMessage('Event saved.');
      })} />}
  </main>;
}
function SharedConnection() {
  const [token, setToken] = useState('');
  const [connection, setConnection] = useState<{ client: WorkspaceClient; snapshot: Snapshot | null }>();
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  if (connection) return <App initial={connection.snapshot} initialUI={connection.snapshot?.spec.ui ?? null}
    client={connection.client} shared />;
  return <main>
    <h1>Connect to the shared workspace</h1>
    <form onSubmit={event => {
      event.preventDefault(); setError(''); setConnecting(true);
      const client = sharedClient(token.trim());
      void client.snapshot().then(snapshot => {
        setConnection({ client, snapshot }); setToken('');
      }).catch(error => setError(error.message)).finally(() => setConnecting(false));
    }}>
      <label>Workspace token <input type="password" value={token} onChange={event => setToken(event.target.value)}
        required autoComplete="off" /></label>
      <button disabled={connecting}>Connect</button>
    </form>
    <p role="alert">{error}</p>
  </main>;
}

try {
  if (new URLSearchParams(location.search).get('shared') === '1') root.render(<SharedConnection />);
  else {
    const initial = await localClient.snapshot();
    root.render(<App initial={initial} initialUI={initial ? await getUI() : null} client={localClient} />);
  }
} catch (e) { root.render(<p role="alert">{String(e)}</p>); }

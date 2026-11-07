import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Engine, Registry } from '@intent-driven/core';
import type { Change } from '@intent-driven/core';
import { canonical, services } from '@intent-driven/contracts';
import type { Json, Snapshot, Specification, Store } from '@intent-driven/contracts';
import { echoPlugin, standard } from '@intent-driven/standard';
import { Workspace, reactRenderer } from '@intent-driven/react';

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
await registry.load(reactRenderer);
const engine = new Engine(registry);
const root = createRoot(document.getElementById('root')!);
const getUI = async () => registry.invoke({ id: services.renderer, range: '^1' }, await engine.view(scope), scope,
  new AbortController().signal, 'render') as unknown as Promise<Specification['ui']>;
const draft = 'Use 2 columns in dark mode, set status to "Complete", and workflow echo "Hello from IDAS"';

function App({ initial, initialUI }: { initial: Snapshot | null; initialUI: Specification['ui'] | null }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [ui, setUI] = useState(initialUI);
  const [view, setView] = useState('workspace');
  const [text, setText] = useState(draft);
  const [preview, setPreview] = useState<Change>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await action(); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const refresh = async (s: Snapshot) => { setSnapshot(s); setUI(await getUI()); };
  return <main>
    <h1>IDAS workspace</h1>
    <p>Describe a layout or workflow change, review its impact, then apply it. The demo works offline and saves this workspace in your browser.</p>
    <form onSubmit={e => { e.preventDefault(); setPreview(undefined); void run(async () => setPreview(await engine.preview(scope, text))); }}>
      <label htmlFor="intent">Describe a change</label>
      <textarea id="intent" value={text} onChange={e => { setText(e.target.value); setPreview(undefined); }} required maxLength={4000} />
      <button disabled={busy}>Preview change</button>
    </form>
    {preview && <section aria-label="Change preview">
      <p>Changes: {preview.sections.join(', ')}. Tools: {preview.bindings.map(x => x.capability).join(', ') || 'none'}.</p>
      <details><summary>Candidate specification</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(preview.spec, null, 2)}</pre></details>
      <button type="button" disabled={busy} onClick={() => void run(async () => { await refresh(await engine.apply(preview)); setPreview(undefined); setMessage('Change applied.'); })}>Apply change</button>
    </section>}
    <output aria-live="polite">{message}</output>
    {ui && snapshot && <Workspace ui={ui} data={snapshot.data} activeView={view} onNavigate={setView} disabled={busy}
      onEvent={(event: string, input: Json) => void run(async () => {
        await refresh(await engine.dispatch(scope, event, input, 'e-' + crypto.randomUUID()));
        setMessage('Event saved.');
      })} />}
  </main>;
}
try {
  const initial = await engine.snapshot(scope);
  root.render(<App initial={initial} initialUI={initial ? await getUI() : null} />);
} catch (e) { root.render(<p role="alert">{String(e)}</p>); }

import { useId, useState } from 'react';
import { canonical, clone, services } from '@intent-driven/contracts';
import type { Json, Plugin, Snapshot, Specification } from '@intent-driven/contracts';

export interface WorkspaceProps {
  ui: Specification['ui'];
  data: Snapshot['data'];
  activeView: string;
  onNavigate(view: string): void;
  onEvent(event: string, value: Json): void;
  disabled?: boolean;
}
const show = (value: Json | undefined): string => value == null ? '' : typeof value === 'string' ? value : canonical(value);
export function Workspace({ ui, data, activeView, onNavigate, onEvent, disabled }: WorkspaceProps) {
  const instance = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const scope = 'idas-' + instance;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const view = ui.views.find(v => v.id === activeView) ?? ui.views[0];
  if (!view) return null;
  return <section id={scope} data-theme={ui.theme} aria-label="Adaptive workspace">
    <style>{`
      #${scope}{padding:1rem;border:1px solid currentColor;border-radius:.7rem;color-scheme:light dark}
      #${scope}[data-theme=light]{color-scheme:light;background:#fff;color:#18181b}
      #${scope}[data-theme=dark]{color-scheme:dark;background:#18181b;color:#fafafa}
      #${scope} nav{display:flex;flex-wrap:wrap;gap:.5rem}
      #${scope} .idas-grid{display:grid;gap:.75rem;grid-template-columns:repeat(${ui.layout === 'grid' ? ui.columns : 1},minmax(0,1fr))}
      #${scope} .idas-grid>*{min-width:0;overflow-wrap:anywhere}
      #${scope} input{width:100%;box-sizing:border-box}
      @media(max-width:${ui.collapseBelow}px){#${scope} .idas-grid{grid-template-columns:1fr}}
    `}</style>
    <nav aria-label="Workspace views">{ui.views.map(v =>
      <button key={v.id} type="button" aria-current={view.id === v.id ? 'page' : undefined} onClick={() => onNavigate(v.id)}>{v.title}</button>)}</nav>
    <h2>{view.title}</h2>
    <div className="idas-grid">{view.components.map(c => {
      const key = view.id + '/' + c.id;
      if (c.kind === 'button') return <button key={key} type="button" disabled={disabled} onClick={() => c.event && onEvent(c.event, null)}>{c.label}</button>;
      if (c.kind === 'input') return <form key={key} onSubmit={e => { e.preventDefault(); if (!disabled && c.event) onEvent(c.event, drafts[key] ?? show(data[c.state ?? ''])); }}>
        <label>{c.label}<input disabled={disabled} maxLength={1000} value={drafts[key] ?? show(data[c.state ?? ''])}
          onChange={e => setDrafts({ ...drafts, [key]: e.currentTarget.value })} /></label>
        <button disabled={disabled} type="submit">Save</button>
      </form>;
      if (c.kind === 'value') return <div key={key}><strong>{c.label}</strong><p>{show(data[c.state ?? ''])}</p></div>;
      return <p key={key}>{c.label}</p>;
    })}</div>
  </section>;
}
/** A render capability prepares serializable props. The host owns React mounting. */
export function reactRenderer(): Plugin {
  return {
    manifest: { id: 'idas.react', version: '1.0.0', environments: ['web', 'node', 'bun'], requires: [], permissions: [],
      provides: [{ id: services.renderer, version: '1.0.0' }] },
    invoke(_id, input) { return clone(input); },
  };
}

import { useId, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import { canonical, clone, services } from '@intent-driven/contracts';
import type { Json, Plugin, Snapshot, Specification } from '@intent-driven/contracts';

export interface WorkspaceProps {
  ui: Specification['ui'];
  data: Snapshot['data'];
  mode?: string;
  activeView: string;
  onNavigate(view: string): void;
  onEvent(event: string, value: Json): void;
  disabled?: boolean;
}

const show = (value: Json | undefined): string => value == null ? '' : typeof value === 'string' ? value : canonical(value);

export function Workspace({ ui, data, mode, activeView, onNavigate, onEvent, disabled }: WorkspaceProps) {
  const scope = 'idas-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const findView = (id: string) => ui.views.find(view => view.id === id)!;
  const navigation = ui.presentation?.compact.map(findView) ?? ui.views;
  const selected = navigation.find(view => view.id === activeView) ?? navigation[0];
  if (!selected) return null;
  const compactPages = ui.presentation?.compactMode !== 'stack';
  const rows = ui.presentation?.wide.map(row => row.map(findView)) ?? [[selected]];

  return <section id={scope} data-theme={ui.theme} aria-label="Adaptive workspace">
    <style>{`
      #${scope}{padding:1rem;border:1px solid currentColor;border-radius:.7rem;color-scheme:light dark}
      #${scope}[data-theme=light]{color-scheme:light;background:#fff;color:#18181b}
      #${scope}[data-theme=dark]{color-scheme:dark;background:#18181b;color:#fafafa}
      #${scope} nav{display:${ui.presentation ? 'none' : 'flex'};flex-wrap:wrap;gap:.5rem}
      #${scope} .idas-row{display:grid;grid-template-columns:var(--idas-columns);gap:.75rem;margin-bottom:.75rem}
      #${scope} .idas-panel{min-width:0}
      #${scope} .idas-grid{display:grid;gap:.75rem;grid-template-columns:repeat(${!ui.presentation && ui.layout === 'grid' ? ui.columns : 1},minmax(0,1fr))}
      #${scope} .idas-grid>*{min-width:0;overflow-wrap:anywhere}
      #${scope} input,#${scope} textarea{width:100%;box-sizing:border-box}
      #${scope} .idas-value{white-space:pre-wrap}
      @media(max-width:${ui.collapseBelow}px){
        #${scope} nav{display:${compactPages ? 'flex' : 'none'}}
        #${scope} .idas-row,#${scope} .idas-grid{grid-template-columns:1fr}
        ${compactPages ? `
          #${scope} .idas-panel[data-selected="false"]{display:none}
          #${scope} .idas-row:not(:has(.idas-panel[data-selected="true"])){display:none}
        ` : `
          #${scope} .idas-panels{display:grid;gap:.75rem}
          #${scope} .idas-row{display:contents}
        `}
      }
    `}</style>
    <nav aria-label="Workspace views">{navigation.map(view =>
      <button key={view.id} type="button" aria-current={selected.id === view.id ? 'page' : undefined}
        onClick={() => onNavigate(view.id)}>{view.title}</button>)}</nav>
    <div className="idas-panels">{rows.map(row => <div className="idas-row" key={row[0]!.id}
      style={{ '--idas-columns': `repeat(${row.length},minmax(0,1fr))` } as CSSProperties}>
      {row.map(view => <section key={view.id} className="idas-panel" data-selected={view.id === selected.id}>
        <h2>{view.title}</h2>
        <div className="idas-grid">{view.components.map(component => {
          if (component.modes && (!mode || !component.modes.includes(mode))) return null;
          const key = view.id + '/' + component.id;
          if (component.kind === 'button') {
            return <button key={key} type="button" disabled={disabled}
              onClick={() => component.event && onEvent(component.event, null)}>{component.label}</button>;
          }
          if (component.kind === 'input') {
            const props = {
              disabled, maxLength: 1000, value: drafts[key] ?? show(data[component.state ?? '']),
              onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setDrafts(previous => ({ ...previous, [key]: event.target.value })),
            };
            return <form key={key} onSubmit={event => {
              event.preventDefault();
              if (!disabled && component.event) onEvent(component.event, props.value);
            }}>
              <label>{component.label}{component.multiline ? <textarea {...props} rows={5} /> : <input {...props} />}</label>
              <button disabled={disabled} type="submit">Save</button>
            </form>;
          }
          if (component.kind === 'value') {
            return <div key={key}><strong>{component.label}</strong><p className="idas-value">{show(data[component.state ?? ''])}</p></div>;
          }
          return <p key={key}>{component.label}</p>;
        })}</div>
      </section>)}
    </div>)}</div>
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

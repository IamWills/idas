import { useId, useState } from 'react';
import type { ChangeEvent, CSSProperties, ReactNode } from 'react';
import { canonical, clone, componentProps, IdasError, services, workspaceNavigation } from '@intent-driven/contracts';
import type { Component, ComponentContract, Json, Plugin, Snapshot, Specification } from '@intent-driven/contracts';

import { TypedForm } from './form.js';

export interface ReactComponentRegistration {
  contract: ComponentContract;
  render(props: { label: string; values: Readonly<Record<string, Json>>; emit?: (value: Json) => void }): ReactNode;
}

export interface WorkspaceProps {
  ui: Specification['ui'];
  data: Snapshot['data'];
  mode?: string;
  activeView: string;
  onNavigate(view: string): void;
  onEvent(event: string, value: Json): void;
  disabled?: boolean;
  components?: ReadonlyMap<string, ReactComponentRegistration>;
}

const show = (value: Json | undefined): string => value == null ? '' : typeof value === 'string' ? value : canonical(value);

export function Workspace({ ui, data, mode, activeView, onNavigate, onEvent, disabled, components }: WorkspaceProps) {
  const scope = 'idas-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const findView = (id: string) => ui.views.find(view => view.id === id)!;
  const navigation = workspaceNavigation(ui, activeView);
  const selected = ui.views.find(view => view.id === navigation.selected);
  if (!selected) return null;
  const compactPages = ui.presentation?.compactMode !== 'stack';
  const rows = ui.presentation?.wide.map(row => row.map(findView)) ?? [[selected]];

  function renderNode(component: Component, key: string): ReactNode {
    if (component.modes && (!mode || !component.modes.includes(mode))) return null;
    if (component.kind === 'layout') {
      const columns = component.layout === 'grid' ? component.columns ?? 2 : 1;
      return <section key={key} aria-label={component.label || undefined}>
        {component.label && <h3>{component.label}</h3>}
        <div className={'idas-children idas-children-' + component.layout}
          style={{ '--idas-child-columns': `repeat(${columns},minmax(0,1fr))` } as CSSProperties}>
          {component.children.map(child => renderNode(child, key + '/' + child.id))}
        </div>
      </section>;
    }
    if (component.kind === 'plugin') {
      const registered = components?.get(component.capability + '@' + component.version);
      if (!registered) return <p key={key} role="status">{component.label}: unavailable on this host.</p>;
      let values;
      try { values = componentProps(component, registered.contract, data); }
      catch (error) {
        if (!(error instanceof IdasError)) throw error;
        return <p key={key} role="status">{component.label}: invalid properties.</p>;
      }
      const event = component.event;
      const emit = event && !disabled ? (value: Json) => onEvent(event, clone(value)) : undefined;
      const Native = registered.render;
      return <Native key={key} label={component.label} values={values} {...(emit ? { emit } : {})} />;
    }
    if (component.kind === 'form') return <TypedForm key={key} node={component} data={data} disabled={disabled === true}
      submit={payload => onEvent(component.event, payload)} />;
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
  }

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
      #${scope} fieldset label{display:block;margin:.5rem 0}
      #${scope} input[type="checkbox"]{width:auto}
      #${scope} .idas-value{white-space:pre-wrap}
      #${scope} .idas-children{display:grid;gap:.75rem;grid-template-columns:var(--idas-child-columns)}
      #${scope} .idas-children-row{display:flex;flex-wrap:wrap}
      #${scope} .idas-children>*{min-width:0;overflow-wrap:anywhere}
      @media(max-width:${ui.collapseBelow}px){
        #${scope} nav{display:${compactPages ? 'flex' : 'none'}}
        #${scope} .idas-row,#${scope} .idas-grid,#${scope} .idas-children{grid-template-columns:1fr}
        ${compactPages ? `
          #${scope} .idas-panel[data-selected="false"]{display:none}
          #${scope} .idas-row:not(:has(.idas-panel[data-selected="true"])){display:none}
        ` : `
          #${scope} .idas-panels{display:grid;gap:.75rem}
          #${scope} .idas-row{display:contents}
        `}
      }
    `}</style>
    <nav aria-label="Workspace views">{navigation.reachable.map(findView).map(view =>
      <button key={view.id} type="button" aria-current={selected.id === view.id ? 'page' : undefined}
        onClick={() => onNavigate(view.id)}>{view.title}</button>)}</nav>
    <div className="idas-panels">{rows.map(row => <div className="idas-row" key={row[0]!.id}
      style={{ '--idas-columns': `repeat(${row.length},minmax(0,1fr))` } as CSSProperties}>
      {row.map(view => <section key={view.id} className="idas-panel" data-selected={view.id === selected.id}>
        <h2>{view.title}</h2>
        <div className="idas-grid">{view.components.map(node => renderNode(node, view.id + '/' + node.id))}</div>
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

import { assertJson, bindingRoot, canonical, clone, IdasError, specification } from '@intent-driven/contracts';
import type { Component, FormComponent, Json, Specification } from '@intent-driven/contracts';

function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new IdasError('INVALID', message);
}
function unique(values: string[], label: string) {
  need(new Set(values).size === values.length, 'Duplicate ' + label);
}
export function orderedTasks(tasks: Specification['workflows'][number]['tasks']) {
  unique(tasks.map(t => t.id), 'task');
  const known = new Set(tasks.map(t => t.id));
  for (const task of tasks) need(task.after?.every(k => known.has(k)) ?? true, 'Unknown task dependency: ' + task.id);
  const done = new Set<string>();
  const sorted: typeof tasks = [];
  while (sorted.length < tasks.length) {
    const next = tasks.find(t => !done.has(t.id) && (t.after?.every(d => done.has(d)) ?? true));
    need(next, 'Workflow has a dependency cycle');
    done.add(next.id); sorted.push(next);
  }
  return sorted;
}
export function migrate(input: unknown): Json {
  const value = clone(input);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const m = value.metadata;
    if (m && typeof m === 'object' && !Array.isArray(m) && m.schemaVersion === 0) {
      value.metadata = { ...m, schemaVersion: 1, compatibleWith: 'IDSS/1' };
      const ui = value.ui;
      if (ui && typeof ui === 'object' && !Array.isArray(ui)) value.ui = { collapseBelow: 640, theme: 'system', ...ui };
    }
  }
  return value;
}
export function validate(input: unknown): Specification {
  assertJson(input);
  const parsed = specification.safeParse(migrate(input));
  if (!parsed.success) throw new IdasError('INVALID', parsed.error.message);
  const s = parsed.data;
  const hasState = (key: string) => Object.hasOwn(s.state.initial, key);
  unique(s.ui.views.map(v => v.id), 'view');
  if (s.ui.navigation) {
    const views = new Set(s.ui.views.map(view => view.id));
    const { initial, routes } = s.ui.navigation;
    need(views.has(initial), 'Unknown initial navigation view');
    unique(routes.map(route => canonical([route.from, route.to])), 'navigation route');
    for (const route of routes) need(views.has(route.from) && views.has(route.to) && route.from !== route.to, 'Invalid navigation route');
    const reachable = new Set([initial]);
    for (const view of reachable) for (const route of routes) if (route.from === view) reachable.add(route.to);
    need(reachable.size === views.size, 'Navigation contains unreachable views');
  }
  if (s.ui.presentation) {
    const { wide, compact, compactMode } = s.ui.presentation;
    for (const layout of [wide.flat(), compact]) {
      unique(layout, 'presentation view');
      need(layout.length === s.ui.views.length && layout.every(key => s.ui.views.some(view => view.id === key)),
        'Each presentation must reference every view once');
    }
    need(compactMode !== 'stack' || wide.flat().every((key, index) => key === compact[index]),
      'Compact stacks must preserve reading order');
  }
  unique(s.interaction.states, 'interaction state');
  unique(s.workflows.map(w => w.id), 'workflow');
  unique(s.capabilities.map(c => c.id), 'capability');
  unique(Object.values(s.state.rename ?? {}), 'state migration destination');
  for (const key of Object.values(s.state.rename ?? {})) need(hasState(key), 'Unknown state migration destination: ' + key);
  need(s.interaction.states.includes(s.interaction.initial), 'Invalid initial interaction state');
  unique(s.interaction.rules.map(r => canonical([r.from, r.event])), 'transition');
  for (const r of s.interaction.rules) {
    need(s.interaction.states.includes(r.from) && s.interaction.states.includes(r.to), 'Invalid transition state');
    need(!r.workflow || s.workflows.some(w => w.id === r.workflow), 'Unknown workflow: ' + r.workflow);
    need(!r.capture || hasState(r.capture), 'Unknown capture state: ' + r.capture);
    need(r.input?.kind !== 'text' || r.input.minLength <= r.input.maxLength, 'Invalid text length range for event: ' + r.event);
    for (const write of r.set ?? []) need(hasState(write.key), 'Unknown state write: ' + write.key);
  }
  const forms = new Map<string, FormComponent>();
  for (const view of s.ui.views) {
    const ids = new Set<string>();
    function visit(c: Component, depth: number): void {
      need(depth <= 12 && ids.size < 100, 'Component tree exceeds view limits');
      need(!ids.has(c.id), 'Duplicate component: ' + c.id);
      ids.add(c.id);
      need(c.modes?.every(mode => s.interaction.states.includes(mode)) ?? true, 'Unknown component mode: ' + c.id);
      if (c.kind === 'layout') {
        need(c.columns === undefined || c.layout === 'grid', 'Only grids accept columns');
        for (const child of c.children) visit(child, depth + 1);
        return;
      }
      need(!c.event || s.interaction.rules.some(r => r.event === c.event), 'Unknown UI event: ' + c.event);
      if (c.kind === 'form') {
        need(!forms.has(c.id), 'Duplicate form: ' + c.id);
        forms.set(c.id, c);
        unique(c.fields.map(field => field.id), 'form field');
        for (const field of c.fields) {
          need(!field.binding || hasState(bindingRoot(field.binding)), 'Unknown form binding state: ' + field.id);
          if (field.kind === 'text') need((field.minLength ?? 0) <= (field.maxLength ?? 1000), 'Invalid form text bounds: ' + field.id);
          if (field.kind === 'number') need((field.min ?? -Infinity) <= (field.max ?? Infinity), 'Invalid form number bounds: ' + field.id);
          if (field.kind === 'choice') unique(field.options.map(option => option.value), 'choice value');
        }
        return;
      }
      if (c.kind === 'plugin') {
        need(s.capabilities.some(r => r.id === c.capability && r.range === c.version), 'Component requires an exact declared capability: ' + c.capability);
        for (const binding of Object.values(c.bindings ?? {})) need(hasState(bindingRoot(binding)), 'Unknown component binding state: ' + bindingRoot(binding));
        return;
      }
      need(!c.state || hasState(c.state), 'Unknown UI state: ' + c.state);
      need(c.kind !== 'button' || c.event, 'Button requires an event');
      need(c.kind !== 'input' || (c.event && c.state), 'Input requires state and event');
      need(c.kind !== 'value' || c.state, 'Value requires state');
      need(c.multiline === undefined || c.kind === 'input', 'Only inputs can be multiline');
    }
    for (const component of view.components) visit(component, 1);
  }
  for (const form of forms.values()) {
    need(s.interaction.rules.filter(rule => rule.event === form.event).every(rule => rule.input?.kind === 'form' && rule.input.id === form.id),
      'Every transition for ' + form.event + ' must use form ' + form.id);
  }
  for (const rule of s.interaction.rules) {
    if (rule.input?.kind === 'form') need(forms.get(rule.input.id)?.event === rule.event, 'Unknown form for event: ' + rule.event);
  }
  for (const w of s.workflows) for (const t of orderedTasks(w.tasks)) {
    need(!t.capability.startsWith('idas.') && !t.capability.startsWith('ui.') && s.capabilities.some(c => c.id === t.capability), 'Task must reference a declared tool capability: ' + t.capability);
    need(!t.saveAs || hasState(t.saveAs), 'Unknown task output state: ' + t.saveAs);
    need(!t.when || hasState(t.when.key), 'Unknown task condition state');
    need(!t.inputFrom || hasState(bindingRoot(t.inputFrom)), 'Unknown task input state for ' + t.id);
    need(!(t.inputFrom && t.inputBindings), 'Task cannot use two input binding forms');
    need(!(t.inputFrom || t.inputBindings) || t.input === null, 'Bound task input requires a null literal placeholder');
    for (const binding of Object.values(t.inputBindings ?? {})) need(hasState(bindingRoot(binding)), 'Unknown task input state: ' + bindingRoot(binding));
  }
  return s;
}

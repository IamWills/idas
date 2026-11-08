import { clone, IdasError, services } from '@intent-driven/contracts';
import type { Json, Plugin, Specification } from '@intent-driven/contracts';
import { compileOffline } from '@intent-driven/standard';
import type { CompileInput } from '@intent-driven/standard';

type Workflow = Specification['workflows'][number];
type Rule = Specification['interaction']['rules'][number];
const initialCode = 'export const ready = true;';
const sourceInput = { kind: 'text', minLength: 1, maxLength: 1000 } as const;
const tool = (id: string) => ({ id: 'workbench.' + id, range: '^1.0.0' });

function installWorkflow(spec: Specification, workflow: Workflow) {
  spec.workflows = spec.workflows.filter(item => item.id !== workflow.id).concat(workflow);
  for (const task of workflow.tasks) {
    if (!spec.capabilities.some(item => item.id === task.capability)) {
      spec.capabilities.push({ id: task.capability, range: '^1.0.0' });
    }
  }
}
function replaceRule(spec: Specification, rule: Rule) {
  spec.interaction.rules = spec.interaction.rules.filter(item => item.event !== rule.event || item.from !== rule.from);
  spec.interaction.rules.push(rule);
}

export function compileWorkbench(input: CompileInput): Specification {
  const { text, previous, context, scope } = input;
  const create = /开发工作台|developer workbench/i.test(text);
  const move = /(?:底部.*(?:手机|移动端)|bottom.*(?:phone|mobile))/i.test(text);
  const review = /diff/i.test(text) && /确认|confirm/i.test(text);
  const release = /发布.*测试.*构建.*上传|release.*test.*build.*upload/i.test(text);
  const inspect = /检查工作区|inspect (?:the )?workspace/i.test(text);
  if (!create && !move && !review && !release && !inspect) return compileOffline(input);

  const existing = previous !== null && ['files', 'editor', 'agent'].every(id => previous.ui.views.some(view => view.id === id))
    && ['draft', 'committed', 'status', 'diff', 'passed', 'artifact', 'report'].every(key => Object.hasOwn(previous.state.initial, key))
    && previous.interaction.states.includes('ready');
  if (!create && !existing) throw new IdasError('INVALID', 'Create the developer workbench before changing its behavior');
  const spec = existing ? structuredClone(previous!) : compileOffline({ ...input, text: 'stack', previous: null });
  if (!existing) {
    spec.ui.views = [
      { id: 'files', title: 'Files', components: [{ id: 'source-file', kind: 'text', label: 'src/main.ts' }] },
      { id: 'editor', title: 'Editor', components: [
        { id: 'source', kind: 'input', label: 'src/main.ts', event: 'edit', state: 'draft', multiline: true },
        { id: 'committed', kind: 'value', label: 'Committed code', state: 'committed' },
      ] },
      { id: 'agent', title: 'Agent status', components: [{ id: 'status', kind: 'value', label: 'Status', state: 'status' }] },
    ];
    spec.ui.presentation = { wide: [['files', 'editor', 'agent']], compact: ['files', 'editor', 'agent'], compactMode: 'stack' };
    spec.interaction.rules = [{ event: 'edit', from: 'ready', to: 'ready', capture: 'draft', workflow: 'commit', input: sourceInput }];
    spec.state.initial = { draft: initialCode, committed: initialCode, status: 'Ready', diff: '', passed: false, artifact: '', report: '' };
    if (previous) spec.state.version = previous.state.version + 1;
    installWorkflow(spec, { id: 'commit', tasks: [
      { id: 'save', capability: tool('commit').id, input: null, inputFrom: 'draft', saveAs: 'committed' },
    ] });
  }
  if (move) spec.ui.presentation = { wide: [['files', 'editor'], ['agent']], compact: ['editor', 'files', 'agent'], compactMode: 'pages' };
  const editor = spec.ui.views.find(view => view.id === 'editor')!;
  const agent = spec.ui.views.find(view => view.id === 'agent')!;
  if (review) {
    if (!spec.interaction.states.includes('review')) spec.interaction.states.push('review');
    for (const from of ['ready', 'review']) {
      replaceRule(spec, { event: 'edit', from, to: 'review', capture: 'draft', workflow: 'diff', input: sourceInput });
    }
    replaceRule(spec, { event: 'confirm', from: 'review', to: 'ready', workflow: 'commit',
      set: [{ key: 'status', value: 'Change confirmed' }] });
    replaceRule(spec, { event: 'cancel-review', from: 'review', to: 'ready',
      set: [{ key: 'status', value: 'Review cancelled' }] });
    editor.components = editor.components.filter(component => !['diff', 'confirm', 'cancel-review'].includes(component.id)).concat([
      { id: 'diff', kind: 'value', label: 'Diff', state: 'diff', modes: ['review'] },
      { id: 'confirm', kind: 'button', label: 'Confirm change', event: 'confirm', modes: ['review'] },
      { id: 'cancel-review', kind: 'button', label: 'Cancel review', event: 'cancel-review', modes: ['review'] },
    ]);
    installWorkflow(spec, { id: 'diff', tasks: [{
      id: 'preview', capability: tool('diff').id, input: null,
      inputBindings: { before: 'committed', after: 'draft' }, saveAs: 'diff',
    }] });
  }
  if (release) {
    replaceRule(spec, { event: 'release', from: 'ready', to: 'ready', workflow: 'release',
      set: [{ key: 'artifact', value: '' }, { key: 'report', value: '' }] });
    agent.components = agent.components.filter(component => !['release', 'report'].includes(component.id)).concat([
      { id: 'release', kind: 'button', label: 'Run release', event: 'release', modes: ['ready'] },
      { id: 'report', kind: 'value', label: 'Release result', state: 'report' },
    ]);
    installWorkflow(spec, { id: 'release', tasks: [
      { id: 'test', capability: tool('test').id, input: null, inputFrom: 'committed', saveAs: 'passed' },
      { id: 'report-failure', capability: tool('report').id, input: 'Tests failed. Release stopped.', after: ['test'],
        when: { key: 'passed', equals: false }, saveAs: 'report' },
      { id: 'build', capability: tool('build').id, input: null, inputFrom: 'committed', after: ['test'],
        when: { key: 'passed', equals: true }, saveAs: 'artifact' },
      { id: 'upload', capability: tool('upload').id, input: null, inputFrom: 'artifact', after: ['build'], saveAs: 'report' },
    ] });
  }
  if (inspect) {
    spec.state.initial.inspection = '';
    replaceRule(spec, { event: 'inspect', from: 'ready', to: 'ready', workflow: 'inspect' });
    agent.components = agent.components.filter(component => !['inspect', 'inspection'].includes(component.id)).concat([
      { id: 'inspect', kind: 'button', label: 'Inspect workspace', event: 'inspect', modes: ['ready'] },
      { id: 'inspection', kind: 'value', label: 'Inspection result', state: 'inspection' },
    ]);
    installWorkflow(spec, { id: 'inspect', tasks: [
      { id: 'inspect', capability: tool('inspect').id, input: null, saveAs: 'inspection' },
    ] });
  }
  spec.intent = { ...spec.intent, goal: text, context, scope };
  spec.metadata = { ...spec.metadata, source: 'workbench-demo', changes: [...spec.metadata.changes.slice(-19), text.slice(0, 1000)] };
  return spec;
}

/** An isolated example workspace. Commit, build and upload operate on demo data only. */
export function workbenchTools(): Plugin {
  const names = ['commit', 'diff', 'test', 'report', 'build', 'upload'];
  return {
    manifest: { id: 'workbench.demo', version: '1.0.0', environments: ['any'], requires: [], permissions: [],
      provides: names.map(name => ({ id: tool(name).id, version: '1.0.0' })) },
    invoke(id, input: Json) {
      if (id === tool('diff').id && input && typeof input === 'object' && !Array.isArray(input)
          && typeof input.before === 'string' && typeof input.after === 'string') {
        if (input.before === input.after) return 'No changes';
        return ['--- committed', '+++ proposed', ...input.before.split('\n').map(line => '-' + line),
          ...input.after.split('\n').map(line => '+' + line)].join('\n');
      }
      if (typeof input !== 'string') throw new IdasError('INVALID', 'Workbench tool requires text');
      if (id === tool('test').id) return input.trim() === initialCode;
      if (id === tool('build').id) return 'demo-artifact:' + input.length;
      if (id === tool('upload').id) return 'Uploaded to demo target: ' + input;
      if (id === tool('commit').id || id === tool('report').id) return input;
      throw new IdasError('MISSING', 'Unknown workbench tool');
    },
  };
}

export function workbenchAdaptation(): Plugin {
  return {
    manifest: {
      id: 'workbench.adaptation', version: '1.0.0', environments: ['any'], requires: [], permissions: [],
      provides: [{ id: services.adaptation, version: '1.0.0' }],
    },
    invoke(_id, input) {
      const { context, previous } = input as unknown as {
        context: { device: string; task: string }; previous: Specification;
      };
      const presentation = previous.ui.presentation;
      if (context.device !== 'phone' || context.task !== 'review' ||
          !presentation || presentation.compactMode === 'pages' || !previous.ui.views.some(view => view.id === 'agent')) return null;
      return {
        intent: 'Move the Agent panel to the bottom and give it a separate page on mobile.',
        reason: 'You are reviewing on a phone. Separate pages give the editor and agent status their own space.',
      };
    },
  };
}

export function workbenchCompiler(): Plugin {
  return {
    manifest: {
      id: 'workbench.compiler', version: '1.0.0', environments: ['any'], requires: [], permissions: [],
      provides: [{ id: services.compiler, version: '1.0.1' }],
    },
    invoke(_id, input) {
      return clone(compileWorkbench(input as unknown as CompileInput));
    },
  };
}

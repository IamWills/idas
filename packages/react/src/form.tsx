import { useState } from 'react';
import { bindingValue, validateFormPayload } from '@intent-driven/contracts';
import type { FormComponent, FormField, Json } from '@intent-driven/contracts';

export function TypedForm({ node, data, disabled, submit }: {
  node: FormComponent; data: Record<string, Json>; disabled: boolean; submit(payload: Json): void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState('');
  function value(field: FormField): string | boolean {
    if (Object.hasOwn(drafts, field.id)) return drafts[field.id]!;
    const bound = field.binding ? bindingValue(data, field.binding) : undefined;
    if (field.kind === 'boolean') return bound === true;
    if (field.kind === 'number') return typeof bound === 'number' ? String(bound) : '';
    return typeof bound === 'string' ? bound : '';
  }
  const change = (id: string, next: string | boolean) => {
    setDrafts(previous => ({ ...previous, [id]: next }));
    setError('');
  };
  return <form noValidate onSubmit={event => {
    event.preventDefault();
    if (disabled) return;
    const payload: Record<string, Json> = {};
    for (const field of node.fields) {
      const draft = value(field);
      if (draft === '' && !field.required) continue;
      payload[field.id] = field.kind === 'number' && draft !== '' ? Number(draft) : draft;
    }
    try { validateFormPayload(node, payload); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Invalid form'); return; }
    submit(payload);
  }}>
    <fieldset disabled={disabled}>
      <legend>{node.label}</legend>
      {node.fields.map(field => <label key={field.id}>{field.label}
        {field.kind === 'boolean' ? <input type="checkbox" checked={value(field) === true}
          onChange={event => change(field.id, event.target.checked)} />
          : field.kind === 'choice' ? <select value={String(value(field))} onChange={event => change(field.id, event.target.value)} required={field.required}>
            <option value="">Select an option</option>
            {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          : <input type={field.kind === 'number' ? 'number' : 'text'} value={String(value(field))} required={field.required}
            {...(field.kind === 'number' ? { step: 'any', min: field.min, max: field.max } : { maxLength: field.maxLength ?? 1000 })}
            onChange={event => change(field.id, event.target.value)} />}
      </label>)}
      <button type="submit">Submit</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </form>;
}

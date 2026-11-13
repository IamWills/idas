import { canonical, clone } from '@intent-driven/contracts';
import type { Json, Specification } from '@intent-driven/contracts';

export interface SpecificationDelta {
  path: string;
  operation: 'add' | 'remove' | 'replace';
  before?: Json;
  after?: Json;
}

export function diffSpecification(before: Specification | null, after: Specification): {
  entries: SpecificationDelta[];
  truncated: boolean;
} {
  const entries: SpecificationDelta[] = [];
  let truncated = false;
  const isRecord = (value: Json | undefined): value is Record<string, Json> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const escape = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
  const equal = (left: Json, right: Json) => left === right || canonical(left) === canonical(right);

  function visit(path: string, left: Json | undefined, right: Json | undefined): void {
    if (truncated || left === right) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      // Keep unchanged items at either end out of the diff when an item shifts their indexes.
      let start = 0;
      let leftEnd = left.length;
      let rightEnd = right.length;
      while (start < leftEnd && start < rightEnd && equal(left[start]!, right[start]!)) start++;
      while (start < leftEnd && start < rightEnd && equal(left[leftEnd - 1]!, right[rightEnd - 1]!)) {
        leftEnd--;
        rightEnd--;
      }
      for (let index = start; index < Math.max(leftEnd, rightEnd) && !truncated; index++) {
        visit(path + '/' + index, index < leftEnd ? left[index] : undefined,
          index < rightEnd ? right[index] : undefined);
      }
      return;
    }
    if (isRecord(left) && isRecord(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        visit(path + '/' + escape(key), Object.hasOwn(left, key) ? left[key] : undefined,
          Object.hasOwn(right, key) ? right[key] : undefined);
      }
      return;
    }
    if (left !== undefined && right !== undefined && equal(left, right)) return;
    if (entries.length === 100) { truncated = true; return; }
    if (left === undefined) entries.push({ path, operation: 'add', after: right! });
    else if (right === undefined) entries.push({ path, operation: 'remove', before: left });
    else entries.push({ path, operation: 'replace', before: left, after: right });
  }

  visit('', before === null ? {} : clone(before), clone(after));
  return { entries, truncated };
}

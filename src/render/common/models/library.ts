/**
 * Every model spec in specs/*.json (decision 106), validated, by id. Vite bundles the
 * JSON; in dev a changed spec hot-reloads the modules that import this one.
 */
import { validateSpec } from './spec';
import type { ModelSpec } from './spec';

const files = import.meta.glob<unknown>('./specs/*.json', { eager: true, import: 'default' });

export const MODEL_SPECS: Record<string, ModelSpec> = Object.fromEntries(
  Object.entries(files)
    .map(([path, json]) => {
      const id = path.replace(/^.*\//, '').replace(/\.json$/, '');
      return [id, validateSpec(json, id)] as const;
    })
    .sort((a, b) => a[0].localeCompare(b[0])),
);

export function modelSpec(id: string): ModelSpec {
  const s = MODEL_SPECS[id];
  if (!s) throw new Error(`no model spec "${id}"`);
  return s;
}

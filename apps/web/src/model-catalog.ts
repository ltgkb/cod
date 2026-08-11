import type { ModelInfo, PublicModelSourceInfo } from './api';

export interface CatalogModelSource {
  id: string;
  label: string;
  callable: boolean;
}

export interface CatalogModelGroup {
  key: string;
  model: ModelInfo;
  sources: CatalogModelSource[];
  callable: boolean;
}

function modelPriceKey(model: ModelInfo): string {
  return [model.id, model.contextWindow, model.inputPricePerMillionCents, model.outputPricePerMillionCents].join('\u0000');
}

export function groupModelCatalog(sources: PublicModelSourceInfo[]): CatalogModelGroup[] {
  const groups = new Map<string, CatalogModelGroup>();
  for (const source of sources) {
    for (const model of source.models) {
      const key = modelPriceKey(model);
      const current = groups.get(key);
      const catalogSource = { id: source.id, label: source.label, callable: source.callable };
      if (current) {
        current.sources.push(catalogSource);
        current.callable ||= source.callable;
      } else {
        groups.set(key, { key, model, sources: [catalogSource], callable: source.callable });
      }
    }
  }
  return [...groups.values()];
}

export function filterModelCatalog(groups: CatalogModelGroup[], query: string): CatalogModelGroup[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return groups;
  return groups.filter((group) =>
    `${group.model.label} ${group.model.id} ${group.sources.map((source) => source.label).join(' ')}`.toLowerCase().includes(normalized));
}

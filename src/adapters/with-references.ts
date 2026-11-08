import type { Task } from '../domain/task';
import type { PreparationAdapter } from './mock-ai';
import type { ReferenceStore } from './reference-store';

export function withReferences(adapter: PreparationAdapter, store: Pick<ReferenceStore, 'list'>): PreparationAdapter {
  return new ReferenceAdapter(adapter, store);
}
class ReferenceAdapter implements PreparationAdapter {
  readonly breakdown: PreparationAdapter['breakdown'];
  readonly revise: PreparationAdapter['revise'];
  constructor(private readonly adapter: PreparationAdapter, private readonly store: Pick<ReferenceStore, 'list'>) {
    const breakdown = adapter.breakdown?.bind(adapter);
    this.breakdown = breakdown ? (task, steps, comment) => breakdown(task, steps, comment, this.store.list(task.id)) : undefined;
    const revise = adapter.revise?.bind(adapter);
    this.revise = revise ? (task, previous, feedback) => revise(task, previous, feedback, this.store.list(task.id)) : undefined;
  }
  generate(task: Task) { return this.adapter.generate(task, this.store.list(task.id)); }
}

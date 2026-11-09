import type { Task } from '../domain/task';
import type { AttachmentContext } from '../domain/attachment-context';
import type { PreparationAdapter } from './mock-ai';
import type { ReferenceStore } from './reference-store';

type AttachmentSource = { list(taskId: string): readonly AttachmentContext[] };

export function withReferences(adapter: PreparationAdapter, store: Pick<ReferenceStore, 'list'>, inputs?: AttachmentSource): PreparationAdapter {
  return new ReferenceAdapter(adapter, store, inputs);
}
class ReferenceAdapter implements PreparationAdapter {
  readonly breakdown: PreparationAdapter['breakdown'];
  readonly revise: PreparationAdapter['revise'];
  readonly initialBreakdown: PreparationAdapter['initialBreakdown'];
  readonly createDraft: PreparationAdapter['createDraft'];
  readonly reviseDraft: PreparationAdapter['reviseDraft'];
  constructor(private readonly adapter: PreparationAdapter, private readonly store: Pick<ReferenceStore, 'list'>, inputs?: AttachmentSource) {
    const breakdown = adapter.breakdown?.bind(adapter);
    this.breakdown = breakdown ? (task, steps, comment) => breakdown(task, steps, comment, this.store.list(task.id), inputs?.list(task.id)) : undefined;
    const revise = adapter.revise?.bind(adapter);
    this.revise = revise ? (task, previous, feedback) => revise(task, previous, feedback, this.store.list(task.id)) : undefined;
    const initialBreakdown = adapter.initialBreakdown?.bind(adapter);
    this.initialBreakdown = initialBreakdown ? task => initialBreakdown(task, this.store.list(task.id), inputs?.list(task.id)) : undefined;
    const createDraft = adapter.createDraft?.bind(adapter);
    this.createDraft = createDraft ? (task, steps) => createDraft(task, steps, this.store.list(task.id), inputs?.list(task.id)) : undefined;
    const reviseDraft = adapter.reviseDraft?.bind(adapter);
    this.reviseDraft = reviseDraft ? (task, previous, feedback, steps) => reviseDraft(task, previous, feedback, steps, this.store.list(task.id), inputs?.list(task.id)) : undefined;
  }
  generate(task: Task) { return this.adapter.generate(task, this.store.list(task.id)); }
}

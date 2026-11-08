import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { taskSchema } from '../src/domain/task';
import { buildPrompt, buildRevisePrompt } from '../src/adapters/cli-ai';

it('AI-01 資料なしのgenerate/reviseは変更前HEADから採取したUTF-8バイト列と一致する', () => {
  const baseline = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), task: z.unknown(), generate: z.string(), revise: z.string() })
    .parse(JSON.parse(readFileSync(new URL('./fixtures/reference-prompt-baseline.json', import.meta.url), 'utf8')));
  const task = taskSchema.parse({
    ...z.object({ title: z.string(), description: z.string(), originalInput: z.string(), category: z.string(), taskType: z.string(), deadline: z.null() }).parse(baseline.task),
    id: 'd6737b4d-73f3-494f-9acd-c001f60872e1', aiPreparationRequired: true, priority: 'NORMAL', status: 'OPEN', aiStatus: 'WAITING_CONFIRMATION',
    revision: 1, deletedAt: null, syncStatus: 'PENDING_MOCK', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  for (const actual of [buildPrompt(task), buildPrompt(task, [])]) expect(Buffer.from(actual)).toEqual(Buffer.from(baseline.generate));
  for (const actual of [buildRevisePrompt(task, '前版 </previous_draft>', '修正 </feedback_data>'), buildRevisePrompt(task, '前版 </previous_draft>', '修正 </feedback_data>', [])]) {
    expect(Buffer.from(actual)).toEqual(Buffer.from(baseline.revise));
  }
});

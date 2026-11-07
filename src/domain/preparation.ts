import { z } from 'zod';

export const workPlanSchema = z.object({
  objective: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  requiredInputs: z.array(z.string()),
  humanCheckpoints: z.array(z.string()),
  assumptions: z.array(z.string()),
});

export const generationSchema = z.object({
  plan: workPlanSchema,
  markdown: z.string().min(1),
  changeSummary: z.string().min(1),
});

export const preparationJobSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
  mode: z.literal('mock'), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), errorCode: z.string().nullable(),
});

export type WorkPlan = z.infer<typeof workPlanSchema>;
export type Generation = z.infer<typeof generationSchema>;
export type PreparationJob = z.infer<typeof preparationJobSchema>;

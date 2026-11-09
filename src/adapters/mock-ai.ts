import type { AttachmentContext } from '../domain/attachment-context';
import type { Reference } from '../domain/references';
import type { BreakdownGeneration } from '../domain/breakdown';
import type { Task } from '../domain/task';
import { generationSchema, type Generation } from '../domain/preparation';

export interface PreparationAdapter {
  initialBreakdown?(task: Task, context?: readonly Reference[], attachments?: readonly AttachmentContext[]): Promise<BreakdownGeneration>;
  createDraft?(task: Task, steps: string[], context?: readonly Reference[], attachments?: readonly AttachmentContext[]): Promise<Generation>;
  reviseDraft?(task: Task, previous: string, feedback: string, steps: string[], context?: readonly Reference[], attachments?: readonly AttachmentContext[]): Promise<Generation>;
  breakdown?(task: Task, steps: string[], comment: string, context?: readonly Reference[], attachments?: readonly AttachmentContext[]): Promise<BreakdownGeneration>;
  generate(task: Task, context?: readonly Reference[]): Promise<Generation>;
  revise?(task: Task, previousContent: string, feedback: string, context?: readonly Reference[]): Promise<Generation>;
}

export class MockAiAdapter implements PreparationAdapter {
  async initialBreakdown(task: Task, _context?: readonly Reference[], _attachments?: readonly AttachmentContext[]): Promise<BreakdownGeneration> {
    void task; void _context; void _attachments;
    return { steps: ['入力内容を論点に分ける', '不足情報を確認する', '案と次の手順を整理する'], mode: 'mock', fallbackReason: null };
  }

  async createDraft(task: Task, steps: string[], context: readonly Reference[] = [], attachments: readonly AttachmentContext[] = []): Promise<Generation> {
    const base = await this.generate(task);
    const resources = [
      ...context.map(item => item.kind === 'URL' ? `- ${mockHeading(item.title)} ${mockHeading(item.url)}` : `- ${mockHeading(item.title)}`),
      ...attachments.map(item => `- ${mockHeading(item.name)}（${mockHeading(item.type)}）`),
    ];
    return generationSchema.parse({ ...base,
      plan: { ...base.plan, steps: steps.length ? steps : base.plan.steps },
      markdown: [
        `# ${mockHeading(task.title)}`, '> モック生成。実AIは呼び出していません。',
        ...steps.map((step, index) => `## ${index + 1}. ${mockHeading(step)}\n\n（モック）この手順の内容は実AIでは作成していません。要確認。`),
        ...(resources.length ? ['## 参考資料', '題名・URL・ファイル名と種類のみを表示しています。本文は反映していません。添付の解析は未実行です。', ...resources] : []),
        '## 確認事項', '- 内容と事実関係を確認してください。',
      ].join('\n\n'),
      changeSummary: 'モックAIが保存済みの分解に沿ってドラフトを作成しました。',
      meta: { mode: 'mock', fallbackReason: null },
    });
  }

  async reviseDraft(task: Task, previous: string, feedback: string, steps: string[], _context?: readonly Reference[], _attachments?: readonly AttachmentContext[]): Promise<Generation> {
    void _context; void _attachments;
    const result = await this.revise(task, previous, feedback);
    return { ...result, plan: { ...result.plan, steps: steps.length ? steps : result.plan.steps }, meta: { mode: 'mock', fallbackReason: null } };
  }
  async breakdown(_task: Task, steps: string[], comment: string, _context?: readonly Reference[], _attachments?: readonly AttachmentContext[]): Promise<BreakdownGeneration> {
    void comment; void _context; void _attachments;
    return { steps, mode: 'mock', fallbackReason: null };
  }

  async generate(task: Task): Promise<Generation> {
    return generationSchema.parse({
      plan: {
        objective: task.title,
        steps: ['入力内容を論点に分ける', '不足情報を確認する', '案と次の手順を整理する'],
        requiredInputs: task.description ? [task.description] : [],
        humanCheckpoints: ['内容を確認して必要な事実を補う'],
        assumptions: ['この内容はモック生成で、外部情報を参照していません'],
      },
      markdown: `# ${task.title}\n\n> モック生成。実AIは呼び出していません。\n\n## 目的\n\n${task.description || task.originalInput || task.title}\n\n## 検討手順\n\n1. 入力内容を論点に分けます。\n2. 不足情報を確認します。\n3. 案と次の手順を整理します。\n\n## 確認事項\n\n- 内容と事実関係を確認してください。\n- 必要な情報は未確認です。\n`,
      changeSummary: 'モックAIが初版の見出しと確認項目を作成しました。',
    });
  }

  async revise(task: Task, previousContent: string, feedback: string): Promise<Generation> {
    const base = await this.generate(task);
    return generationSchema.parse({
      ...base,
      markdown: `${previousContent}\n\n---\n\n## 修正版\n\n> モック改訂。実AIは呼び出していません。\n\n### 修正指示\n\n${feedback}\n`,
      changeSummary: `モック改訂: ${feedback}`,
    });
  }
}

function mockHeading(value: string): string { return value.replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, ' ').replace(/</g, '＜').replace(/>/g, '＞'); }

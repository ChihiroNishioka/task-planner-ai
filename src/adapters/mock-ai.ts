import type { Task } from '../domain/task';
import { generationSchema, type Generation } from '../domain/preparation';

export interface PreparationAdapter {
  generate(task: Task): Promise<Generation>;
}

export class MockAiAdapter implements PreparationAdapter {
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
}

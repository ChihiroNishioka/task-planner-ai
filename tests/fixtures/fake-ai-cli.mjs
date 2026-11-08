#!/usr/bin/env node
// テスト専用の偽CLI。実AIは呼ばず、stdinを読み切って固定のJSONを返す。
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const title = /タイトル: (.*)/.exec(input)?.[1] ?? 'タスク';
  process.stdout.write(JSON.stringify({
    steps: ['目的と完了条件を1行で書く', '必要な資料を3つ洗い出す', '構成案を見出しだけで作る', '下書きを確認して不足を埋める'],
    draftMarkdown: `# ${title}\n\n## 目的\n\n（偽CLIの固定出力）要確認\n\n## 構成案\n\n1. 背景\n2. 提案\n3. 次の行動\n`,
  }));
});

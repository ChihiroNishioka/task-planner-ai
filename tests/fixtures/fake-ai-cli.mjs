#!/usr/bin/env node
// テスト専用の偽CLI。実AIは呼ばず、stdinを読み切って固定のJSONを返す。
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (input.includes('<feedback_data>')) {
    if (input.includes('FAKE_CLI_EXIT_1')) process.exit(1);
    const feedback = /<feedback_data>\n([\s\S]*?)\n<\/feedback_data>/.exec(input)?.[1] ?? '';
    process.stdout.write(JSON.stringify({
      steps: ['結論を先頭に移す', '根拠を3点に絞る'],
      draftMarkdown: `# 改訂版\n\n（偽CLIの改訂版）\n\n## 反映した指示\n\n${feedback}\n`,
    }));
    return;
  }
  const title = /タイトル: (.*)/.exec(input)?.[1] ?? 'タスク';
  if (input.includes('<breakdown_steps>')) {
    const block = /<breakdown_steps>\n([\s\S]*?)\n<\/breakdown_steps>/.exec(input)?.[1] ?? '';
    const steps = block.split('\n').filter(line => /^\d+\. /.test(line));
    process.stdout.write(JSON.stringify({ draftMarkdown: `# ${title}\n\n${steps.map(step => `## ${step}\n\n（偽CLIの固定出力）要確認`).join('\n\n')}` }));
    return;
  }
  process.stdout.write(JSON.stringify({
    steps: ['目的と完了条件を1行で書く', '必要な資料を3つ洗い出す', '構成案を見出しだけで作る', '下書きを確認して不足を埋める'],
    draftMarkdown: `# ${title}\n\n## 目的\n\n（偽CLIの固定出力）要確認\n\n## 構成案\n\n1. 背景\n2. 提案\n3. 次の行動\n`,
  }));
});

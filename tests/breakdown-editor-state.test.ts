import { expect, it } from 'vitest';
import { breakdownConflictMessage, breakdownFailureReason, nextBreakdownTracking, type BreakdownSnapshot } from '../src/domain/breakdown';

const job = (id: string, status: BreakdownSnapshot['jobs'][number]['status']): BreakdownSnapshot['jobs'][number] => ({
  id, status, taskId: 'task', inputSteps: ['依頼入力'], comment: '依頼コメント', baseVersion: null, errorCode: null, createdAt: '',
});

it('Codexmid J1取消後は取得したJ2へ引き継ぎ、既存編集を成功時も保護する', () => {
  const data = { versions: [], jobs: [job('J1', 'CANCELLED'), job('J2', 'RUNNING')] };
  expect(nextBreakdownTracking(data, { id: 'J1', revision: 1, preserveInput: false }, 2, true))
    .toEqual({ id: 'J2', revision: 2, preserveInput: true });
});

it('Codexmid 同じジョブの監視では編集前のrevisionと入力保護を維持する', () => {
  const tracked = { id: 'J2', revision: 2, preserveInput: true };
  expect(nextBreakdownTracking({ versions: [], jobs: [job('J2', 'RUNNING')] }, tracked, 3, false)).toEqual(tracked);
  expect(nextBreakdownTracking({ versions: [], jobs: [job('J2', 'SUCCEEDED')] }, tracked, 3, true)).toBeNull();
});

it('ClaudeM1 保存の版競合だけは入力保持と最新比較を案内する', () => {
  expect(breakdownConflictMessage('CONFLICT', 'save', undefined)).toEqual({
    compare: true, message: '別の変更があります。入力は保持しています。最新の版と比較し、載せ替えてから保存してください。',
  });
});

it('ClaudeM1 TASK_NOT_RUNNABLEは保存でも載せ替えを案内しない', () => {
  const result = breakdownConflictMessage('TASK_NOT_RUNNABLE', 'save', undefined);
  expect(result.compare).toBe(false);
  expect(result.message).toContain('完了・中止');
  expect(result.message).not.toContain('載せ替え');
});

it.each(['SUCCEEDED', 'FAILED'] as const)('ClaudeM1 %s済みの取消409は終端状態を説明して入力を保持する', status => {
  const result = breakdownConflictMessage('CONFLICT', 'cancel', { snapshot: { versions: [], jobs: [job('cancelled', status)] }, baseVersion: null, jobId: 'cancelled' });
  expect(result.compare).toBe(false);
  expect(result.message).toContain(status === 'SUCCEEDED' ? '成功済み' : '失敗済み');
  expect(result.message).toContain('入力は保持');
  expect(result.message).not.toContain('載せ替え');
  expect(result.message).not.toContain('ジョブ');
  expect(result.message).toContain('「最新の版を読み込む」で結果を確認できます。');
});

it('ClaudeM1 再生成409と未知のcodeは版競合に決めつけない', () => {
  for (const [code, action] of [['CONFLICT', 'regenerate'], [undefined, 'save']] as const) {
    const result = breakdownConflictMessage(code, action, undefined);
    expect(result.compare).toBe(false);
    expect(result.message).not.toContain('載せ替え');
    expect(result.message).toContain('入力は保持');
  }
});


it('G-M1-unit 古い基準版で再生成した409は進行中なしの場合だけ比較へ案内する', () => {
  const latest: BreakdownSnapshot['versions'][number] = {
    id: 'v2', taskId: 'task', number: 2, parentVersion: 'v1', kind: 'user', steps: ['最新'],
    mode: null, fallbackReason: null, label: '', comment: '', sourceVersion: null, createdAt: '',
  };
  const snapshot: BreakdownSnapshot = { versions: [latest], jobs: [] };
  const result = breakdownConflictMessage('CONFLICT', 'regenerate', { snapshot, baseVersion: 'v1' });
  expect(result.compare).toBe(true);
  for (const word of ['載せ替え', '入力', '保持']) expect(result.message).toContain(word);
  for (const status of ['QUEUED', 'RUNNING'] as const) {
    expect(breakdownConflictMessage('CONFLICT', 'regenerate', { snapshot: { ...snapshot, jobs: [job('active', status)] }, baseVersion: 'v1' }).compare).toBe(false);
  }
  expect(breakdownConflictMessage('CONFLICT', 'regenerate', { snapshot, baseVersion: 'v2' }).compare).toBe(false);
  expect(breakdownConflictMessage('TASK_NOT_RUNNABLE', 'regenerate', { snapshot, baseVersion: 'v1' }).compare).toBe(false);
});

it.each([
  ['CONFLICT', '更新'], ['WORKER_INTERRUPTED', '中断'], ['GENERATION_FAILED', '作成に失敗'], ['OTHER', '状態を確認'],
] as const)('G-L3-unit %sの理由を日本語で説明する', (code, explanation) => {
  const reason = breakdownFailureReason(code);
  expect(reason).toContain(explanation);
  expect(reason).not.toContain(code);
  if (code === 'CONFLICT') {
    expect(reason).toContain('更新');
    expect(reason).not.toContain('失敗');
  }
});


it.each(['OTHER', null])('N-06 %sの既定理由は状態確認の操作と再依頼を案内する', code => {
  expect(breakdownFailureReason(code)).toBe('AIの作り直しを完了できませんでした。「最新の版を読み込む」で状態を確認してから、もう一度依頼してください。');
});

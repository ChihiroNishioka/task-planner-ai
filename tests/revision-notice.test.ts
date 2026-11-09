import { describe, expect, it } from 'vitest';
import { fallbackGuidance, revisionModeNotice } from '../src/domain/labels';

describe('初版と改訂のモード違いの案内', () => {
  it('N1 Webがmockならworkerがcliでも改訂はモックだと事前に分かる', () => {
    const text = revisionModeNotice('mock', 'cli');
    expect(text).toContain('修正版はモック');
    expect(text).toContain('初版');
  });
  it('N2 Webがcliなら改訂はAI（失敗時はモック）。断定しない', () => {
    const text = revisionModeNotice('cli', 'cli');
    expect(text).toContain('修正版');
    expect(text).toContain('失敗時はモック');
  });
  it('N3 worker状態が不明でも改訂側のモードだけ示す', () => {
    expect(revisionModeNotice('mock', null)).toContain('修正版はモック');
  });
  it('N5 分解から作るv2以降も再作成を案内し改訂は修正指示の再送を案内する', () => {
    expect(fallbackGuidance(2, 'CREATE')).toContain('この分解でドラフトを作る');
    expect(fallbackGuidance(3, 'CREATE')).not.toContain('修正指示をもう一度送');
    expect(fallbackGuidance(1, 'REVISE')).toContain('修正指示をもう一度送');
    expect(fallbackGuidance(2, 'REVISE')).toContain('修正指示をもう一度送');
    expect(fallbackGuidance(1, null)).toBe(fallbackGuidance(1));
    expect(fallbackGuidance(2, null)).toBe(fallbackGuidance(2));
  });
  it('N4 fallbackの案内は初版再生成と修正指示の再送を区別する', () => {
    expect(fallbackGuidance(1)).toContain('この分解でドラフトを作る');
    expect(fallbackGuidance(2)).toContain('修正指示をもう一度送');
    expect(fallbackGuidance(2)).not.toContain('AIでもう一度作る');
  });
});

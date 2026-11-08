import { describe, expect, it } from 'vitest';
import { extractText } from '../src/domain/html-text';

describe('HTML tag scanning', () => {
  it('does not reinterpret a tag name ending in a hyphen as h1', () => {
    expect(extractText('<h1->本文</h1->', 'text/html', '既定題名')).toMatchObject({ title: '既定題名', body: '本文' });
  });
  it('scans a maximum-size malformed tag without backtracking', { timeout: 2000 }, () => {
    expect(extractText('<' + ' '.repeat(2_097_120) + '><p>本文</p>', 'text/html', '題名').body).toBe('本文');
  });
  it('URL-09 truncates 50001 Unicode characters to exactly 50000', () => {
    const result = extractText('😀'.repeat(50_001), 'text/plain', '題名');
    expect(result.body).toBe('😀'.repeat(50_000));
    expect(result.truncated).toBe(true);
  });
  it('ignores short whitespace-only malformed tags', () => {
    expect(extractText('<        ><p>本文</p>', 'text/html', '題名').body).toBe('本文');
  });
});

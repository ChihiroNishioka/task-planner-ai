import { describe, expect, it } from 'vitest';
import { scanText } from '../scripts/secret-scan.mjs';

describe('OPS-03 secret and personal data scan', () => {
  it('rejects a synthetic access token without returning the value', () => {
    const synthetic = ['ghp', 'Q'.repeat(36)].join('_');
    const result = scanText(`marker=${synthetic}`);
    expect(result.map((finding) => finding.kind)).toContain('token');
    expect(JSON.stringify(result)).not.toContain(synthetic);
  });

  it('rejects an email outside the example domain', () => {
    const address = ['sample.person', 'private.invalid'].join('@');
    expect(scanText(`contact: ${address}`).map((finding) => finding.kind)).toContain('email');
  });

  it('allows example.com addresses and 555 telephone examples', () => {
    expect(scanText('contact: sample@example.com phone: 202-555-0100')).toEqual([]);
  });
});

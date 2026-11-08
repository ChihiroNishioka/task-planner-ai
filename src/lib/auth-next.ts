const base = 'http://local.invalid';

/** ログイン後の戻り先を同一オリジンのパスだけに絞る。URL として解決した結果で判定する。 */
export function isSafeNextPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(value)) return '/';
  try {
    const url = new URL(value, base);
    if (url.origin !== base) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

import { referenceLimits, type ContentHint } from './references';

function entities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original: string, value: string) => {
    const named: Record<string,string> = { amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ' };
    if (!value.startsWith('#')) return named[value.toLowerCase()] ?? original;
    const code = value[1]?.toLowerCase()==='x' ? parseInt(value.slice(2),16) : parseInt(value.slice(1),10);
    return code > 0 && code <= 0x10ffff && !(code>=0xd800 && code<=0xdfff) ? String.fromCodePoint(code) : '';
  });
}
function normalizeWhitespace(text:string) { return text.replace(/[\t\r ]+/g,' ').replace(/ *\n */g,'\n').replace(/\n+/g,'\n').trim(); }
function clean(text:string) { return normalizeWhitespace(entities(text)); }
function cut(text:string,limit:number) { const chars=Array.from(text); return { text:chars.slice(0,limit).join(''),truncated:chars.length>limit }; }

export function decodeText(bytes: Uint8Array, contentType: string): string {
  const preview = new TextDecoder('windows-1252').decode(bytes.subarray(0,4096));
  const charset = /charset\s*=\s*["']?([^\s;"'>]+)/i.exec(contentType)?.[1] ?? /<meta\b[^>]*charset\s*=\s*["']?([^\s;"'>]+)/i.exec(preview)?.[1] ?? 'utf-8';
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
  const text = decoder.decode(bytes);
  if (text.includes('\0')) throw new Error('DECODE_FAILED');
  return text;
}

type BodyRange = { start: number; end: number };
type Element = {
  name: string;
  hidden: boolean;
  excluded: boolean;
  content: boolean;
  main: boolean;
  article: boolean;
  range?: BodyRange;
};
const htmlLimits = { depth: 1000, tags: 20000 };
const suppressed = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'head']);
const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const metadata = new Set(['html', 'head', 'meta', 'link', 'script', 'style', 'title', 'base', 'noscript', 'template']);
const excludedRoles = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search']);
const paywallTerms = ['この続きをみるには', '続きを読むには', '続きをお読みいただくには', '有料会員限定', '会員限定記事', 'subscribe to continue', 'subscribe to read', 'subscribers only', 'members only'];

function attributes(tag: string, offset: number): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  pattern.lastIndex = offset;
  for (let match = pattern.exec(tag); match; match = pattern.exec(tag)) {
    const name = match[1].toLowerCase();
    if (!result.has(name)) result.set(name, entities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return result;
}

function htmlContent(source: string): { title: string; firstH1: string; body: string; hintText: string; truncated: boolean } {
  const stack: Element[] = [];
  const indexes = new Map<string, number[]>();
  const parts: string[] = [];
  const allParts: string[] = [];
  const mains: BodyRange[] = [];
  const articles: BodyRange[] = [];
  const lower = source.toLowerCase();
  let nonHeadDepth = 0; let tagCount = 0; let truncated = false;
  let hiddenDepth = 0; let excludedDepth = 0; let contentDepth = 0;
  let mainDepth = 0; let articleDepth = 0; let h1Depth = 0;
  let title = ''; let ogTitle = ''; let titleSeen = false; let noTitleClosing = false;
  let firstH1 = ''; let firstH1Done = false; let bodyStarted = false;
  function append(text: string) {
    allParts.push(hiddenDepth ? '' : text);
    parts.push(hiddenDepth || excludedDepth ? '' : text);
    if (h1Depth && !firstH1Done && !hiddenDepth) firstH1 += text;
  }
  function close(index: number) {
    for (const element of stack.splice(index).reverse()) {
      indexes.get(element.name)?.pop();
      if (element.name !== 'html' && element.name !== 'head') nonHeadDepth--;
      if (element.range) element.range.end = parts.length;
      if (element.hidden) hiddenDepth--;
      if (element.excluded) excludedDepth--;
      if (element.content) contentDepth--;
      if (element.main) mainDepth--;
      if (element.article) articleDepth--;
      if (element.name === 'h1') { h1Depth--; if (!h1Depth) firstH1Done = true; }
    }
  }
  for (let i = 0; i < source.length;) {
    if (tagCount >= htmlLimits.tags) { truncated = true; break; }
    const top = stack.at(-1)?.name;
    if (top && ['script', 'style', 'noscript', 'iframe'].includes(top) && !lower.startsWith(`</${top}`, i)) {
      const closing = lower.indexOf(`</${top}`, i);
      if (closing < 0) break;
      i = closing;
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4); i = end < 0 ? source.length : end + 3; continue;
    }
    if (source[i] !== '<') {
      const end = source.indexOf('<', i); const stop = end < 0 ? source.length : end;
      append(source.slice(i, stop)); i = stop; continue;
    }
    let end = i + 1; let quote = '';
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end >= source.length) break;
    const tag = source.slice(i + 1, end); i = end + 1;
    tagCount++;
    let cursor = 0;
    while (cursor < tag.length && /\s/.test(tag[cursor])) cursor++;
    const closing = tag[cursor] === '/';
    if (closing) cursor++;
    while (cursor < tag.length && /\s/.test(tag[cursor])) cursor++;
    if (cursor === tag.length || !/[a-z]/i.test(tag[cursor])) continue;
    const start = cursor++;
    while (cursor < tag.length && /[a-z0-9_:-]/i.test(tag[cursor])) cursor++;
    const name = tag.slice(start, cursor).toLowerCase();
    if (closing) {
      const index = indexes.get(name)?.at(-1) ?? -1;
      if (index >= 0) close(index);
      if (/^(p|div|h[1-6]|li|tr|section|main|article|blockquote)$/.test(name)) append('\n');
      continue;
    }
    if (stack.length >= htmlLimits.depth) { truncated = true; break; }
    const inHead = !bodyStarted && nonHeadDepth === 0;
    if (name === 'title') {
      const closingTitle = /<\/title(?:\s|>)/gi;
      closingTitle.lastIndex = i;
      const match = noTitleClosing ? null : closingTitle.exec(source);
      if (!match) noTitleClosing = true;
      if (inHead && !titleSeen) {
        titleSeen = true;
        if (match) title = source.slice(i, match.index);
      }
      if (match) {
        const closeEnd = source.indexOf('>', match.index);
        i = closeEnd < 0 ? source.length : closeEnd + 1;
      } else {
        const next = source.indexOf('<', i);
        i = next < 0 ? source.length : next;
      }
      continue;
    }
    const attrs = attributes(tag, cursor);
    if (name === 'meta' && inHead && !ogTitle &&
      [attrs.get('property'), attrs.get('name')].some(value => value?.toLowerCase() === 'og:title')) {
      ogTitle = normalizeWhitespace(attrs.get('content') ?? '');
    }
    if (!metadata.has(name)) bodyStarted = true;
    const role = (attrs.get('role') ?? '').trim().toLowerCase();
    const hidden = suppressed.has(name) || /(?:^|\s)hidden(?:\s|=|$)/i.test(tag) || /aria-hidden\s*=\s*(?:"true"|'true'|true\b)/i.test(tag) || /display\s*:\s*none/i.test(tag);
    const excluded = name === 'nav' || name === 'aside' || excludedRoles.has(role) ||
      ((name === 'header' || name === 'footer') && contentDepth === 0);
    const main = name === 'main' || role === 'main';
    const article = name === 'article' || role === 'article';
    const content = main || article || name === 'section';
    const visible = !hiddenDepth && !excludedDepth && !hidden && !excluded;
    let range: BodyRange | undefined;
    if (visible && ((main && !mainDepth) || (article && !articleDepth))) {
      range = { start: parts.length, end: parts.length };
      if (main && !mainDepth) mains.push(range);
      if (article && !articleDepth) articles.push(range);
    }
    if (!voids.has(name) && !/\/\s*$/.test(tag)) {
      const positions = indexes.get(name) ?? [];
      positions.push(stack.length); indexes.set(name, positions);
      stack.push({ name, hidden, excluded, content, main, article, range });
      if (name !== 'html' && name !== 'head') nonHeadDepth++;
      if (hidden) hiddenDepth++;
      if (excluded) excludedDepth++;
      if (content) contentDepth++;
      if (main) mainDepth++;
      if (article) articleDepth++;
      if (name === 'h1') h1Depth++;
    }
    if (/^(br|hr|p|div|h[1-6]|li|section|main|article|blockquote)$/.test(name)) append('\n');
  }
  close(0);
  const hintText = clean(parts.join(''));
  const candidates = (ranges: BodyRange[]) => ranges.map(range => clean(parts.slice(range.start, range.end).join('')));
  function longest(values: string[]): string {
    let best = ''; let bestLength = 0;
    for (const text of values) {
      const length = Array.from(text).length;
      if (length > bestLength) { best = text; bestLength = length; }
    }
    return best;
  }
  let body = '';
  if (mains.length) body = longest(candidates(mains));
  else if (articles.length) {
    const values = candidates(articles);
    const best = longest(values);
    body = Array.from(best).length * 2 >= values.reduce((sum, text) => sum + Array.from(text).length, 0) ? best : values.join('\n');
  }
  return { title: clean(title) || ogTitle, firstH1: clean(firstH1), body: body || hintText || clean(allParts.join('')), hintText, truncated };
}

export function extractText(source: string, contentType: string, fallbackTitle: string) {
  const html = contentType === 'text/plain' ? null : htmlContent(source);
  const resultBody = cut(html ? html.body : clean(source.trim()), referenceLimits.body);
  const resultTitle = cut(html?.title || html?.firstH1 || fallbackTitle, referenceLimits.title);
  const truncated = resultBody.truncated || !!html?.truncated;
  const length = Array.from(resultBody.text).length;
  let contentHint: ContentHint | null = null;
  if (html && !truncated) {
    if (length < 2000 && paywallTerms.some(term => html.hintText.toLowerCase().includes(term))) contentHint = 'PAYWALL_HINT';
    else if (length < 600) contentHint = 'SHORT_BODY';
  }
  return { title: resultTitle.text, body: resultBody.text, truncated, contentHint };
}

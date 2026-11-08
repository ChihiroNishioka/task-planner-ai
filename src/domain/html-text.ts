import { referenceLimits } from './references';

function entities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original: string, value: string) => {
    const named: Record<string,string> = { amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ' };
    if (!value.startsWith('#')) return named[value.toLowerCase()] ?? original;
    const code = value[1]?.toLowerCase()==='x' ? parseInt(value.slice(2),16) : parseInt(value.slice(1),10);
    return code > 0 && code <= 0x10ffff && !(code>=0xd800 && code<=0xdfff) ? String.fromCodePoint(code) : '';
  });
}
function clean(text:string) { return entities(text).replace(/[\t\r ]+/g,' ').replace(/ *\n */g,'\n').replace(/\n+/g,'\n').trim(); }
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

export function extractText(source: string, contentType: string, fallbackTitle: string) {
  let title = ''; let firstH1 = ''; let body = '';
  if (contentType === 'text/plain') body = source.trim();
  else {
    const stack: {name:string;hidden:boolean}[]=[];
    const lowerSource=source.toLowerCase();
    const indexes=new Map<string,number[]>();
    const suppressed = new Set(['script','style','noscript','template','svg','iframe','head']);
    const voids = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
    let hiddenDepth=0; let titleDepth=0; let h1Depth=0; let firstH1Done=false;
    for(let i=0;i<source.length;) {
      const top=stack.at(-1)?.name;
      if(top && ['script','style','noscript','iframe'].includes(top) && !lowerSource.startsWith(`</${top}`,i)) {
        const closing=lowerSource.indexOf(`</${top}`,i);
        if(closing<0)break;
        i=closing;
      }
      if(source.startsWith('<!--',i)) {const end=source.indexOf('-->',i+4);i=end<0?source.length:end+3;continue;}
      if(source[i]!=='<') {const end=source.indexOf('<',i);const stop=end<0?source.length:end;const text=source.slice(i,stop);if(titleDepth)title+=text; if(h1Depth && !firstH1Done && !hiddenDepth)firstH1+=text;if(!hiddenDepth)body+=text;i=stop;continue;}
      let end=i+1;let quote='';
      for(;end<source.length;end++){const c=source[end];if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;}
      if(end>=source.length)break;
      const tag=source.slice(i+1,end);i=end+1;
      let cursor=0;
      while(cursor<tag.length && /\s/.test(tag[cursor]))cursor++;
      const closing=tag[cursor]==='/';
      if(closing)cursor++;
      while(cursor<tag.length && /\s/.test(tag[cursor]))cursor++;
      if(cursor===tag.length || !/[a-z]/i.test(tag[cursor]))continue;
      const start=cursor++;
      while(cursor<tag.length && /[a-z0-9_:-]/i.test(tag[cursor]))cursor++;
      const name=tag.slice(start,cursor).toLowerCase();
      if(closing) {
        const index=indexes.get(name)?.at(-1)??-1;
        if(index>=0){for(const item of stack.splice(index)){indexes.get(item.name)?.pop();if(item.hidden)hiddenDepth--;if(item.name==='title')titleDepth--;if(item.name==='h1'){h1Depth--;if(!h1Depth)firstH1Done=true;}}}
        if(!hiddenDepth && /^(p|div|h[1-6]|li|tr|section|article|blockquote)$/.test(name))body+='\n';
      } else {
        const hidden=suppressed.has(name)||/(?:^|\s)hidden(?:\s|=|$)/i.test(tag)||/aria-hidden\s*=\s*(?:"true"|'true'|true\b)/i.test(tag)||/display\s*:\s*none/i.test(tag);
        if(!voids.has(name) && !/\/\s*$/.test(tag)) {const positions=indexes.get(name)??[];positions.push(stack.length);indexes.set(name,positions);stack.push({name,hidden});if(hidden)hiddenDepth++;if(name==='title')titleDepth++;if(name==='h1')h1Depth++;}
        if(!hiddenDepth && /^(br|hr|p|div|h[1-6]|li|section|article|blockquote)$/.test(name))body+='\n';
      }
    }
  }
  const resultBody=cut(clean(body),referenceLimits.body);const resultTitle=cut(clean(title)||clean(firstH1)||fallbackTitle,referenceLimits.title);
  return {title:resultTitle.text,body:resultBody.text,truncated:resultBody.truncated||resultTitle.truncated};
}

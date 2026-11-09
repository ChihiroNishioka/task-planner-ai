import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDohResolver, parseReferenceDnsConfig } from '../src/adapters/reference-doh';
import { createReferenceFetcherFromEnv, fetchReference, type DialTarget } from '../src/adapters/reference-fetcher';
const forbidden=vi.hoisted(()=>vi.fn(()=>{throw new Error('外部接続禁止');}));
vi.mock('node:net',async original=>({...await original<typeof import('node:net')>(),connect:forbidden}));
vi.mock('node:tls',async original=>({...await original<typeof import('node:tls')>(),connect:forbidden}));
vi.mock('node:dns/promises',()=>({Resolver:class{constructor(){forbidden();}}}));
afterEach(()=>{expect(forbidden).not.toHaveBeenCalled();forbidden.mockClear();vi.useRealTimers();});
function reply(body:string, status=200,headers:Record<string,string>={},capture?:(text:string)=>void){let sent=false;return new Duplex({read(){},write(chunk,_encoding,done){capture?.(String(chunk));if(!sent){sent=true;queueMicrotask(()=>{this.push(`HTTP/1.1 ${status} Result\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${Object.entries({'Content-Type':'application/dns-json',...headers}).map(([k,v])=>`${k}: ${v}\r\n`).join('')}\r\n${body}`);this.push(null);});}done();}});}
const cfg={mode:'doh',url:new URL('https://dns.google/resolve'),ips:['8.8.8.8','8.8.4.4']} satisfies Parameters<typeof createDohResolver>[0];
const signal=()=>new AbortController().signal;
const success=(type:number)=>JSON.stringify({Status:0,Answer:[{type,data:type===1?'93.184.215.14':'2606:4700:4700::1111'}]});
function resolverFor(body:(type:number)=>string,headers={},status=200){return createDohResolver(cfg,()=>reply(body(1),status,headers));}
describe('公開DNS設定',()=>{
 it('UF-CFG-01 system remains default',()=>expect(parseReferenceDnsConfig({})).toEqual({mode:'system'}));
 it('UF-CFG-02 uses explicit DoH defaults',()=>expect(parseReferenceDnsConfig({REFERENCE_DNS_MODE:'doh'})).toEqual(cfg));
 it.each(['DOH','','x'])('UF-CFG-03 rejects mode %j without value echo',value=>{expect(()=>parseReferenceDnsConfig({REFERENCE_DNS_MODE:value})).toThrow();});
 it.each(['http://dns.example.com/resolve','https://a:b@example.com/resolve','https://dns.example.com/resolve?q=x','https://dns.example.com/resolve#x','https://dns.example.com:8443/resolve','https://8.8.8.8/resolve','https://dns.example.com/','https://dns.internal/resolve'])('UF-CFG-04 rejects DoH URL %s',url=>expect(()=>parseReferenceDnsConfig({REFERENCE_DNS_MODE:'doh',REFERENCE_DOH_URL:url,REFERENCE_DOH_IPS:'8.8.8.8'})).toThrow());
 it.each(['10.0.0.2','198.18.0.1','::1','x','8.8.8.8,','8.8.8.8, 8.8.4.4','8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1,9.9.9.9'])('UF-CFG-05 rejects DoH IP list %s',ips=>expect(()=>parseReferenceDnsConfig({REFERENCE_DNS_MODE:'doh',REFERENCE_DOH_IPS:ips})).toThrow());
 it('UF-CFG-06 custom server requires pinned IPs',()=>expect(()=>parseReferenceDnsConfig({REFERENCE_DNS_MODE:'doh',REFERENCE_DOH_URL:'https://dns.example.com/query'})).toThrow());
 it.each(['fixture','off'])('UF-CFG-07/08 validates DoH even in %s',mode=>expect(()=>createReferenceFetcherFromEnv({REFERENCE_FETCH_MODE:mode,REFERENCE_DNS_MODE:'doh',REFERENCE_DOH_IPS:'x'})).toThrow());
 it('UF-CFG-07/08 valid off and fixture do not construct network resolver',async()=>{expect(createReferenceFetcherFromEnv({REFERENCE_FETCH_MODE:'fixture',REFERENCE_DNS_MODE:'doh'}).mode).toBe('fixture');expect(await createReferenceFetcherFromEnv({REFERENCE_FETCH_MODE:'off',REFERENCE_DNS_MODE:'doh'}).fetch('https://example.com')).toEqual({ok:false,code:'FETCH_DISABLED'});});
});
describe('DoH resolver',()=>{
 it('UF-DOH-01/02/03/04 queries both families with pinned authenticated transport and hostname only',async()=>{const requests:string[]=[];const targets:DialTarget[]=[];const resolve=createDohResolver(cfg,target=>{targets.push(target);return reply(success(targets.length===1?1:28),200,{},text=>requests.push(text));});expect(await resolve('example.com',signal())).toEqual(['93.184.215.14','2606:4700:4700::1111']);expect(targets).toHaveLength(2);for(const target of targets)expect(target).toMatchObject({ip:'8.8.8.8',host:'8.8.8.8',servername:'dns.google',verifyHostname:'dns.google',rejectUnauthorized:true,tls:true});expect(requests.join('')).toContain('name=example.com&type=A');expect(requests.join('')).toContain('type=AAAA');for(const request of requests){expect(request).toContain('Accept: application/dns-json');expect(request).toContain('Accept-Encoding: identity');expect(request).toContain('User-Agent: TaskPlannerAI/1.0');expect(request).not.toMatch(/cookie|authorization/i);}});
 it('UF-DOH-05 ignores CNAME while accepting address records',async()=>{const resolve=resolverFor(()=>JSON.stringify({Status:0,Answer:[{type:5,data:'alias.example.com'},{type:1,data:'93.184.215.14'}]}));expect(await resolve('example.com',signal())).toEqual(['93.184.215.14']);});
 it.each([{Status:0,Answer:[{type:5,data:'alias.example.com'}]},{Status:3}])('UF-DOH-06/07 absent families become DNS_NOT_FOUND %j',async body=>{await expect(resolverFor(()=>JSON.stringify(body))('example.com',signal())).rejects.toMatchObject({code:'DNS_FAILED',reason:'DNS_NOT_FOUND'});});
 it('UF-DOH-08 fails closed on one failed family',async()=>{let calls=0;const resolve=createDohResolver(cfg,()=>reply(++calls===1?success(1):'{"Status":2}'));await expect(resolve('example.com',signal())).rejects.toMatchObject({reason:'DNS_UNAVAILABLE'});});
 it('UF-DOH-09 retries the next pinned server',async()=>{const targets:string[]=[];const resolve=createDohResolver(cfg,target=>{targets.push(target.ip);if(target.ip==='8.8.8.8')throw new Error('TLS');return reply(success(1));});expect(await resolve('example.com',signal())).toEqual(['93.184.215.14']);expect(targets).toContain('8.8.4.4');});
 it('UF-DOH-10 / UF-SSRF-17 never falls back after TLS failure',async()=>{const resolve=createDohResolver(cfg,()=>{throw new Error('certificate mismatch');});await expect(resolve('example.com',signal())).rejects.toMatchObject({reason:'DNS_UNAVAILABLE'});});
 it('UF-DOH-11 bounds a silent resolver at 4000ms',async()=>{vi.useFakeTimers();const resolve=createDohResolver(cfg,()=>new Duplex({read(){},write(_chunk,_encoding,done){done();}}));const pending=resolve('example.com',signal());const rejected=expect(pending).rejects.toMatchObject({reason:'DNS_UNAVAILABLE'});await vi.advanceTimersByTimeAsync(4000);await rejected;});
 it('UF-DOH-12 retains whole request TIMEOUT',async()=>{vi.useFakeTimers();const resolve=createDohResolver(cfg,()=>new Duplex({read(){},write(_chunk,_encoding,done){done();}}));const pending=fetchReference('https://example.com',{resolve,timeoutMs:100});await vi.advanceTimersByTimeAsync(100);expect(await pending).toEqual({ok:false,code:'TIMEOUT'});});
 it.each(['not json','{}','{"Status":0,"Answer":{}}','{"Status":0,"Answer":[{"type":1,"data":"x"}]}','{"Status":0,"Answer":[{"type":1,"data":"010.0.0.1"}]}','{"Status":0,"Answer":[{"type":28,"data":"fe80::1%eth0"}]}','{"Status":0,"Answer":[{"type":1,"data":"::1"}]}'])('UF-SSRF-15 rejects malformed DNS %s',async body=>{await expect(resolverFor(()=>body)('example.com',signal())).rejects.toMatchObject({reason:'DNS_UNAVAILABLE'});});
 it.each([['x'.repeat(65537),200,{}],['{"Status":0,"TC":true}',200,{}],['{}',302,{}],['{}',500,{}],['{}',200,{'Content-Type':'text/html'}],['{}',200,{'Content-Encoding':'gzip'}],['{}',200,{'Content-Length':'65537'}]])('UF-SSRF-16 rejects transport row %#',async(body,status,headers)=>{await expect(resolverFor(()=>body,headers,status)('example.com',signal())).rejects.toMatchObject({reason:'DNS_UNAVAILABLE'});});
 it.each(['10.0.0.1','198.18.0.1','::1','::ffff:127.0.0.1'])('UF-SSRF-12/13 DoH results retain whole-address rejection %s',async ip=>{const resolve=resolverFor(()=>JSON.stringify({Status:0,Answer:[{type:1,data:'93.184.215.14'},{type:ip.includes(':')?28:1,data:ip}]}));const dial=vi.fn(()=>reply('article',200,{'Content-Type':'text/plain'}));expect(await fetchReference('https://example.com',{resolve,dial})).toEqual({ok:false,code:'BLOCKED_URL',reason:'BLOCKED_ADDRESS'});expect(dial).not.toHaveBeenCalled();});
 it('UF-SSRF-14/18 redirects resolve again and pin destination TLS',async()=>{const names:string[]=[];const resolve=createDohResolver(cfg,()=>reply(success(1),200,{},text=>{const match=/name=([^&]+)/.exec(text);if(match)names.push(match[1]);}));let calls=0;const dial=vi.fn<(target:DialTarget,signal:AbortSignal)=>Duplex>(()=>++calls===1?reply('',302,{Location:'https://other.example.com/'}):reply('本文',200,{'Content-Type':'text/plain'}));expect(await fetchReference('https://example.com',{resolve,dial})).toMatchObject({ok:true});expect(names).toContain('other.example.com');expect(dial.mock.calls[1]).toEqual([expect.objectContaining({ip:'93.184.215.14',servername:'other.example.com',verifyHostname:'other.example.com',rejectUnauthorized:true}),expect.any(AbortSignal)]);});
});


it('C03 Content-Lengthなしの分割した有効JSONも受信中64KiBで拒否しsocketを破棄する', async () => {
  const sockets: Duplex[] = [];
  const resolve = createDohResolver(cfg, () => {
    let sent = false;
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        if (!sent) {
          sent = true;
          queueMicrotask(() => {
            this.push('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/dns-json\r\n\r\n');
            this.push(success(1));
            setImmediate(() => {
              this.push(' '.repeat(32768));
              setImmediate(() => {
                this.push(' '.repeat(32768));
                this.push(null);
              });
            });
          });
        }
        done();
      },
    });
    sockets.push(socket);
    return socket;
  });
  await expect(resolve('example.com', signal())).rejects.toMatchObject({ code: 'DNS_FAILED', reason: 'DNS_UNAVAILABLE' });
  expect(sockets.length).toBeGreaterThan(0);
  expect(sockets.every(socket => socket.destroyed)).toBe(true);
});

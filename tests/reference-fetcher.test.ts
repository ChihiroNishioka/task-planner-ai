import { Duplex } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchReference, createReferenceFetcherFromEnv, resolveAll, type DialTarget } from '../src/adapters/reference-fetcher';
import { isBlockedAddress } from '../src/domain/url-policy';

const defaultIo = vi.hoisted(() => vi.fn(() => { throw new Error('Default network path is forbidden in tests'); }));
vi.mock('node:http', async importOriginal => {
  const original = await importOriginal<typeof import('node:http')>();
  return { ...original, request: (options: import('node:http').RequestOptions, listener?: (response: import('node:http').IncomingMessage) => void) => {
    if (typeof options.createConnection !== 'function') defaultIo();
    return original.request(options, listener);
  } };
});
vi.mock('node:net', async importOriginal => ({ ...await importOriginal<typeof import('node:net')>(), connect: defaultIo }));
vi.mock('node:tls', async importOriginal => ({ ...await importOriginal<typeof import('node:tls')>(), connect: defaultIo }));
vi.mock('node:dns/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:dns/promises')>(),
  Resolver: class { constructor() { defaultIo(); } },
}));
afterEach(() => { expect(defaultIo).not.toHaveBeenCalled(); defaultIo.mockClear(); });

function socket(body: string | Buffer, headers: Record<string, string> = {}, status = 200) {
  let sent = false;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Duplex({ read() {}, write(_chunk, _encoding, done) {
    if (!sent) { sent = true; queueMicrotask(() => {
      this.push(Buffer.from(`HTTP/1.1 ${status} Result\r\nConnection: close\r\nContent-Length: ${payload.length}\r\n${Object.entries({ 'Content-Type': 'text/html; charset=utf-8', ...headers }).map(([k,v]) => `${k}: ${v}\r\n`).join('')}\r\n`));
      this.push(payload); this.push(null);
    }); } done();
  } });
}
const resolve = vi.fn(async () => ['93.184.215.14']);
const options = (body = '<title>題名</title><p>本文</p>', headers = {}) => ({ resolve, dial: vi.fn<(target:DialTarget,signal:AbortSignal)=>Duplex>(() => socket(body, headers)) });

describe('reference fetcher', () => {
  it('URL-01 extracts visible text and title', async () => {
    const result = await fetchReference('https://example.com/', options('<head><title>題名</title></head><script>bad1</script><div hidden>bad2</div><p aria-hidden="true">bad3</p><span style="display: none">bad4</span><h1>見出し</h1><p>本文 &amp; 参考</p>'));
    expect(result).toMatchObject({ ok: true, title: '題名', body: '見出し\n本文 & 参考' });
  });
  it('URL-01 ignores misleading markup inside script',async()=>expect(await fetchReference('http://example.com',options('<div><script>const x="</div>"; hiddenScript()</script><p>本文</p></div>'))).toMatchObject({ok:true,body:'本文'}));
  it.each(['127.1', '2130706433', '0x7f.0.0.1', '0177.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', 'localhost', 'LOCALHOST.', 'x.localhost', 'x.internal', 'metadata.google.internal', 'x.ts.net', 'intranet', '169.254.169.254', '100.100.100.200', '168.63.129.16', '[fd00:ec2::254]'])('SSRF rejects %s without dial', async host => {
    const opts = options(); await expect(fetchReference(`http://${host}/`, opts)).resolves.toEqual({ ok:false, code:'BLOCKED_URL' }); expect(opts.dial).not.toHaveBeenCalled();
  });
  it.each(['0.0.0.0','10.255.255.255','100.64.0.0','100.127.255.255','127.255.255.255','169.254.0.0','172.16.0.0','172.31.255.255','192.0.0.0','192.0.2.1','192.88.99.1','192.168.0.1','198.18.0.0','198.19.255.255','198.51.100.1','203.0.113.1','224.0.0.0','255.255.255.255','::','::1','fc00::1','fe80::1','ff00::1','2001::1','2001:2::1','2001:10::1','2001:20::1','2001:db8::1','2002::1','3fff::1'])('SSRF-01 blocks %s', ip => expect(isBlockedAddress(ip)).toBe(true));
  it.each(['9.255.255.255','11.0.0.0','100.63.255.255','100.128.0.0','172.15.255.255','172.32.0.0','198.17.255.255','198.20.0.0','223.255.255.255','2001:4860:4860::8888','2606:4700:4700::1111'])('SSRF-01 allows %s', ip => expect(isBlockedAddress(ip)).toBe(false));
  it.each([
    ['1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',true],['2000::',false],['3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',false],['4000::',true],
    ['2001::',true],['2001:0:ffff:ffff:ffff:ffff:ffff:ffff',true],['2001:1::',false],
    ['2001:2::',true],['2001:2:0:ffff:ffff:ffff:ffff:ffff',true],['2001:2:1::',false],
    ['2001:f:ffff:ffff:ffff:ffff:ffff:ffff',false],['2001:10::',true],['2001:1f:ffff:ffff:ffff:ffff:ffff:ffff',true],
    ['2001:20::',true],['2001:2f:ffff:ffff:ffff:ffff:ffff:ffff',true],['2001:30::',false],
    ['2001:db7:ffff:ffff:ffff:ffff:ffff:ffff',false],['2001:db8::',true],['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff',true],['2001:db9::',false],
    ['2002::',true],['2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff',true],['2003::',false],
    ['3fff::',true],['3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff',true],['3fff:1000::',false],
  ])('SSRF-01 IPv6 boundary %s => %s',(ip,blocked)=>expect(isBlockedAddress(ip)).toBe(blocked));
  it('SSRF-05 rejects a mixed DNS result', async () => { const opts = {...options(),resolve:async()=>['93.184.215.14','127.0.0.1']}; expect(await fetchReference('http://example.com',opts)).toEqual({ok:false,code:'BLOCKED_URL'}); expect(opts.dial).not.toHaveBeenCalled(); });
  it('SSRF-06 rejects empty DNS', async()=>expect(await fetchReference('http://example.com',{...options(),resolve:async()=>[]})).toEqual({ok:false,code:'DNS_FAILED'}));
  it('DNS fails closed when one family has transient failure', async()=> {
    const resolver = { resolve4: async()=>['93.184.215.14'], resolve6: async()=>{throw Object.assign(new Error('dns'),{code:'ETIMEOUT'});}, cancel: vi.fn() };
    await expect(resolveAll('example.com',new AbortController().signal,resolver)).rejects.toThrow();
  });
  it('DNS permits absent AAAA only', async()=>expect(await resolveAll('example.com',new AbortController().signal,{resolve4:async()=>['93.184.215.14'],resolve6:async()=>{throw Object.assign(new Error('none'),{code:'ENODATA'});},cancel:vi.fn()})).toEqual(['93.184.215.14']));
  it('SSRF-PIN-01/03 pins IP and preserves TLS verification hostname', async()=>{
    const opts={...options(),resolve:vi.fn(async()=>['93.184.215.14'])}; await fetchReference('https://example.com/a',opts); expect(opts.resolve).toHaveBeenCalledTimes(1); expect(opts.dial).toHaveBeenCalledWith(expect.objectContaining({ip:'93.184.215.14',host:'93.184.215.14',servername:'example.com',rejectUnauthorized:true,tls:true}),expect.any(AbortSignal));
  });
  it('SSRF-PIN-04 IP literals omit servername', async()=>{const opts=options();await fetchReference('https://93.184.215.14/',opts);const target: DialTarget | undefined=opts.dial.mock.calls[0]?.[0];expect(target).not.toHaveProperty('servername');});
  it.each(['http://example.com:22','http://example.com:6379','http://example.com:8080','ftp://example.com','http://a:b@example.com'])('rejects port/protocol/userinfo %s',async url=>expect(await fetchReference(url,options())).toEqual({ok:false,code:'BLOCKED_URL'}));
  it('redirect revalidates DNS and never dials blocked result',async()=>{const dial=vi.fn(()=>socket('',{Location:'http://other.example/'},302));expect(await fetchReference('http://example.com',{resolve:async host=>host==='example.com'?['93.184.215.14']:['10.0.0.1'],dial})).toEqual({ok:false,code:'BLOCKED_URL'});expect(dial).toHaveBeenCalledTimes(1);});
  it('redirect stops after 5',async()=>{const dial=vi.fn(()=>socket('',{Location:'/'},302));expect(await fetchReference('http://example.com',{resolve,dial})).toEqual({ok:false,code:'TOO_MANY_REDIRECTS'});expect(dial).toHaveBeenCalledTimes(6);});
  it('URL-05 exact byte limit succeeds, overflow fails',async()=>{
    expect(await fetchReference('http://example.com',options('x'.repeat(2_097_152),{'Content-Type':'text/plain'}))).toMatchObject({ok:true,truncated:true});
    expect(await fetchReference('http://example.com',options('x'.repeat(2_097_153),{'Content-Type':'text/plain'}))).toEqual({ok:false,code:'TOO_LARGE'});
  });
  it('URL-06 expanded gzip limited',async()=>expect(await fetchReference('http://example.com',{resolve,dial:()=>socket(gzipSync('x'.repeat(2_097_153)),{'Content-Encoding':'gzip','Content-Type':'text/plain'})})).toEqual({ok:false,code:'TOO_LARGE'}));
  it.each(['application/pdf','application/json',''])('URL-08 rejects %s',async type=>expect(await fetchReference('http://example.com',options('body',{'Content-Type':type}))).toEqual({ok:false,code:'UNSUPPORTED_TYPE'}));
  it('URL-07 whole deadline covers unresolved DNS',async()=>expect(await fetchReference('http://example.com',{...options(),resolve:()=>new Promise(()=>{}),timeoutMs:10})).toEqual({ok:false,code:'TIMEOUT'}));
  it.each([
    ['shift_jis', Buffer.from([0x83,0x65,0x83,0x58,0x83,0x67])],
    ['euc-jp', Buffer.from([0xa5,0xc6,0xa5,0xb9,0xa5,0xc8])],
    ['utf-8', Buffer.from('テスト')],
  ])('URL-02 decodes %s',async(charset,body)=>expect(await fetchReference('http://example.com',{resolve,dial:()=>socket(body,{'Content-Type':`text/plain; charset=${charset}`})})).toMatchObject({ok:true,body:'テスト'}));
  it('URL-02 decodes meta charset and h1 fallback',async()=>expect(await fetchReference('http://example.com',{resolve,dial:()=>socket(Buffer.concat([Buffer.from('<meta charset="shift_jis"><h1>'),Buffer.from([0x83,0x65,0x83,0x58,0x83,0x67]),Buffer.from('</h1>')]),{'Content-Type':'text/html'})})).toMatchObject({ok:true,title:'テスト',body:'テスト'}));
  it('URL-07 whole deadline covers slow response',async()=>expect(await fetchReference('http://example.com',{resolve,dial:()=>new Duplex({read(){},write(_chunk,_encoding,done){done();}}),timeoutMs:10})).toEqual({ok:false,code:'TIMEOUT'}));
  it('SSRF-RD-03 permits exactly five redirects',async()=>{let hops=0;const dial=vi.fn(()=>++hops<=5?socket('',{Location:`/hop${hops}`},302):socket('<p>success</p>'));expect(await fetchReference('http://example.com',{resolve,dial})).toMatchObject({ok:true,body:'success'});expect(dial).toHaveBeenCalledTimes(6);});
  it.each(['http://127.0.0.1/','http://localhost/','ftp://example.com/','http://a:b@example.com/'])('SSRF-RD-01 revalidates redirect %s',async location=>{const dial=vi.fn(()=>socket('',{Location:location},302));expect(await fetchReference('http://example.com',{resolve,dial})).toEqual({ok:false,code:'BLOCKED_URL'});expect(dial).toHaveBeenCalledTimes(1);});
  it('SSRF-03 rejects host before resolving',async()=>{const opts={...options(),resolve:vi.fn(async()=>['93.184.215.14'])};await fetchReference('http://x.internal/',opts);expect(opts.resolve).not.toHaveBeenCalled();});
  it('URL-05 rejects declared oversize without reading body',async()=>{
    let payloadRead=false;
    const dial=()=>{let sent=false;return new Duplex({read(){},write(_chunk,_encoding,done){if(!sent){sent=true;queueMicrotask(()=>{this.push('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2097153\r\nConnection: close\r\n\r\n');setTimeout(()=>{if(!this.destroyed){payloadRead=true;this.push('body');}},5);});}done();}});};
    expect(await fetchReference('http://example.com',{resolve,dial})).toEqual({ok:false,code:'TOO_LARGE'});expect(payloadRead).toBe(false);
  });
  it('URL-05 bounds streaming bytes without Content-Length', async () => {
    let closed = false;
    const dial = () => {
      let sent = false;
      const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) {
        if (!sent) {
          sent = true;
          queueMicrotask(() => {
            this.push('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n');
            this.push(Buffer.alloc(1_048_576, 'x'));
            this.push(Buffer.alloc(1_048_576, 'x'));
            this.push('x');
            this.push(null);
          });
        }
        done();
      }, destroy(error, done) { closed = true; done(error); } });
      return stream;
    };
    expect(await fetchReference('http://example.com', { resolve, dial })).toEqual({ ok: false, code: 'TOO_LARGE' });
    expect(closed).toBe(true);
  });
  it('URL-07 trickling data cannot renew the whole deadline', async () => {
    vi.useFakeTimers();
    let chunks = 0;
    let closed = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const dial = (_target: DialTarget, signal: AbortSignal) => {
      let sent = false;
      const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) {
        if (!sent) {
          sent = true;
          this.push('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n');
          interval = setInterval(() => { chunks++; this.push('x'); }, 5);
        }
        done();
      }, destroy(error, done) { closed = true; clearInterval(interval); done(error); } });
      signal.addEventListener('abort', () => stream.destroy(), { once: true });
      return stream;
    };
    try {
      const result = fetchReference('http://example.com', { resolve, dial, timeoutMs: 25 });
      await vi.advanceTimersByTimeAsync(25);
      expect(await result).toEqual({ ok: false, code: 'TIMEOUT' });
      expect(chunks).toBeGreaterThan(1);
      expect(closed).toBe(true);
    } finally { clearInterval(interval); vi.useRealTimers(); }
  });
  it('SSRF-ERR-01 returns only a fixed error code when transport errors contain internal details', async () => {
    const dial = () => { throw new Error('synthetic-internal.example.com 10.0.0.1'); };
    expect(await fetchReference('http://example.com', { resolve, dial })).toEqual({ ok: false, code: 'NETWORK_ERROR' });
  });
  it('fixture refuses production',()=>expect(()=>createReferenceFetcherFromEnv({NODE_ENV:'production',REFERENCE_FETCH_MODE:'fixture'})).toThrow());
  it('off never dials',async()=>expect(await createReferenceFetcherFromEnv({REFERENCE_FETCH_MODE:'off'}).fetch('http://example.com')).toEqual({ok:false,code:'FETCH_DISABLED'}));
});

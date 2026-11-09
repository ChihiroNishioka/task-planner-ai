import { Duplex } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultDial, fetchReference } from '../src/adapters/reference-fetcher';
const connections=vi.hoisted(()=>({tls:vi.fn(),net:vi.fn()}));
vi.mock('node:tls',async original=>({...await original<typeof import('node:tls')>(),connect:connections.tls}));
vi.mock('node:net',async original=>({...await original<typeof import('node:net')>(),connect:connections.net}));
afterEach(()=>{vi.useRealTimers();connections.tls.mockReset();connections.net.mockReset();});
it.each([
  ['dns.google', '8.8.8.8'],
  ['example.com', '93.184.215.14'],
])('UF-TLS-01 validates original-host, alternate-host and IP SAN certificates for %s', (host, ip) => {
  connections.tls.mockImplementation(() => new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } }));
  const socket = defaultDial({ ip, host: ip, port: 443, tls: true, servername: host, verifyHostname: host, rejectUnauthorized: true }, new AbortController().signal);
  try {
    const config: import('node:tls').ConnectionOptions = connections.tls.mock.calls[0][0];
    expect(config).toMatchObject({ host: ip, servername: host, rejectUnauthorized: true });
    expect(config.checkServerIdentity).toBeTypeOf('function');
    const certificate: import('node:tls').PeerCertificate = {
      ca: false, raw: Buffer.alloc(0), subject: {}, issuer: {}, valid_from: '', valid_to: '',
      serialNumber: '', fingerprint: '', fingerprint256: '', fingerprint512: '',
    };
    expect(config.checkServerIdentity?.(ip, { ...certificate, subjectaltname: `DNS:${host}` })).toBeUndefined();
    expect(config.checkServerIdentity?.(ip, { ...certificate, subjectaltname: 'DNS:wrong.example.com' })).toBeInstanceOf(Error);
    expect(config.checkServerIdentity?.(ip, { ...certificate, subjectaltname: `IP Address:${ip}` })).toBeInstanceOf(Error);
  } finally {
    socket.destroy();
  }
});
it.each([false,true])('UF-TIME-05 destroys stalled connection and attempts next IP tls=%s',async tls=>{vi.useFakeTimers();const sockets:Duplex[]=[];const connect=()=>{const socket=new Duplex({read(){},write(_c,_e,done){done();}});sockets.push(socket);return socket;};connections.tls.mockImplementation(connect);connections.net.mockImplementation(connect);const pending=fetchReference(`${tls?'https':'http'}://example.com`,{resolve:async()=>['93.184.215.14','93.184.215.15']});await vi.advanceTimersByTimeAsync(4999);expect(sockets).toHaveLength(1);expect(sockets[0].destroyed).toBe(false);await vi.advanceTimersByTimeAsync(1);expect(sockets[0].destroyed).toBe(true);expect(sockets).toHaveLength(2);await vi.advanceTimersByTimeAsync(5000);expect(await pending).toEqual({ok:false,code:'NETWORK_ERROR'});});

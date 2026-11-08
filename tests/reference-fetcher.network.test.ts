import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchReference, type DialTarget, type Resolve } from '../src/adapters/reference-fetcher';

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

async function localServer(port: 3357 | 3358, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
}

async function localDial(portFor: (target: DialTarget) => 3357 | 3358) {
  const { connect } = await vi.importActual<typeof import('node:net')>('node:net');
  return vi.fn((target: DialTarget, signal: AbortSignal) => {
    expect(target.host).toBe(target.ip);
    expect(target.ip).toBe('93.184.215.14');
    expect(target.port).toBe(80);
    const socket = connect({ host: '127.0.0.1', port: portFor(target) });
    const abort = () => { socket.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    socket.once('close', () => signal.removeEventListener('abort', abort));
    return socket;
  });
}

describe('通常Shell専用の局所ソケット検証', () => {
  it('SSRF-PIN-02 pins the checked address and sends the original Host despite rebinding DNS', { timeout: 5000 }, async () => {
    const hosts: (string | undefined)[] = [];
    const close = await localServer(3357, (req, res) => { hosts.push(req.headers.host); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('socket success'); });
    try {
      const resolve = vi.fn<Resolve>(async () => ['93.184.215.14']);
      resolve.mockImplementationOnce(async () => ['93.184.215.14']);
      resolve.mockImplementation(async () => ['127.0.0.1']);
      const dial = await localDial(() => 3357);
      expect(await fetchReference('http://rebind.example.com/path', { resolve, dial })).toMatchObject({ ok: true, body: 'socket success' });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(dial).toHaveBeenCalledTimes(1);
      expect(hosts).toEqual(['rebind.example.com']);
    } finally { await close(); }
  });
  it('SSRF-PIN-02 rechecks rebinding on a redirect before any second connection', { timeout: 5000 }, async () => {
    let requests = 0;
    const close = await localServer(3357, (_req, res) => { requests++; res.writeHead(302, { Location: '/next' }); res.end(); });
    try {
      const resolve = vi.fn<Resolve>(async () => ['127.0.0.1']);
      resolve.mockImplementationOnce(async () => ['93.184.215.14']);
      const dial = await localDial(() => 3357);
      expect(await fetchReference('http://rebind.example.com/', { resolve, dial })).toEqual({ ok: false, code: 'BLOCKED_URL' });
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(dial).toHaveBeenCalledTimes(1);
      expect(requests).toBe(1);
    } finally { await close(); }
  });
  it('SSRF-RD-04 revalidates each redirect and sends neither Cookie nor Authorization', { timeout: 5000 }, async () => {
    const received: { host: string | undefined; cookie: string | undefined; authorization: string | undefined }[] = [];
    const observe = (req: IncomingMessage) => received.push({ host: req.headers.host, cookie: req.headers.cookie, authorization: req.headers.authorization });
    const closeFirst = await localServer(3357, (req, res) => { observe(req); res.writeHead(302, { Location: 'http://finish.example.com/final', 'Set-Cookie': 'fixture=synthetic' }); res.end(); });
    let closeSecond: (() => Promise<void>) | undefined;
    try {
      closeSecond = await localServer(3358, (req, res) => { observe(req); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('redirect success'); });
      const resolve = vi.fn<Resolve>(async () => ['93.184.215.14']);
      const dial = await localDial(target => target.verifyHostname === 'start.example.com' ? 3357 : 3358);
      expect(await fetchReference('http://start.example.com/', { resolve, dial })).toMatchObject({ ok: true, body: 'redirect success' });
      expect(resolve.mock.calls.map(call => call[0])).toEqual(['start.example.com', 'finish.example.com']);
      expect(dial).toHaveBeenCalledTimes(2);
      expect(received).toEqual([
        { host: 'start.example.com', cookie: undefined, authorization: undefined },
        { host: 'finish.example.com', cookie: undefined, authorization: undefined },
      ]);
    } finally { if (closeSecond) await closeSecond(); await closeFirst(); }
  });
});

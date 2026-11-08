import { createServer } from 'node:http';

const server = createServer((request, response) => {
  switch (request.url) {
    case '/health': response.writeHead(200, { 'content-type': 'text/plain' }); response.end('fixture'); break;
    case '/failed': response.writeHead(503, { 'content-type': 'text/plain' }); response.end('fixture failure'); break;
    case '/redirect': response.writeHead(302, { location: 'http://example.com/success' }); response.end(); break;
    case '/private': response.writeHead(302, { location: 'http://127.0.0.1/' }); response.end(); break;
    case '/loop': response.writeHead(302, { location: 'http://example.com/loop' }); response.end(); break;
    case '/large': response.writeHead(200, { 'content-type': 'text/plain', 'content-length': 2097153 }); response.end('a'.repeat(2097153)); break;
    case '/plain': response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); response.end('fixtureの参考本文'); break;
    case '/pdf': response.writeHead(200, { 'content-type': 'application/pdf' }); response.end('fixture'); break;
    default: response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><html><head><title>テスト用の参考ページ</title><script>秘密ではない除去対象</script></head><body><h1>参考資料</h1><p>fixtureの参考本文</p><p hidden>非表示の除去対象</p></body></html>');
  }
});
server.listen(3351, '127.0.0.1');
const deadline = setTimeout(() => server.close(), 10 * 60 * 1000);
function close() { clearTimeout(deadline); server.close(); }
process.on('SIGTERM', close);
process.on('SIGINT', close);

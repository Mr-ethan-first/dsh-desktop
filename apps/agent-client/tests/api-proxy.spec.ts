// 选项二自动化测试：API 反向代理默认开启、同源把 web 前端请求转发到本地后端，
// 且代理本身不把 API Key 注入前端响应 / 也不读取 Key 注入到发往后端的请求之外。
// 用 mock 后端做测试替身，无需真实后端 / electron。
import { describe, it, expect, afterAll } from 'vitest';
import proxyMod from '../electron/plugin-host/api-proxy.cjs';
const { shouldProxyUrl, buildBackendTarget, forwardRequest } = proxyMod as any;
import http from 'node:http';
import { AddressInfo } from 'node:net';

function listenOn(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
}
function closeServer(s: http.Server) { return new Promise<void>((r) => s.close(() => r())); }

describe('api-proxy (选项二：默认开代理，Key 不暴露前端)', () => {
  const saved = process.env.DSH_WEB_PROXY_API;

  afterAll(() => {
    if (saved === undefined) delete process.env.DSH_WEB_PROXY_API;
    else process.env.DSH_WEB_PROXY_API = saved;
  });

  it('shouldProxyUrl 默认开启：API 路径 true，静态路径 false', () => {
    delete process.env.DSH_WEB_PROXY_API;
    expect(shouldProxyUrl('/api/chat')).toBe(true);
    expect(shouldProxyUrl('/v1/models')).toBe(true);
    expect(shouldProxyUrl('/zhipu/xxx')).toBe(true);
    expect(shouldProxyUrl('/index.html')).toBe(false);
    expect(shouldProxyUrl('/static/app.js')).toBe(false);
  });

  it('shouldProxyUrl 显式 enabled=false 全关，enabled=true 全开', () => {
    expect(shouldProxyUrl('/api/chat', { enabled: false })).toBe(false);
    expect(shouldProxyUrl('/api/chat', { enabled: true })).toBe(true);
    expect(shouldProxyUrl('/whatever', { enabled: true, prefixes: /^\/whatever/ })).toBe(true);
  });

  it('buildBackendTarget 拼接 baseUrl + 原路径', () => {
    expect(buildBackendTarget('http://127.0.0.1:5183', '/api/chat')).toBe('http://127.0.0.1:5183/api/chat');
  });

  it('forwardRequest 同源把请求原样转发到后端并透传响应', async () => {
    const backend = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, url: req.url, body, gotAuth: !!req.headers['authorization'] }));
      });
    });
    const backendPort = await listenOn(backend);
    const base = `http://127.0.0.1:${backendPort}`;

    const proxy = http.createServer((req, res) => forwardRequest(req, res, { targetBaseUrl: base, httpModule: http }));
    const proxyPort = await listenOn(proxy);

    const payload = JSON.stringify({ msg: 'hello' });
    const resp: any = await new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port: proxyPort, path: '/api/chat', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
        (res2) => {
          const c: Buffer[] = [];
          res2.on('data', (x) => c.push(x));
          res2.on('end', () => resolve({ status: res2.statusCode, headers: res2.headers, body: JSON.parse(Buffer.concat(c).toString()) }));
        });
      r.on('error', reject); r.write(payload); r.end();
    });

    try {
      expect(resp.status).toBe(200);
      expect(resp.body.method).toBe('POST');
      expect(resp.body.url).toBe('/api/chat'); // 同源路径被原样转发
      expect(resp.body.body).toBe(payload);
      expect(resp.body.gotAuth).toBe(false); // 前端没传 auth，代理也不注入
      expect(resp.headers['authorization']).toBeUndefined(); // 代理不向前端回包注入 Key
    } finally {
      await closeServer(proxy); await closeServer(backend);
    }
  });

  it('forwardRequest 透传后端错误状态码（502 回退路径也可达）', async () => {
    const backend = http.createServer((req, res) => { res.writeHead(500); res.end('boom'); });
    const backendPort = await listenOn(backend);
    const proxy = http.createServer((req, res) => forwardRequest(req, res, { targetBaseUrl: `http://127.0.0.1:${backendPort}`, httpModule: http }));
    const proxyPort = await listenOn(proxy);

    const resp: any = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: proxyPort, path: '/api/x', method: 'GET' }, (res2) => {
        const c: Buffer[] = [];
        res2.on('data', (x) => c.push(x));
        res2.on('end', () => resolve({ status: res2.statusCode, body: Buffer.concat(c).toString() }));
      });
      r.on('error', reject); r.end();
    });

    try {
      expect(resp.status).toBe(500);
      expect(resp.body).toBe('boom');
    } finally {
      await closeServer(proxy); await closeServer(backend);
    }
  });
});

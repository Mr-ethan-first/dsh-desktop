import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * OpenAI 兼容服务商代理（仅开发态）。
 * - 浏览器调用同源 `/zhipu/...`（历史路径名）→ 由本中间件转发到 DeepSeek 官方端点并注入用户密钥；
 * - glm/cogview 等历史模型名仍转发 open.bigmodel.cn 供旧链路调试；
 * - 密钥仅来自服务端环境变量 / .env（经 loadEnv 读取），**绝不进入浏览器包**；
 * - SSE 流式原样透传。
 * 生产部署需将该前缀指向你自己的网关（或在 client.cfg.apiBase 直接配置网关地址）。
 */
function zhipuProxy(getKeys: () => string[]): Plugin {
  const UPSTREAM_ZHIPU = 'https://open.bigmodel.cn';
  const UPSTREAM_DEEPSEEK = 'https://api.deepseek.com';

  function resolveUpstream(bodyText: string, reqUrl: string): { upstream: string; path: string } {
    let model = '';
    try {
      const parsed = JSON.parse(bodyText);
      model = String(parsed.model || '');
    } catch {
      /* 解析失败按 URL 路径兜底 */
    }
    // 路径中已包含 /api/paas/v4 等智谱风格前缀
    const suffix = reqUrl || '';
    if (model.startsWith('glm') || model.startsWith('cogview') || model.startsWith('cogvideo')) {
      return { upstream: UPSTREAM_ZHIPU, path: suffix };
    }
    // 默认（deepseek-* 及未知模型）走 DeepSeek 官方：去掉 /api/paas/v4 前缀，避免 404。
    return { upstream: UPSTREAM_DEEPSEEK, path: suffix.replace(/^\/api\/paas\/v4/, '') };
  }

  return {
    name: 'zhipu-openai-proxy',
    configureServer(server) {
      server.middlewares.use('/zhipu', async (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        await new Promise<void>((r) => req.on('end', () => r()));
        const body = Buffer.concat(chunks).toString('utf8');
        const keys = getKeys().filter(Boolean);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (keys[0]) headers['authorization'] = `Bearer ${keys[0]}`;
        const { upstream, path } = resolveUpstream(body, req.url || '');
        const target = upstream + path;
        try {
          const upstream = await fetch(target, {
            method: req.method || 'POST',
            headers,
            body: body || undefined,
          });
          res.statusCode = upstream.status;
          upstream.headers.forEach((v, k) => {
            const lk = k.toLowerCase();
            if (lk !== 'content-length' && lk !== 'transfer-encoding') res.setHeader(k, v);
          });
          if (upstream.body) {
            const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
            const pump = async () => {
              const { done, value } = await reader.read();
              if (done) {
                res.end();
                return;
              }
              res.write(Buffer.from(value));
              void pump();
            };
            void pump();
          } else {
            res.end();
          }
        } catch (e) {
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: String((e as Error)?.message || e), proxyTarget: target }));
        }
      });
    },
  };
}

/**
 * 工作目录文件操作中间件（仅开发态，POST /dsh-fs/op）。
 * 智能体在选定的工作目录内自动创建/修改/删除文件；路径穿越与绝对路径被拒绝。
 */
function dshFsPlugin(): Plugin {
  return {
    name: 'dsh-fs-bridge',
    configureServer(server) {
      server.middlewares.use('/dsh-fs/ping', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
      server.middlewares.use('/dsh-fs/op', async (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        await new Promise<void>((r) => req.on('end', () => r()));
        let body: { op?: string; workDir?: string; relPath?: string; content?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, text: '请求体不是合法 JSON' }));
          return;
        }
        const reply = (ok: boolean, text: string) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok, text }));
        };
        const rel = String(body.relPath ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
        const base = String(body.workDir ?? '').trim().replace(/[\\/]+$/, '');
        if (!base) return reply(false, '缺少 workDir');
        // list 允许空 relPath（列工作目录根）；其余操作要求非空路径
        if (!rel && body.op !== 'list') return reply(false, '缺少 relPath');
        if (rel && (/^[a-zA-Z]:/.test(rel) || rel.split('/').some((p) => p === '..' || p === ''))) {
          return reply(false, `非法路径（禁止穿越/绝对路径）：${body.relPath}`);
        }
        const full = rel ? path.join(base, rel) : base;
        try {
          switch (body.op) {
            case 'write':
              fs.mkdirSync(path.dirname(full), { recursive: true });
              fs.writeFileSync(full, body.content ?? '', 'utf8');
              return reply(true, `已写入 ${rel}（${(body.content ?? '').length} 字符）`);
            case 'read':
              return reply(true, fs.readFileSync(full, 'utf8'));
            case 'delete':
              fs.unlinkSync(full);
              return reply(true, `已删除 ${rel}`);
            case 'list': {
              const names = fs.existsSync(full)
                ? fs.readdirSync(full).sort().map((n) => (fs.statSync(path.join(full, n)).isDirectory() ? `${n}/` : n))
                : [];
              return reply(true, JSON.stringify(names));
            }
            default:
              return reply(false, `未知操作：${body.op}`);
          }
        } catch (e) {
          return reply(false, `文件操作失败：${(e as Error).message}`);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const env = loadEnv(mode, root, '');
  const resolveKeys = () =>
    (env.DEEPSEEK_API_KEYS || env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY ||
      env.ZHIPU_API_KEYS || env.ZHIPU_API_KEY || process.env.ZHIPU_API_KEY || '')
      .split(',')
      .map((s) => s.trim());
  return {
    plugins: [react(), zhipuProxy(resolveKeys), dshFsPlugin()],
    server: { port: 5173 },
  };
});

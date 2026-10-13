// 插件工作台 API 反向代理（纯 Node，零 electron 依赖，可被 vitest 单测）。
// 选项二：把内嵌 web 前端的 API 类请求反向代理到本地主后端（同源 /api），
// 使 web 前端的 agent 对话可达；API Key 仅存在于主进程/后端，代理本身从不把 Key
// 写入响应、也不注入到发往后端的请求之外——前端页面接触不到 Key。
"use strict";
const http = require("node:http");

/**
 * 需要走代理的 API 路径前缀（同源反向代理到本地后端）。
 * 默认开启：DSH_WEB_PROXY_API !== '0' 即代理；置 '0' 关闭。
 */
const WEB_API_PREFIXES = /^\/(?:api|v1|zhipu|healthz|openai|completions|models|oauth|auth|mcp|sse|ws)\b/i;

/**
 * 是否应把该请求路径反代到本地后端。
 * @param {string} urlPath 请求路径（含或不合 query 均可）
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] 是否启用代理（默认读 DSH_WEB_PROXY_API !== '0'）
 * @param {RegExp} [opts.prefixes] 前缀正则（默认 WEB_API_PREFIXES）
 */
function shouldProxyUrl(urlPath, { enabled = (process.env.DSH_WEB_PROXY_API !== '0'), prefixes = WEB_API_PREFIXES } = {}) {
  if (!enabled) return false;
  const p = (urlPath || '/').split('?')[0];
  return prefixes.test(p);
}

/** 拼接后端目标 URL：baseUrl + 原请求路径。 */
function buildBackendTarget(baseUrl, urlPath) {
  return baseUrl + (urlPath || '/');
}

/**
 * 把一次 HTTP 请求原样转发到本地后端，并透传响应。
 * 不读取/注入任何 API Key——Key 由后端持有；前端只看到后端回包。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} opts
 * @param {string} opts.targetBaseUrl 本地后端基址，如 http://127.0.0.1:5183
 * @param {object} [opts.httpModule] 注入 node:http（默认真实）
 * @param {(msg:string)=>void} [opts.onLog]
 */
function forwardRequest(req, res, { targetBaseUrl, httpModule = http, onLog } = {}) {
  const target = buildBackendTarget(targetBaseUrl, req.url);
  const proxyReq = httpModule.request(target, { method: req.method, headers: req.headers }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    if (onLog) onLog('[web-proxy] failed: ' + (e && (e.message || e)));
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('backend proxy error: ' + (e && e.message));
  });
  req.pipe(proxyReq);
  return proxyReq;
}

module.exports = { WEB_API_PREFIXES, shouldProxyUrl, buildBackendTarget, forwardRequest };

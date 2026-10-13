// 复现 DashScope 工具调用 SSE 流，确认 tool_calls delta 中 name 字段的表现
const https = require('https');

const KEY = 'sk-ws-H.EDXLXDY.Unv4.MEUCIQCrkvLpP4qtf3OiKSwdcB-BFhl9MMuMRTgy2WV5P4B7tQIgCjTzWBxYUSu7sYSzGYdTrZ9QY_nOMSrh1c18CpO6RmM';
const MODEL = process.argv[2] || 'deepseek-v3';
const PROMPT = process.argv[3] || '帮我写一个Vue3的演示html文件，保存为 demo.html';

const tools = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '将内容写入指定路径的文件',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件保存路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

const body = JSON.stringify({
  model: MODEL,
  messages: [
    { role: 'system', content: '你是一个编程助手，需要使用 write_file 工具来写文件。' },
    { role: 'user', content: PROMPT },
  ],
  tools,
  tool_choice: 'auto',
  stream: true,
  max_tokens: 2000,
});

const req = https.request(
  {
    hostname: 'dashscope.aliyuncs.com',
    path: '/compatible-mode/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + KEY,
      'Content-Length': Buffer.byteLength(body),
    },
  },
  (res) => {
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          process.stdout.write('[DONE]\n');
          continue;
        }
        try {
          const parsed = JSON.parse(payload);
          const tc = parsed.choices?.[0]?.delta?.tool_calls;
          if (tc && tc.length) {
            process.stdout.write('TOOL_CALL_DELTA: ' + JSON.stringify(tc) + '\n');
          }
          const fr = parsed.choices?.[0]?.finish_reason;
          if (fr) process.stdout.write('FINISH_REASON: ' + fr + '\n');
        } catch (e) {
          process.stdout.write('PARSE_ERR: ' + payload.slice(0, 120) + '\n');
        }
      }
    });
    res.on('end', () => console.log('--- stream ended, status', res.statusCode));
  }
);
req.on('error', (e) => console.log('ERR', e.message));
req.write(body);
req.end();

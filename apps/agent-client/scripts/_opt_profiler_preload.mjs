// 通过 --import 注入：从 Node 引导阶段就开始采样 V8 CPU 剖面，到点后落盘并退出。
// 用于定位 `dsh web` 冷启动 10s 究竟花在哪里（模块加载 / 文件系统 / 业务逻辑）。
import inspector from 'node:inspector';
import fs from 'node:fs';
import path from 'node:path';

const out = process.env.DSH_PROF_OUT || path.join(process.env.TEMP || '.', 'dsh-prof', 'boot.cpuprofile');
const ms = Number(process.env.DSH_PROF_MS || 13000);

const session = new inspector.Session();
session.connect();
session.post('Profiler.enable', () => {
  session.post('Profiler.start', () => {
    const t = setTimeout(() => {
      session.post('Profiler.stop', (err, res) => {
        try {
          if (err) throw err;
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, JSON.stringify(res.profile));
          fs.writeFileSync(out + '.marker', `profiled ${ms}ms\n`);
        } catch (e) {
          try { fs.writeFileSync(out + '.error', String(e && e.stack)); } catch { /* ignore */ }
        }
        process.exit(0);
      });
    }, ms);
    t.unref();
  });
});

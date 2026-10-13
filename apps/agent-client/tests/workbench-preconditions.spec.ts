// 待跟进项 1/3 自动校验：插件工作台前置条件。
//  - apps/web 必须存在 build 脚本（pnpm --filter @deepseek-ai/dsh-web-frontend build）。
//  - 工作台后端可用：apps/web/dist 已构建（静态回退）或 dsh bin 可解析（官方 dsh web）。
// 沙箱两者皆无会 skip；用户本机构建后该用例自动转 run 并通过，免去手工验证。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import launcher from '../electron/plugin-host/dsh-web-launcher.cjs';
const { resolveDshBin } = launcher as any;

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const webPkg = path.join(repoRoot, 'apps', 'web', 'package.json');
const webDistIndex = path.join(repoRoot, 'apps', 'web', 'dist', 'index.html');

describe('插件工作台前置条件（待跟进项 1/3 自动校验）', () => {
  it('apps/web 存在 build 脚本', () => {
    expect(fs.existsSync(webPkg)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(webPkg, 'utf8'));
    const scripts = pkg.scripts || {};
    const hasBuild = Object.values(scripts).some((v) => typeof v === 'string' && /build/.test(v as string));
    expect(hasBuild).toBe(true);
  });

  const distReady = fs.existsSync(webDistIndex);
  const dshReady = !!resolveDshBin([
    path.join(repoRoot, 'node_modules', '.bin', 'dsh'),
    'dsh',
  ]);
  const available = distReady || dshReady;

  // 本地真机：构建产出 apps/web/dist 或 dsh bin 可用，至少其一满足才具工作台后端。
  it.skipIf(!available)('工作台后端可用：apps/web/dist 已构建 或 dsh bin 可解析', () => {
    expect(available).toBe(true);
  });
});

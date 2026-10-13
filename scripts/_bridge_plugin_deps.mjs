/**
 * 为 extensions 下插件补齐宿主机侧缺失依赖：在 <plugin>/node_modules 下建 junction 指向
 * dsh-runtime 中已存在的同名包（canonical 目录）。
 * 幂等：已正确指向则跳过。
 */
import fs from 'node:fs';
import path from 'node:path';

const EXT = 'D:/DeepSeekAgent/resources/packages/extensions';
const RUNTIME_NM = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules';

/** pluginName -> 需要补的包名列表 */
const NEEDS = {
  // 仅补 profile bundle（dsh.bundle 非空）在启动期真正需要的宿主侧依赖，避免把
  // 冗余包 junction 进 packages 导致 NSIS 打包体积膨胀。
  'dsh-market': ['@deepseek-ai/schemastery'],
  'dsh-modlens': [],
  'dsh-node-flow': [],
};

let created = 0, kept = 0, failed = 0;
for (const [plugin, pkgs] of Object.entries(NEEDS)) {
  const pluginDir = path.join(EXT, plugin);
  if (!fs.existsSync(pluginDir)) { console.log(`skip ${plugin} (not found)`); continue; }
  for (const pkg of pkgs) {
    const target = path.join(RUNTIME_NM, pkg);
    if (!fs.existsSync(path.join(target, 'package.json'))) { console.log(`  ! runtime lacks ${pkg}`); failed++; continue; }
    const link = path.join(pluginDir, 'node_modules', pkg);
    try {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink() && fs.realpathSync(link).toLowerCase() === fs.realpathSync(target).toLowerCase()) { kept++; continue; }
      fs.rmSync(link, { recursive: true, force: true });
    } catch (e) { if (e.code !== 'ENOENT') { /* fallthrough */ } }
    try {
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, 'junction');
      created++;
    } catch (e) { console.log(`  ! link fail ${plugin}/${pkg}: ${e.code}`); failed++; }
  }
}
console.log(`bridged: created=${created} kept=${kept} failed=${failed}`);

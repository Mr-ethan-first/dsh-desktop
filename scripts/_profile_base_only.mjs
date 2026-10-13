/**
 * 把 $DSH_HOME/profiles/web 重置为「仅基础 bundle」（dsh-base + dsh-web-app），
 * 用于二分定位：会话创建失败到底来自社区插件挂载，还是运行时本身。
 * 幂等、可逆（重建插件挂载只需再跑一次 launcher 的 prepareDshHome）。
 */
import fs from 'node:fs'
import path from 'node:path'

const PROFILE = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home/profiles/web'
const BASE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

const manifest = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: BASE, patchReload: 'live' } },
}
fs.mkdirSync(PROFILE, { recursive: true })
fs.writeFileSync(path.join(PROFILE, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')

// 清掉插件 junction（只 unlink 链接本身）
const nm = path.join(PROFILE, 'node_modules')
let removed = 0
if (fs.existsSync(nm)) {
  for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
    const p = path.join(nm, e.name)
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) { fs.unlinkSync(p); removed++ }
  }
}
console.log('profile 已重置为 base-only；移除插件链接', removed, '个')
console.log(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'))

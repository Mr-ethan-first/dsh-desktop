// 恢复完整 web profile：调用 launcher 的 prepareDshHome（与真实 exe 启动行为一致），
// 把 9 个社区插件（声明 dsh.bundle 的 5 个）注入 profiles/web 的 bundles 并建 junction。
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const launcher = require(path.resolve('apps/agent-client/electron/plugin-host/dsh-web-launcher.cjs'))

const EXT = 'D:/DeepSeekAgent/resources/packages/extensions'
const DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home'

const plugins = launcher.readCommunityPlugins(EXT)
console.log('发现社区插件 (dsh.bundle):')
for (const p of plugins) console.log('  -', p.name, '->', p.dir)

launcher.prepareDshHome({ extensionsDir: EXT, dshHome: DSH_HOME, profileName: 'web' })

const pkg = require(path.join(DSH_HOME, 'profiles/web/package.json'))
console.log('\n写入后的 bundles:')
for (const b of pkg.dsh.profile.bundles) console.log('  -', b)
console.log('\nOK: 完整 profile 已恢复')

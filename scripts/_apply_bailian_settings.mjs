/**
 * 把百炼（DashScope）provider 注入 DSH_HOME 的 settings.yaml。
 *
 * - 不改产品内置默认值（settings.yaml 属于用户数据，不是发行包内容）。
 * - 支持 --restore 还原到执行前备份。
 * - 凭证不落盘：仅写 apiKeyEnv 引用，真实 key 由测试环境注入环境变量。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home'
const SETTINGS = `${DSH_HOME}/settings.yaml`
const BACKUP = 'D:/tmp-build/settings.yaml.bak'

if (process.argv.includes('--restore')) {
  if (existsSync(BACKUP)) { copyFileSync(BACKUP, SETTINGS); console.log('已还原 settings.yaml（来自 ' + BACKUP + '）') }
  else console.log('无备份，未还原')
  process.exit(0)
}

if (!existsSync(BACKUP)) { copyFileSync(SETTINGS, BACKUP); console.log('首次备份 ->', BACKUP) }

const original = readFileSync(BACKUP, 'utf8')

// 读取百炼 key（仅探测存在性，不落盘到 settings）
const readMachineEnv = (name) => {
  try {
    return execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${name}', 'Machine')"`, { encoding: 'utf8' }).trim()
  } catch { return '' }
}
const KEY = readMachineEnv('AI_DASHSCOPE_API_KEY')
if (!KEY) { console.error('FATAL: 未取到 AI_DASHSCOPE_API_KEY'); process.exit(2) }
console.log('百炼 key 已就绪 length=' + KEY.length)

const BAILIAN = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
llm-pi-ai:
  providers:
    bailian:
      displayName: bailian
      apiKeyEnv: AI_DASHSCOPE_API_KEY
      api: openai-completions
      baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
      models:
        - id: qwen-plus
          name: qwen-plus
        - id: deepseek-v3
          name: deepseek-v3
agent-default-model:
  provider: bailian
  model: qwen-plus
`

writeFileSync(SETTINGS, BAILIAN, 'utf8')
console.log('已写入测试用 settings.yaml:')
console.log(BAILIAN)
console.log('原配置已备份于', BACKUP)

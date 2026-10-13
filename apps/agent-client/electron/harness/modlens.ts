/**
 * modlens —— 为纯文本大模型外挂图片识别能力的视觉桥接。
 *
 * 设计目标（忠实于 github.com/liustack/modlens 的理念）：
 * 把用户粘贴/上传的图片交给一个「视觉模型」转写为结构化文字证据
 * （OCR 文字 + 版面 + 语义描述），再把这段证据作为纯文本回注给主模型，
 * 让原本看不到图片的纯文本模型（如 glm-5.1）也能「理解」图片内容。
 *
 * 与 dsh 插件版的差异：这里不依赖外置 CLI / 守护进程，而是直接复用 harness 已有的
 * 智谱 OpenAI 兼容凭据，调用一个视觉模型（默认 glm-4v，回退链 glm-4v/glm-4.6v/glm-4v-plus）完成识别，
 * 因此零额外依赖、可离线打包进 exe。
 */

import { fetchWithRetry } from './llm.js'
import type { ContentBlock } from './session.js'

/** 单张图片块（与 session.ts 的 image 块对齐） */
export interface ImageBlock {
  type: 'image'
  mimeType: string
  data: string
  name?: string
}

/** modlens 配置 */
export interface ModlensConfig {
  /** 是否启用视觉桥接（默认 true） */
  enabled: boolean
  /** 首选视觉模型名（必须支持 image_url 多模态输入） */
  model: string
  /** 视觉模型回退链（首选失败 / 拒答时依次尝试） */
  fallbackModels: string[]
  /** 视觉模型端点 baseUrl（OpenAI 兼容 /chat/completions） */
  baseUrl: string
  /** 视觉模型 API Key */
  apiKey: string
  /** 单张图片的识别提示词 */
  prompt: string
  /** 单次识别最大输出 token（部分视觉模型上限 1024） */
  maxTokens: number
}

const DEFAULT_VISION_PROMPT =
  '请尽可能详细、结构化地描述这张图片的全部可见内容：\n' +
  '1) 图中所有文字（OCR，尽量保留原文与大致位置）；\n' +
  '2) 整体版面 / 构图；\n' +
  '3) 关键实体、数据、代码、公式或流程图的含义；\n' +
  '4) 若图片是算法 / 架构 / 图表，请解释其结构与含义。\n' +
  '输出中文，尽可能完整，不要省略关键信息。'

/** 视觉模型常见的「拒答 / 无内容」标记：命中则视为本次识别失败，触发回退。 */
const REFUSAL_MARKERS = [
  '抱歉，我无法处理该请求',
  '无法处理该请求',
  '我无法处理',
  'i cannot',
  'cannot process',
]

/**
 * 从环境变量 + harness 兜底凭据解析 modlens 配置。
 * 环境变量优先级最高，便于在不改代码的情况下切换视觉后端。
 */
export function loadModlensConfig(
  env: NodeJS.ProcessEnv,
  fallback: { apiKey: string; baseUrl: string },
): ModlensConfig {
  const enabled = (env.MODLENS_ENABLED ?? 'true').trim().toLowerCase() !== 'false'
  const model = (env.MODLENS_MODEL || 'glm-4v').trim()
  const fallbackModels = (env.MODLENS_FALLBACK_MODELS || 'glm-4v,glm-4.6v,glm-4v-plus')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const baseUrl = (
    env.MODLENS_BASE_URL ||
    env.ZHIPU_API_BASE ||
    fallback.baseUrl ||
    'https://open.bigmodel.cn/api/paas/v4'
  )
    .replace(/\/$/, '')
  const apiKey = (
    env.MODLENS_API_KEY ||
    env.ZHIPU_API_KEYS ||
    env.ZHIPU_API_KEY ||
    fallback.apiKey ||
    ''
  )
    .split(',')[0]
    ?.trim()
  const prompt = (env.MODLENS_PROMPT || DEFAULT_VISION_PROMPT).trim()
  const maxTokensRaw = env.MODLENS_MAX_TOKENS
  const maxTokens = maxTokensRaw ? Math.max(1, Math.min(4096, parseInt(maxTokensRaw, 10) || 1024)) : 1024
  return { enabled, model, fallbackModels, baseUrl, apiKey: apiKey || '', prompt, maxTokens }
}

/**
 * 判断某个模型名是否原生支持视觉（多模态 image_url 输入）。
 * 若主模型本身支持视觉，则无需 modlens，直接把 image_url 透传给模型即可。
 */
export function modelSupportsVision(model: string): boolean {
  if (!model) return false
  const m = model.toLowerCase()
  return (
    m.includes('vision') ||
    m.includes('-vl') ||
    m.includes('vl-') ||
    m.includes('-v-') ||
    m.includes('4v') ||
    m.includes('4.6v') ||
    m.startsWith('glm-4v') ||
    m.startsWith('qwen-vl') ||
    m.includes('gpt-4o') ||
    m.includes('gpt-4-vision') ||
    m.includes('claude-3') ||
    (m.includes('gemini') && m.includes('vision'))
  )
}

/**
 * 把一批图片交给视觉模型，返回与图片一一对应的文字描述。
 * 单张图片会先尝试首选模型，若返回拒答 / 空内容 / 报错，则依次尝试回退模型链，
 * 最大化「识别成功」的概率。仍全部失败时该张返回降级文本，不中断整批。
 */
export async function describeImages(
  images: ImageBlock[],
  cfg: ModlensConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  const modelChain = [cfg.model, ...cfg.fallbackModels].filter(
    (m, idx, arr) => m && arr.indexOf(m) === idx,
  )
  const out: string[] = []
  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    const url = `data:${img.mimeType};base64,${img.data}`

    let lastErr = ''
    let done = false
    for (const m of modelChain) {
      const body = {
        model: m,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: cfg.prompt },
              { type: 'image_url', image_url: { url } },
            ],
          },
        ],
        stream: false,
        max_tokens: cfg.maxTokens,
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('modlens vision timeout')), 120_000)
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason)
        else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
      }

      try {
        const resp = await fetchWithRetry(
          `${cfg.baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
          2,
        )
        if (!resp.ok) {
          const txt = await resp.text().catch(() => '')
          throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 300)}`)
        }
        const json = (await resp.json()) as any
        const text = (json?.choices?.[0]?.message?.content as string) || ''
        const trimmed = text.trim()
        // 拒答 / 空内容：尝试下一个回退模型
        if (!trimmed || REFUSAL_MARKERS.some((mk) => trimmed.includes(mk))) {
          lastErr = `模型 ${m} 返回拒答/空内容`
          console.warn(`[modlens] ${lastErr}，尝试回退模型`)
          continue
        }
        out.push(trimmed)
        done = true
        break
      } catch (e) {
        lastErr = `模型 ${m} 异常：${(e as Error)?.message || '未知错误'}`
        console.warn(`[modlens] ${lastErr}，尝试回退模型`)
      } finally {
        clearTimeout(timer)
      }
    }

    if (!done) {
      out.push(`(第 ${i + 1} 张图片视觉识别失败：${lastErr || '所有模型均无有效输出'})`)
    }
  }
  return out
}

/**
 * 把含图片的消息块转换为「纯文本模型可消费」的消息块：
 * - 若 modlens 关闭 或 主模型本身支持视觉 → 原样返回（交给模型原生多模态）。
 * - 否则调用视觉模型把每张图片转成文字证据，并以一个文本块追加在末尾，
 *   等价于为纯文本模型外挂了图片识别能力。
 */
export async function bridgeImagesToText(
  content: ContentBlock[],
  cfg: ModlensConfig | undefined,
  mainModel: string,
  signal?: AbortSignal,
): Promise<ContentBlock[]> {
  const images = content.filter(
    (b): b is ImageBlock => b.type === 'image',
  )
  if (images.length === 0) return content

  // 原生视觉模型：直接透传 image_url，无需 modlens
  if (!cfg || !cfg.enabled || !cfg.apiKey) return content
  if (modelSupportsVision(mainModel)) return content

  try {
    const descs = await describeImages(images, cfg, signal)
    const visionText = descs
      .map((d, i) => `【modlens 视觉识别 · 图${i + 1}】\n${d}`)
      .join('\n\n')
    const rest = content.filter((b) => b.type !== 'image')
    return [
      ...rest,
      {
        type: 'text',
        text:
          `\n\n以下是用户附带的图片，经 modlens 视觉识别得到的文字内容，` +
          `请基于它理解用户意图并作答：\n${visionText}\n`,
      },
    ]
  } catch (e) {
    console.error('[modlens] 图片识别整体失败，已降级为纯文本提示：', e)
    const rest = content.filter((b) => b.type !== 'image')
    return [
      ...rest,
      {
        type: 'text',
        text:
          '\n\n[注：用户附带的图片视觉识别失败，当前模型看不到图片内容；' +
          '请提示用户改用支持视觉的模型或稍后重试]\n',
      },
    ]
  }
}

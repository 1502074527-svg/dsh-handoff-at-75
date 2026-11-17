/**
 * 自动交接 · Host + 可见设置面板
 *
 * 监听 durable 的 assistant/message 与 turn/end 事件，用 tokenMeter.measure()
 * 读取当前上下文压力；达到「自定义预算 × 阈值」时：
 *   1. 从已提交的会话日志里确定性抽取交接内容，写 PROJECT_STATE.md 到项目目录；
 *   2. 在同一 Workspace 下新建 Session（sessionController.create 一步完成
 *      agent 创建、GUI 公告、workspace 挂载）；
 *   3. 给它发第一条用户提示词，让它读交接文档并继续任务（sessionController.prompt
 *      内部 resolveAgent + followup 会唤醒 loop）。
 *
 * 触发模式（config.mode）：
 *   auto    —— 全自动，直接新建并开跑
 *   confirm —— 先用 ctx.userQuestions 询问，批准后才执行
 *   off     —— 停用
 *
 * 可见配置面（回应「侧边栏看不到 / 没有开关 / 没有设置阈值的地方」）：
 *   - 本插件是 Host 逻辑 + 一个手写的免构建 Client 面板（Settings 分区），
 *     面板通过 /api/auto-handoff/config 这个已认证的 Fetch 路由读写配置；
 *   - 同一份 setConfig() 也挂成 /handoff slash command，不进设置页也能改；
 *   - 配置写入走 configEditor.edit()（写用户 profile 的覆盖层，升级不丢），
 *     普通字段改完由 Loader 自动重启插件，apply() 重新读新值即生效；
 *   - 「自动 / 提醒 / 停用」与阈值都收敛到 mode / budgetTokens / thresholdRatio
 *     三个字段，触发逻辑本身一行不改。
 *
 * 触发一次后按会话去重；压缩使占用降到 rearmRatio 以下时重新武装，
 * 保证「一次压缩世代只交接一次」，fork/resume 后状态由日志与内存态共同维护。
 */

import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
/**
 * 本插件是「本地目录链接安装」的 bundle：不声明 npm 依赖，也不 import
 * @deepseek-ai/* 包（链接目录下无法解析）。配置由 Loader 从 cordis.patch.yml
 * 的 config 传入，这里只做最小范围校验与默认值填充。
 */
export const name = 'handoff-at-75'

// 直接访问的服务：用量测量、会话事件、会话创建/提示、工作区归属、项目目录、确认询问。
// 全部为 web/desktop profile 已挂载的核心服务；缺任一服务时插件保持未激活而不抛错。
// systemPrompt 用于交接后给「旧会话」注册一条模型可见的持久上下文（见 notifyOldSession）。
export const inject = [
  'tokenMeter',
  'sessionController',
  'workspaceRegistry',
  'workingDirectory',
  'userQuestions',
  'sessions',
  'sessionTitle',
  'agents',
  'systemPrompt',
]

const DEFAULTS = Object.freeze({
  budgetTokens: 150000,
  thresholdRatio: 0.75,
  mode: 'auto',
  confirmTimeoutMs: 120000,
  stateFileName: 'PROJECT_STATE.md',
  rearmRatio: 0.4,
  rowTint: true,
  // 交接后新会话使用的模型：空字符串 = 沿用 DSH 当前默认模型（不干预）。
  handoffProvider: '',
  handoffModel: '',
  // 空字符串 = 不写显式推理强度，交给模型适配器默认值（与 selectModel 语义一致）。
  handoffReasoningEffort: '',
  // confirm 模式批准后 / 用户手动要求交接时，先弹一次卡片让用户临时选模型与强度。
  askModelOnHandoff: true,
})

/** Cordis 的 Standard Schema：同步校验并把 config 归一化为带默认值的对象。 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'handoff-at-75',
    validate(value) {
      const raw = (value && typeof value === 'object') ? value : {}
      const issues = []
      const num = (key, min, max) => {
        const v = raw[key] === undefined ? DEFAULTS[key] : Number(raw[key])
        if (!Number.isFinite(v) || v < min || (max !== undefined && v > max)) {
          issues.push({ message: `${key} 必须是 ${min}~${max ?? '∞'} 的数字`, path: [key] })
          return DEFAULTS[key]
        }
        return v
      }
      const mode = raw.mode === undefined ? DEFAULTS.mode : String(raw.mode)
      if (!['auto', 'confirm', 'off'].includes(mode)) {
        issues.push({ message: 'mode 必须是 auto / confirm / off', path: ['mode'] })
      }
      const stateFileName = raw.stateFileName === undefined
        ? DEFAULTS.stateFileName : String(raw.stateFileName)
      if (!stateFileName || stateFileName.includes('/') || stateFileName.includes('\\')) {
        issues.push({ message: 'stateFileName 必须是单纯的文件名', path: ['stateFileName'] })
      }
      // 侧栏四色染色开关：布尔值，缺省 true（profile 无此字段时维持既有染色行为）。
      const rowTint = raw.rowTint === undefined ? DEFAULTS.rowTint : raw.rowTint
      if (typeof rowTint !== 'boolean') {
        issues.push({ message: 'rowTint 必须是布尔值', path: ['rowTint'] })
      }
      // 交接后新会话的模型选择：三个字符串字段，空串表示「沿用默认」。
      const text = (key) => (raw[key] === undefined ? DEFAULTS[key] : String(raw[key]).trim())
      const handoffProvider = text('handoffProvider')
      const handoffModel = text('handoffModel')
      const handoffReasoningEffort = text('handoffReasoningEffort')
      if (handoffProvider.includes('/') || handoffModel.includes('/')) {
        issues.push({ message: 'handoffProvider / handoffModel 必须是单纯的 id，不含 /', path: ['handoffModel'] })
      }
      // provider 与 model 必须成对出现：只填一个无法组成可用选择，宁可报错也不静默忽略。
      if ((handoffProvider === '') !== (handoffModel === '')) {
        issues.push({ message: 'handoffProvider 与 handoffModel 必须同时设置或同时留空', path: ['handoffModel'] })
      }
      const askModelOnHandoff = raw.askModelOnHandoff === undefined
        ? DEFAULTS.askModelOnHandoff : raw.askModelOnHandoff
      if (typeof askModelOnHandoff !== 'boolean') {
        issues.push({ message: 'askModelOnHandoff 必须是布尔值', path: ['askModelOnHandoff'] })
      }
      // 先统一算完所有数值，再判断是否有 issue；否则校验里推入的 issue 会丢在成功分支里。
      const resolved = {
        budgetTokens: Math.round(num('budgetTokens', 1000)),
        thresholdRatio: num('thresholdRatio', 0.1, 1),
        mode,
        confirmTimeoutMs: Math.round(num('confirmTimeoutMs', 1000)),
        stateFileName,
        rearmRatio: num('rearmRatio', 0, 0.9),
        rowTint,
        handoffProvider,
        handoffModel,
        handoffReasoningEffort,
        askModelOnHandoff,
      }
      if (issues.length) return { issues }
      return { value: resolved }
    },
  },
}

/** 独立测试/回退用：不经过 Loader 时也能拿到完整 config。 */
function resolveConfig(raw) {
  const result = Config['~standard'].validate(raw ?? {})
  return result.issues ? { ...DEFAULTS } : result.value
}

/**
 * 每个 Session 的触发状态。为纯内存派生缓存：
 *  - fired：本次「压缩世代」是否已交接过；
 *  - suppressed：confirm 模式下用户选了「本代不再提醒」；
 *  - pending：确认询问或交接动作正在进行，防止并发重复；
 *  - lastWindow：最近一次看到的上下文窗口，用于日志。
 * 插件卸载不影响已新建的 Session。
 */
const stateBySession = new Map()

/**
 * 会话行的「失败 / 额度用尽」红色标记（功能 A 用）。纯内存派生缓存：
 *  - 只在 `turn/end` 的 reason.kind==='error' 时置位（权威正信号）；
 *  - 额度用尽只认精确 code 白名单 QUOTA / ACCOUNT_QUOTA，绝不用文案猜测；
 *  - `turn/start` 或正常结束即清除，避免陈旧红；aborted/completed 一律不标红。
 * 宁可不标，不可误标——没有正信号时该 Map 里没有条目，Client 就不会染红。
 */
const rowErrorBySession = new Map()

function stateFor(id) {
  let state = stateBySession.get(id)
  if (state === undefined) {
    state = { fired: false, suppressed: false, pending: false, lastWindow: undefined }
    stateBySession.set(id, state)
  }
  return state
}

function log(ctx, message) {
  try { ctx.logger?.info?.('[handoff-at-75] ' + message) } catch { /* logger 可选 */ }
}

/** 会话事件里的文本内容（UserMessage / AssistantMessage 的 content 形状兼容多种块）。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (part === null || part === undefined) return ''
      if (typeof part === 'string') return part
      if (typeof part.text === 'string') return part.text
      if (typeof part.content === 'string') return part.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function truncate(text, max) {
  const clean = String(text ?? '').replace(/\r/g, '').trim()
  return clean.length > max ? clean.slice(0, max) + ' …（已截断）' : clean
}

/**
 * 判别「链式交接续接提示」：新会话开头那句
 * 「请读取交接存档 …核对「目标 / 有效决定 / …」后再开工 / 请简要复述…」。
 *
 * 为什么必须剔除：续接会话把这句当作首条 user/message，若被当成真实目标，
 * 下一次交接的「目标」就会变成「请读取上一份存档…」，逐代滚雪球失真
 * （PROJECT_STATE.md §5 已登记）。这里只认结构特征：同时含「交接存档 /
 * PROJECT_STATE」与「读取 / 核对 / 继续 / 复述」等续接动作词，避免误伤真实任务。
 */
export function isResumptionPrompt(text) {
  const t = String(text ?? '')
  if (!/(交接存档|PROJECT_STATE|交接文档)/.test(t)) return false
  // 用「读取 / 复述 / 再开工 / 继续 …」这类续接动作，不用「核对」——
  // 真实任务里也常说「核对一下这个交接文档」，不能误伤。
  return /(读取|复述|再开工|继续任务|继续此任务|继续未完成|直接继续)/.test(t)
}

/**
 * 从已提交日志确定性抽取交接信息。只读 snapshotEvents()，不订阅重扫。
 * 五段：目标 / 有效决定 / 关键文件 / 真实进度 / 下一步 + 旧会话 ID。
 */
function extractHandoff(session) {
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  const humanPrompts = []
  const assistantTexts = []
  const toolNames = new Map()
  const filePaths = new Set()
  const goals = []
  let turns = 0
  let steps = 0
  let lastTurnEndReason

  for (const event of events) {
    const data = event.data ?? {}
    switch (event.type) {
      case 'user/message': {
        const source = data.source ?? {}
        if (source.kind === 'repeat-tool-reminder' || source.kind === 'goal') break
        const text = truncate(textOf(data.content), 1600)
        if (text) humanPrompts.push(text)
        break
      }
      case 'goal/change': {
        const objective = data.objective ?? data.goal?.objective ?? data.created?.objective
        if (typeof objective === 'string' && objective.trim()) goals.push(truncate(objective, 800))
        break
      }
      case 'assistant/message': {
        const text = truncate(textOf(data.message?.content), 1200)
        if (text) assistantTexts.push(text)
        break
      }
      case 'tool/call': {
        const name = String(data.name ?? 'unknown')
        toolNames.set(name, (toolNames.get(name) ?? 0) + 1)
        const raw = data.arguments
        if (typeof raw === 'string') {
          // 只取路径样式的字符串作为「关键文件」，避免把整段参数带进文档。
          for (const match of raw.matchAll(/"(?:file_path|path|target|filename|file)":\s*"([^"]{1,240})"/g)) {
            const value = match[1]
            if (value && (value.includes('/') || value.includes('\\') || value.includes('.'))) filePaths.add(value)
          }
        }
        break
      }
      case 'turn/start': turns += 1; break
      case 'step/start': steps += 1; break
      case 'turn/end': lastTurnEndReason = data.reason; break
      default: break
    }
  }

  // 剔除续接提示后再取目标：链式交接时，新会话的第一条 user/message 往往是
  // 「请读取交接存档…」，它不是任务目标，不能滚进下一份存档（见 isResumptionPrompt）。
  const taskPrompts = humanPrompts.filter((text) => !isResumptionPrompt(text))
  const objective = goals.at(-1) ?? taskPrompts[0] ?? '（日志中未找到明确目标，请向用户确认）'
  const recentAssistant = assistantTexts.slice(-3)
  const recentTools = [...toolNames.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tool, count]) => `- ${tool}（${count} 次）`)
  const files = [...filePaths].slice(0, 20).map((file) => `- ${file}`)

  return {
    objective,
    decisions: taskPrompts.slice(1, 6).map((text, index) => `- 第 ${index + 2} 条用户指令：${truncate(text, 600)}`),
    files,
    progress: [
      `- 已完成 ${turns} 轮 / ${steps} 步；最后一轮结束原因：${lastTurnEndReason ?? '未记录'}`,
      `- 最近工具调用：${recentTools.length ? recentTools.map((line) => line.replace(/^- /, '')).join('；') : '无'}`,
      ...recentAssistant.map((text, index) => `- 最近助手结论 ${index + 1}：${truncate(text, 700)}`),
    ],
    next: recentAssistant.length
      ? `接着完成「${truncate(objective, 120)}」的剩余部分；先核对下方进度，再继续未完成的工作。`
      : `继续「${truncate(objective, 120)}」；先向用户确认下一步。`,
    tools: recentTools,
    turns,
    steps,
  }
}

function renderStateMarkdown(info, sessionId, workspaceTitle, config) {
  const lines = [
    '# PROJECT_STATE.md · 对话交接存档',
    '',
    `> 由「自动交接」插件在上下文用量达到预算的 ${Math.round(config.thresholdRatio * 100)}% 时自动生成。`,
    `> 生成时间：${new Date().toISOString()}`,
    `> 新对话请先完整读取本文件，核对后再开工。`,
    '',
    '## 1. 目标',
    info.objective,
    '',
    '## 2. 有效决定（含约束；已否决方案未在此列出）',
    ...(info.decisions.length ? info.decisions : ['- 日志中未记录到额外决定。']),
    '',
    '## 3. 关键文件',
    ...(info.files.length ? info.files : ['- 日志中未识别到明确文件路径。']),
    '',
    '## 4. 真实进度',
    ...info.progress,
    '',
    '## 5. 下一步',
    info.next,
    '',
    '## 6. 旧会话 ID（底档）',
    `- 会话 ID：${sessionId}`,
    `- 所属项目：${workspaceTitle ?? '（未识别）'}`,
    `- 细节有疑问时用会话检索工具按上述 ID 查证，不要重复通读整段旧会话。`,
    '',
  ]
  return lines.join('\n')
}

/** 反查当前 Session 属于哪个 Workspace；找不到就返回 undefined（降级为不触发）。 */
function workspaceOf(ctx, sessionId) {
  const list = ctx.workspaceRegistry.list()
  return list.find((workspace) => workspace.sessionIds.includes(sessionId))
}

/** 当前 Session 的 cwd：优先 workingDirectory.get，其次 header.cwd，再次 workspace.path。 */
function cwdOf(ctx, session, workspace) {
  try {
    const value = ctx.workingDirectory.get(session)
    if (value) return value
  } catch { /* 服务可选 */ }
  return session.header?.cwd ?? workspace?.path
}

function firstPromptText(stateFileName, sessionId) {
  return [
    `这是一次自动交接后的新对话。请先在**当前项目目录**读取交接存档 \`${stateFileName}\`，核对其中「目标 / 有效决定 / 关键文件 / 真实进度 / 下一步」后再开工。`,
    '',
    '核对要点：',
    '1. 若存档与项目当前文件状态不一致，以**项目里实际存在的文件**为准，并在回复里说明差异；',
    '2. 不要重复已完成的工作，只接着做「下一步」；',
    `3. 细节有疑问时按底档里的旧会话 ID（${sessionId}）用会话检索工具查证，不要通读整段旧会话。`,
    '',
    '请简要复述你核对后的目标与下一步，然后直接继续任务。',
  ].join('\n')
}

function answerApproved(answer, approveLabel) {
  if (!answer || !Array.isArray(answer.answers)) return false
  return answer.answers.some((item) =>
    (Array.isArray(item.selected) && item.selected.includes(approveLabel)) || item.custom === approveLabel)
}

/* ------------------------------------------------------------------ *
 * 交接后新会话的「模型 + 推理强度」
 *
 * 数据来源是 Host 的 `sessionController.modelCatalog()`（provider 分组 +
 * 每个模型可选的推理强度 + 部署默认值）。两条生效路径：
 *   1. 面板/命令里设定一次，之后每次交接自动套用（config.handoff*）；
 *   2. confirm 批准后、或用户手动要求交接时，弹卡现选一次（只影响这一次）。
 * 套用走公开 API `sessionController.selectModel()`：它按会话记录选择、从下一个
 * 步骤生效，并且会顺带把选择存成 DSH 的默认模型（用户已确认接受该副作用）。
 * 任何一步失败都只降级为「用默认模型继续交接」，绝不让选模型把交接本身弄失败。
 * ------------------------------------------------------------------ */

/** 取「面板里设定的模型」；未设置返回 null（= 不干预，沿用 DSH 默认）。 */
function configuredSelection(config) {
  const provider = String(config?.handoffProvider ?? '').trim()
  const model = String(config?.handoffModel ?? '').trim()
  if (!provider || !model) return null
  const effort = String(config?.handoffReasoningEffort ?? '').trim()
  return effort ? { provider, model, reasoningEffort: effort } : { provider, model }
}

/** 人类可读的选择描述，用于日志、NOTICE 和命令回执。 */
function describeSelection(selection) {
  if (!selection) return '沿用 DSH 默认模型'
  const base = `${selection.provider}/${selection.model}`
  return selection.reasoningEffort ? `${base}（推理强度 ${selection.reasoningEffort}）` : base
}

/** 把选择装到指定会话上；返回 { applied, error? }，永不抛。 */
async function applyHandoffSelection(ctx, sessionId, selection) {
  if (!selection) return { applied: false }
  const controller = ctx.sessionController
  if (typeof controller?.selectModel !== 'function') {
    log(ctx, '当前 DSH 未提供 sessionController.selectModel，新会话沿用默认模型')
    return { applied: false, error: 'selectModel 不可用' }
  }
  try {
    await controller.selectModel({ sessionId, ...selection })
    return { applied: true }
  } catch (error) {
    // session/model-unavailable 等拒绝不应影响交接主流程，只如实记录。
    log(ctx, `新会话模型设置失败（沿用默认模型继续交接）：${String(error?.message ?? error)}`)
    return { applied: false, error: String(error?.message ?? error) }
  }
}

/** 读模型目录；服务缺失或报错时返回 null（此时面板与命令只能手输）。 */
async function readCatalog(ctx) {
  const controller = ctx.sessionController
  if (typeof controller?.modelCatalog !== 'function') return null
  try {
    const catalog = await controller.modelCatalog()
    return catalog && Array.isArray(catalog.groups) ? catalog : null
  } catch (error) {
    log(ctx, `读取模型目录失败：${String(error?.message ?? error)}`)
    return null
  }
}

/** 目录里找某个 provider/model 条目（含推理强度列表）。 */
function findCatalogModel(catalog, providerId, modelId) {
  const group = (catalog?.groups ?? []).find((g) => g.id === providerId)
  const model = (group?.models ?? []).find((m) => m.id === modelId)
  return model ? { provider: group.id, providerName: group.name, model } : null
}

/**
 * 解析 `/handoff model <provider>/<model>` 的输入。
 * 接受 `provider/model`，也接受目录里唯一的裸 model id（省得让人背 provider）。
 * 返回 { selection } | { clear: true } | { error }。
 */
function parseModelCommand(arg, catalog) {
  const text = String(arg ?? '').trim()
  if (text === 'default' || text === 'reset' || text === '') return { clear: true }
  const slash = text.indexOf('/')
  if (slash > 0 && slash < text.length - 1) {
    const provider = text.slice(0, slash)
    const model = text.slice(slash + 1)
    const hit = catalog ? findCatalogModel(catalog, provider, model) : null
    if (catalog && !hit) return { error: `模型 ${provider}/${model} 不在当前可用目录里` }
    return { selection: { provider, model } }
  }
  // 裸 model id：只在目录里唯一命中时接受。
  const hits = []
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models ?? []) {
      if (model.id === text || model.name === text) hits.push({ provider: group.id, model: model.id })
    }
  }
  if (hits.length === 1) return { selection: { ...hits[0] } }
  if (hits.length > 1) {
    return { error: `模型 ${text} 在多个提供方下都有，请写成 provider/model：${hits.map((h) => `${h.provider}/${h.model}`).join('、')}` }
  }
  return { error: catalog ? `找不到模型 ${text}` : `需要写成 provider/model（当前读不到模型目录）` }
}

/** 解析 `/handoff effort <id>`；空/default 表示清除显式强度。 */
function parseEffortCommand(arg) {
  const text = String(arg ?? '').trim()
  if (text === 'default' || text === 'reset' || text === '') return { clear: true }
  return { effort: text }
}

const PICK_KEEP_DEFAULT = '沿用面板默认'
const PICK_EFFORT_DEFAULT = '模型默认（不指定强度）'

/** 从一次 userQuestions 回答里取选中的标签（单选；custom 覆盖 selected）。 */
function answerLabel(answer) {
  const item = answer?.answers?.[0]
  if (!item) return ''
  const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
  if (custom !== '') return custom
  return Array.isArray(item.selected) && item.selected.length > 0 ? String(item.selected[0]) : ''
}

/**
 * 交接时现选模型与推理强度（只影响这一次交接）。
 *
 * 分成两次提问：模型列表来自目录，推理强度依附于所选模型，所以必须先拿到模型。
 * 任一题超时/跳过/出错都用「面板默认」继续，绝不打断交接。
 * @returns {Promise<object|null>} 选择对象；null = 用面板默认。
 */
async function pickSelection(ctx, session, config) {
  const agent = ctx.agents?.get?.(session.id)
  if (agent === undefined) return null
  const catalog = await readCatalog(ctx)
  if (catalog === null) {
    log(ctx, '读不到模型目录，跳过交接时的模型现选，沿用面板默认')
    return null
  }

  // 展平目录，部署默认模型排在最前，最多列 8 个（卡片选项不宜过长）。
  const entries = []
  for (const group of catalog.groups) {
    for (const model of group.models ?? []) {
      entries.push({ provider: group.id, providerName: group.name, model })
    }
  }
  const defaultProvider = catalog.default?.provider
  const defaultModelId = catalog.default?.model
  entries.sort((a, b) => {
    const aDefault = a.provider === defaultProvider && a.model.id === defaultModelId ? 0 : 1
    const bDefault = b.provider === defaultProvider && b.model.id === defaultModelId ? 0 : 1
    return aDefault - bDefault
  })
  const visible = entries.slice(0, 8)
  const byLabel = new Map()
  const options = [{
    label: PICK_KEEP_DEFAULT,
    description: `用 Settings 里设定的模型：${describeSelection(configuredSelection(config))}`,
  }]
  for (const entry of visible) {
    const label = `${entry.providerName} · ${entry.model.name}`
    if (byLabel.has(label)) continue
    byLabel.set(label, entry)
    options.push({
      label,
      description: entry.model.description
        ?? (entry.provider === defaultProvider && entry.model.id === defaultModelId ? '当前默认模型' : undefined),
    })
  }

  let picked
  try {
    const answer = await ctx.userQuestions.askTimed({
      agent,
      questions: [{
        id: 'handoff-model',
        question: '交接后新建的这条对话用哪个模型？',
        detail: '只影响这一次交接。也可以直接在自定义输入里写 provider/model。选「沿用面板默认」则用设置里保存的模型。',
        header: '交接 · 模型',
        options,
      }],
    }, randomUUID(), config.confirmTimeoutMs)
    if ('pending' in answer) {
      log(ctx, '交接时选模型超时，沿用面板默认')
      return null
    }
    picked = answerLabel(answer)
  } catch (error) {
    log(ctx, `交接时选模型失败，沿用面板默认：${String(error?.message ?? error)}`)
    return null
  }
  if (!picked || picked === PICK_KEEP_DEFAULT) return null

  // 自定义输入：可能是 label，也可能是 provider/model。
  let entry = byLabel.get(picked)
  if (!entry) {
    const parsed = parseModelCommand(picked, catalog)
    if (parsed.error) {
      log(ctx, `交接时输入的模型无法识别（${parsed.error}），沿用面板默认`)
      return null
    }
    if (parsed.clear) return null
    const hit = findCatalogModel(catalog, parsed.selection.provider, parsed.selection.model)
    if (!hit) return null
    entry = { provider: hit.provider, providerName: hit.providerName, model: hit.model }
  }

  const selection = { provider: entry.provider, model: entry.model.id }
  const efforts = entry.model.reasoning?.efforts ?? []
  if (efforts.length === 0) return selection

  let effortLabel
  try {
    const answer = await ctx.userQuestions.askTimed({
      agent,
      questions: [{
        id: 'handoff-effort',
        question: `${entry.model.name} 用哪档推理强度？`,
        detail: '只影响这一次交接。「模型默认」= 不写显式强度，交给模型适配器决定。',
        header: '交接 · 推理强度',
        options: [
          { label: PICK_EFFORT_DEFAULT, description: '不指定，按模型默认强度运行' },
          ...efforts.map((effort) => ({
            label: effort.name,
            description: effort.description
              ?? (effort.id === entry.model.reasoning?.defaultEffort ? '该模型的默认强度' : undefined),
          })),
        ],
      }],
    }, randomUUID(), config.confirmTimeoutMs)
    if ('pending' in answer) {
      log(ctx, '交接时选推理强度超时，用模型默认强度')
      return selection
    }
    effortLabel = answerLabel(answer)
  } catch (error) {
    log(ctx, `交接时选推理强度失败，用模型默认强度：${String(error?.message ?? error)}`)
    return selection
  }
  if (!effortLabel || effortLabel === PICK_EFFORT_DEFAULT) return selection
  const effort = efforts.find((item) => item.name === effortLabel || item.id === effortLabel)
  if (effort) selection.reasoningEffort = effort.id
  return selection
}

/**
 * 安全写交接文档：绝不覆盖用户已有的同名文件。
 * 优先用 'wx' 原子创建；若已存在，退到带时间戳的名字，返回实际文件名。
 */
async function writeStateSafely(cwd, preferredName, markdown) {
  const target = path.join(cwd, preferredName)
  try {
    await writeFile(target, markdown, { encoding: 'utf8', flag: 'wx' })
    return preferredName
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const ext = path.extname(preferredName)
  const base = path.basename(preferredName, ext)
  const fallback = `${base}.${stamp}${ext}`
  await writeFile(path.join(cwd, fallback), markdown, { encoding: 'utf8', flag: 'wx' })
  return fallback
}

/** 交接成功后在项目目录留一份可读通知（不碰会话日志、不唤醒旧会话）。 */
async function writeNotice(cwd, stateFileName, notice) {
  const name = stateFileName.replace(/\.md$/i, '') + '.NOTICE.md'
  try {
    await writeFile(path.join(cwd, name), notice + '\n', { encoding: 'utf8', flag: 'w' })
    return name
  } catch {
    return undefined
  }
}

/**
 * 交接成功后，让「旧会话」的模型在后续每一步都看到一条系统级提示：
 * 明确告知任务已转到新会话，不要再在原会话推进，避免两个会话并行重复工作。
 *
 * 实现走 ctx.systemPrompt.context()，注册在旧会话的 agent-scoped ctx 上：
 *  - 不新增 session 事件 type，不唤醒 driver，不开新 turn；
 *  - 不需要 import @deepseek-ai/dsh-llm（链接 bundle 里解析不到 createUserMessage）；
 *  - scope 天然把这条 context 限定到该 agent，新建会话看不到；
 *  - 返回 disposer 交给 ctx.effect，插件卸载时自动撤销。
 * 缺服务 / 无 live agent / 注册失败时降级为只写日志，绝不影响已完成的新会话。
 */
function notifyOldSession(ctx, sessionId, notice) {
  const agent = ctx.agents?.get?.(sessionId)
  if (agent?.ctx === undefined || typeof ctx.systemPrompt?.context !== 'function') return false
  try {
    const scoped = agent.ctx
    const disposer = scoped.inject?.(['systemPrompt'], (scope) => scope.systemPrompt.context({
      name: 'handoff-at-75:notice',
      order: 900,
      text: notice,
      interpolate: false,
      required: true,
    }))
    if (typeof disposer === 'function') ctx.effect(() => disposer, 'handoff-at-75.notice.' + sessionId)
    return true
  } catch (error) {
    log(ctx, `旧会话提示注册失败（不影响已完成的新会话）：${String(error)}`)
    return false
  }
}

/**
 * 交接成功后**硬中止**旧会话正在执行的 turn。
 *
 * 为什么需要它：`notifyOldSession` 只往提示词里塞一段文字，属于纯软约束
 * （不唤醒 driver、不开新 turn、不打断正在跑的 turn）。实测旧会话收到
 * 「请立即停止」后仍继续跑了 40+ 分钟（继续 wait_agent、写代码、改文档）。
 *
 * 实现依据（DSH 本安装版源码）：
 *  - `@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:509` 的
 *    `cancel(request)`：`agent.cancel({ kind: 'user' }, { keepInbox: true })`，
 *    返回 `{ accepted: true }`。
 *  - `@deepseek-ai/dsh-agent/lib/index.js:21-23` 注释明确：这就是
 *    「用户自己按停止按钮」的等价物；`keepInbox: true` 会保留排队输入
 *    （归档路径才丢弃 inbox，这里选择保留，更温和）。
 *
 * 行为边界：只取消当前 turn，会话与历史完整保留，之后仍可被用户/消息唤醒；
 * 找不到 live agent（已空闲）时 cancel 会抛 session/not-found，按「无需中止」处理。
 *
 * @returns {Promise<'cancelled'|'already-idle'|'unsupported'|'failed'>}
 */
async function cancelOldSession(ctx, sessionId) {
  const agent = ctx.agents?.get?.(sessionId)
  if (agent === undefined || agent === null) return 'already-idle'
  // 空闲会话不需要中止：cancel 对非 running 的 agent 无意义。
  if (agent.status !== undefined && agent.status !== 'running') return 'already-idle'
  try {
    if (typeof ctx.sessionController?.cancel !== 'function') return 'unsupported'
    await ctx.sessionController.cancel({ sessionId })
    return 'cancelled'
  } catch (error) {
    // session/not-found 等：说明已经不是 live agent，等价于已停。
    const code = String(error?.code ?? error?.name ?? '')
    if (/not-found|NOT_FOUND/i.test(code)) return 'already-idle'
    log(ctx, `旧会话硬中止失败（不影响已完成的新会话）：${String(error)}`)
    return 'failed'
  }
}

/** 可从设置面板 / slash command 修改的字段白名单（其余字段只留在 patch 初始值里）。 */
const EDITABLE = Object.freeze([
  'mode', 'budgetTokens', 'thresholdRatio', 'rowTint',
  'handoffProvider', 'handoffModel', 'handoffReasoningEffort', 'askModelOnHandoff',
])

/**
 * 解析一次配置修改请求。
 * 接受 { mode?, budgetTokens?, thresholdRatio? } 的普通对象；逐字段用 Config 校验，
 * 拒绝未知字段与非法值，返回补丁或错误文案。绝不把用户输入原样写进 profile。
 */
export function parseConfigPatch(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: '配置必须是一个对象' }
  }
  const patch = {}
  for (const [key, value] of Object.entries(input)) {
    if (!EDITABLE.includes(key)) return { error: `字段 ${key} 不允许通过界面修改` }
    patch[key] = value
  }
  if (Object.keys(patch).length === 0) return { error: '没有要修改的字段' }
  const probe = { ...DEFAULTS, ...patch }
  const result = Config['~standard'].validate(probe)
  if (result.issues) return { error: result.issues.map((i) => i.message).join('；') }
  // 归一化后的值才是真正写入的值（例如数字字符串 → number、四舍五入）。
  for (const key of Object.keys(patch)) patch[key] = result.value[key]
  return { patch }
}

/** 通过 configEditor 把补丁写进用户 profile 覆盖层；缺服务/被拒时返回明确失败。 */
async function setConfig(ctx, input) {
  const parsed = parseConfigPatch(input)
  if (parsed.error) return { ok: false, error: parsed.error }
  const entry = ctx.fiber?.entry
  const editor = ctx.get?.('configEditor')
  if (entry === undefined || editor === undefined) {
    return { ok: false, error: '此 profile 不支持保存配置（configEditor 不可用）' }
  }
  try {
    await editor.edit(entry, (current) => ({ ...current, ...parsed.patch }))
    // 保存成功后把最新值并回内存快照。currentOf(ctx) 原本是 apply 时捕获的旧值：
    // 不更新会让连续两次保存的第二次把第一次的改动退回界面，GET 也会一直返回初始值
    // （用户点「刷新」就误以为没保存）。Loader 重载插件时 apply 会用 profile 里的
    // 新值重新初始化 __handoffConfig，与此保持一致。
    const next = { ...currentOf(ctx), ...parsed.patch }
    ctx.__handoffConfig = next
    return { ok: true, config: next }
  } catch (error) {
    // configuration.md：写入被更高层覆盖 / 校验失败时必须如实报告，不能声称已保存。
    return { ok: false, error: `配置未保存：${String(error?.message ?? error)}` }
  }
}

/** 当前已生效的配置（面板展示用）；rawConfig 在 apply 里闭包捕获。 */
function currentOf(ctx) {
  return ctx.__handoffConfig ?? {}
}

function configSummary(config, patch) {
  const next = { ...config, ...patch }
  const lines = [
    `模式：${next.mode}（${next.mode === 'auto' ? '全自动' : next.mode === 'confirm' ? '先询问' : '停用'}）`,
    `预算：${next.budgetTokens} tokens`,
    `触发比例：${next.thresholdRatio}（触发点约 ${Math.round(next.budgetTokens * next.thresholdRatio)} tokens）`,
    `监测状态：${next.mode === 'off' ? '未监测' : '监测中'}`,
    `侧栏四色染色：${next.rowTint === false ? '关闭' : '开启'}`,
    `交接新会话模型：${describeSelection(configuredSelection(next))}`,
    `交接时现选模型：${next.askModelOnHandoff === false ? '关闭' : '开启（先询问 / 手动交接时弹卡）'}`,
  ]
  // 只有真正写入了补丁才提示「已写入 / 重载后生效」；status 是纯查询，不能这么陈述。
  if (patch && Object.keys(patch).length) {
    lines.push('已写入用户 profile 的覆盖层，插件重载后生效。')
  }
  return lines.join('\n')
}

/** /handoff 命令的输入解析：status / auto|confirm|off / budget N / ratio R / model / effort / ask。 */
export function parseCommandInput(raw) {
  const text = String(raw ?? '').trim()
  if (!text || text === 'status') return { kind: 'status' }
  const parts = text.split(/\s+/)
  const head = parts[0].toLowerCase()
  if (['auto', 'confirm', 'off'].includes(head) && parts.length === 1) {
    return { kind: 'patch', patch: { mode: head } }
  }
  if (head === 'budget' && parts.length === 2) {
    return { kind: 'patch', patch: { budgetTokens: Number(parts[1]) } }
  }
  if (head === 'ratio' && parts.length === 2) {
    return { kind: 'patch', patch: { thresholdRatio: Number(parts[1]) } }
  }
  if (head === 'model') {
    return { kind: 'model', arg: parts.slice(1).join(' ').trim() }
  }
  if (head === 'effort') {
    return { kind: 'effort', arg: parts.slice(1).join(' ').trim() }
  }
  if (head === 'ask' && parts.length === 2 && ['on', 'off'].includes(parts[1].toLowerCase())) {
    return { kind: 'patch', patch: { askModelOnHandoff: parts[1].toLowerCase() === 'on' } }
  }
  return { kind: 'help' }
}

function commandHelp() {
  return [
    '用法：',
    '  /handoff status                 查看当前配置',
    '  /handoff auto | confirm | off  切换「自动 / 提醒 / 停用」',
    '  /handoff budget 150000         设置 token 预算',
    '  /handoff ratio 0.75            设置触发比例（0.1~1）',
    '  /handoff model                 查看/设置新会话模型（provider/model 或 default）',
    '  /handoff effort <档位>         设置推理强度（default 清除，用模型默认）',
    '  /handoff ask on | off          交接时是否弹卡现选模型',
    '设置也可在 Settings → 自动交接 面板里用图形控件完成。',
  ].join('\n')
}

/**
 * 把 `/handoff model ...` / `/handoff effort ...` 解析成配置补丁。
 * 两类命令都要对着实时模型目录校验（模型必须可用、强度必须是该模型支持的档位），
 * 校验不过给明确错误，绝不写入一个到交接时才失败的值。
 * @returns {Promise<{patch?:object, error?:string}>}
 */
async function resolveModelCommand(ctx, config, parsed) {
  const catalog = await readCatalog(ctx)

  if (parsed.kind === 'model') {
    const result = parseModelCommand(parsed.arg, catalog)
    if (result.error) return { error: result.error }
    if (result.clear) {
      return { patch: { handoffProvider: '', handoffModel: '', handoffReasoningEffort: '' } }
    }
    const { provider, model } = result.selection
    // 换模型时旧强度可能不再适用：只在新模型确实支持同一档时才保留。
    const hit = catalog ? findCatalogModel(catalog, provider, model) : null
    const previous = String(config.handoffReasoningEffort ?? '')
    const efforts = hit?.model?.reasoning?.efforts ?? []
    const keep = previous === ''
      ? undefined
      : efforts.find((effort) => effort.id === previous || effort.name === previous)
    return {
      patch: {
        handoffProvider: provider,
        handoffModel: model,
        handoffReasoningEffort: keep?.id ?? '',
      },
    }
  }

  const result = parseEffortCommand(parsed.arg)
  if (result.clear) return { patch: { handoffReasoningEffort: '' } }

  const provider = String(config.handoffProvider ?? '').trim()
  const model = String(config.handoffModel ?? '').trim()
  if (!provider || !model) {
    return { error: '请先设置模型（/handoff model provider/model），推理强度依附于模型' }
  }
  const hit = catalog ? findCatalogModel(catalog, provider, model) : null
  if (hit === null) {
    return { error: catalog ? '当前设置的模型已不在可用目录里，请重新设置模型' : '读不到模型目录，暂时无法校验推理强度' }
  }
  const efforts = hit.model.reasoning?.efforts ?? []
  if (efforts.length === 0) return { error: `${hit.model.name} 不支持设置推理强度` }
  const match = efforts.find((effort) => effort.id === result.effort || effort.name === result.effort)
  if (!match) {
    return { error: `未知档位 ${result.effort}，可选：${efforts.map((effort) => effort.id).join(' / ')}` }
  }
  return { patch: { handoffReasoningEffort: match.id } }
}

/**
 * 注册两个「可见配置面」共用的入口：
 *  - /handoff slash command（不进设置页也能改）
 *  - GET/POST /api/auto-handoff/config 已认证 Fetch 路由（供 Client 面板读写）
 * 二者都调同一个 setConfig()，避免 UI 与命令各写一份逻辑。
 * 服务缺失时安静跳过，不影响交接主逻辑（现有测试即缺这些服务）。
 */
function registerConfigSurfaces(ctx, config) {
  ctx.__handoffConfig = config

  ctx.inject?.(['commands'], (scoped) => {
    scoped.effect(() => scoped.commands.register({
      name: 'handoff',
      description: '自动交接：查看/切换模式、设置预算与阈值',
      input: { hint: 'status | auto | confirm | off | budget N | ratio R' },
      handler: async (invocation) => {
        const parsed = parseCommandInput(invocation.rawInput)
        if (parsed.kind === 'help') return { kind: 'success', text: commandHelp() }
        if (parsed.kind === 'status') return { kind: 'success', text: configSummary(currentOf(ctx), {}) }

        // 模型与推理强度要对着实时目录校验，所以单独解析；其余字段直接走 setConfig。
        let patch = parsed.patch
        if (parsed.kind === 'model' || parsed.kind === 'effort') {
          const resolved = await resolveModelCommand(ctx, currentOf(ctx), parsed)
          if (resolved.error) return { kind: 'error', text: resolved.error }
          patch = resolved.patch
        }
        const result = await setConfig(ctx, patch)
        return result.ok
          ? { kind: 'success', text: configSummary(currentOf(ctx), result.config) }
          : { kind: 'error', text: result.error }
      },
    }), 'handoff-at-75.command')
  })

  // Client 面板走「已认证的 connection.fetch 通道」：/api 由 dsh-client-connection
  // 以 prefix 路由挂载并做 peer 鉴权，exact Fetch 路由在 gateway 检查前命中，
  // 比裸 webServer 路由更贴合 Host 的访问模型。
  // 契约照抄 dsh-api-session-controller/src/media-references.ts:77-82 的 /api/file。
  ctx.inject?.(['connection'], (scoped) => {
    const fetchRegistry = scoped.get?.('connection')?.fetch
    if (fetchRegistry === undefined) return
    const json = (value, status = 200) => Response.json(value, {
      status,
      headers: { 'cache-control': 'no-store' },
    })
    const route = {
      path: '/api/auto-handoff/config',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          if (request.method === 'POST') {
            let input
            try { input = await request.json() }
            catch (error) { return json({ ok: false, error: `请求体不是合法 JSON：${String(error?.message ?? error)}` }, 400) }
            const result = await setConfig(ctx, input)
            return json(result.ok
              ? { ok: true, config: result.config, editable: [...EDITABLE] }
              : { ok: false, error: result.error }, result.ok ? 200 : 400)
          }
          return json({ ok: true, config: { ...currentOf(ctx) }, editable: [...EDITABLE] })
        } catch (error) {
          return json({ ok: false, error: String(error?.message ?? error) }, 500)
        }
      },
    }
    scoped.effect(() => fetchRegistry.register(route), 'handoff-at-75.route')

    // 面板的「模型 / 推理强度」下拉需要实时目录（provider 分组、每模型可选强度、
    // 以及部署默认值）。单独一条只读路由，避免把目录塞进每次配置读写。
    scoped.effect(() => fetchRegistry.register({
      path: '/api/auto-handoff/models',
      methods: ['GET'],
      fetch: async () => {
        const catalog = await readCatalog(ctx)
        if (catalog === null) {
          return json({ ok: false, error: '当前 DSH 未提供模型目录（sessionController.modelCatalog），请用 /handoff model 命令设置' }, 501)
        }
        return json({
          ok: true,
          default: catalog.default ?? null,
          groups: (catalog.groups ?? []).map((group) => ({
            id: group.id,
            name: group.name,
            models: (group.models ?? []).map((model) => ({
              id: model.id,
              name: model.name,
              ...model.description === undefined ? {} : { description: model.description },
              ...model.reasoning === undefined ? {} : {
                reasoning: {
                  efforts: (model.reasoning.efforts ?? []).map((effort) => ({ id: effort.id, name: effort.name })),
                  ...model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
                },
              },
            })),
          })),
        })
      },
    }), 'handoff-at-75.models.route')
  })
}

/**
 * 从标题尾部解析交接后缀，返回 { base, n }。
 * 只有形如「X-1」~「X-99」的尾缀才算交接后缀；「项目-2024」这类年份、
 * 或没有同 base 兄弟会话的尾缀一律当整串 base，避免误伤正常标题（架构师决策 §6）。
 */
function parseHandoffTitle(title) {
  const text = String(title ?? '').trim()
  const match = text.match(/^(.*?)[-\s](\d{1,2})$/)
  if (!match) return { base: text, n: 0 }
  const n = Number(match[2])
  if (n < 1 || n > 99) return { base: text, n: 0 }
  return { base: match[1].trim(), n }
}

/**
 * 计算交接新会话标题：延续旧标题 + `-N` 后缀。
 * - 旧无后缀 → -1；旧带 -N → N+1；
 * - 再扫同 workspace 其它会话标题取同 base 的最大 N，避免两条链重号；
 * - 超长时保留后缀、截断 base，保证 -N 始终可见。
 * 读标题走注入的 sessionTitle 服务（本插件是 symlink 安装，不能 import @deepseek-ai/*）。
 */
function nextHandoffTitle(ctx, session, workspace, sessionTitle) {
  const oldTitle = sessionTitle?.get?.(session)?.title
  const { base: rawBase, n: oldN } = parseHandoffTitle(oldTitle)
  const base = rawBase || workspace?.title || '交接对话'

  let maxN = oldN
  try {
    const ids = (workspace?.sessionIds ?? []).filter((sid) => sid !== session.id)
    for (const sid of ids) {
      const peer = ctx.sessions?.get?.(sid)
      if (!peer || typeof peer !== 'object') continue
      const title = sessionTitle?.get?.(peer)?.title
      if (!title) continue
      const parsed = parseHandoffTitle(title)
      if (parsed.base === base && parsed.n > maxN) maxN = parsed.n
    }
  } catch { /* 扫描失败不影响用 oldN 递增 */ }

  const suffix = `-${maxN + 1}`
  const maxLen = 60
  const kept = Math.max(1, maxLen - suffix.length)
  const shortBase = base.length > kept ? base.slice(0, kept).trimEnd() : base
  return shortBase + suffix
}

/**
 * 执行一次交接：写交接文档 → 同 Workspace 新建会话 → 发首条提示词 → 提示旧会话 + 硬中止。
 *
 * 抽成独立函数是因为有两条触发路径共用它：
 *  - 自动（`maybeHandoff`）：上下文达到阈值后触发；
 *  - 手动（`user/message` 里的「开个新对话继续此任务」）：用户明确要求，不检查阈值与 mode。
 *
 * @param {object} ctx - 插件上下文
 * @param {object} session - 旧会话
 * @param {object} config - 已解析配置
 * @param {{used:number, threshold:number, title?:string, reason:string, trigger?:'auto'|'manual', selection?:object|null}} options
 *   `selection` 是「这一次现选」的模型（{provider, model, reasoningEffort?}）；
 *   缺省/为 null 时回落到 config 里存的面板默认值，仍未设置则沿用 DSH 默认模型。
 * @returns {Promise<boolean>} 是否完成交接（false 表示因缺 workspace/cwd/写盘失败而中止）
 */
async function performHandoff(ctx, session, config, options) {
  const id = session.id
  const used = Number(options.used ?? 0)
  const threshold = Number(options.threshold ?? 0)
  const trigger = options.trigger ?? 'auto'
  const isManual = trigger === 'manual'

  const workspace = workspaceOf(ctx, id)
  if (workspace === undefined) {
    log(ctx, '当前会话不属于任何 Workspace，无法保证「同项目」，跳过交接')
    return false
  }

  const info = extractHandoff(session)
  const cwd = cwdOf(ctx, session, workspace)
  if (!cwd) {
    log(ctx, '无法确定项目目录，跳过交接')
    return false
  }

  const markdown = renderStateMarkdown(info, id, workspace.title, config)
  let stateFileName
  try {
    stateFileName = await writeStateSafely(cwd, config.stateFileName, markdown)
  } catch (error) {
    log(ctx, `交接文档写入失败，中止交接：${String(error)}`)
    return false
  }
  const statePath = path.join(cwd, stateFileName)

  const { sessionId: newSessionId } = await ctx.sessionController.create({ workspaceId: workspace.id })

  // 模型与推理强度：必须在首条提示词之前装好，否则新会话第一轮就会用默认模型跑。
  // options.selection 是「这次现选」的结果；没现选就用面板里存的默认值。
  const selection = options.selection ?? configuredSelection(config)
  const applied = await applyHandoffSelection(ctx, newSessionId, selection)
  const selectionLine = applied.applied
    ? `- 新会话模型：${describeSelection(selection)}`
    : applied.error !== undefined
      ? `- 新会话模型：设置失败（${applied.error}），沿用默认模型`
      : '- 新会话模型：沿用 DSH 默认模型'

  // 标题续接：延续旧标题 + `-N` 后缀。必须在 prompt 之前 rename——
  // rename 写入 source.kind='user' 会钉住标题，阻止首条提示词触发 LLM 自动命名
  // （否则标题会变成「请读取交接存档…」这类怪文本）。失败时降级，不阻断交接。
  const newTitle = nextHandoffTitle(ctx, session, workspace, ctx.sessionTitle)
  let titleApplied = false
  try {
    await ctx.sessionController.rename({ sessionId: newSessionId, title: newTitle })
    titleApplied = true
    log(ctx, `新会话标题续接为「${newTitle}」`)
  } catch (error) {
    log(ctx, `新会话标题设置失败（保留自动命名），不影响交接：${String(error)}`)
  }

  const promptText = firstPromptText(stateFileName, id)
  await ctx.sessionController.prompt({
    requestId: randomUUID(),
    sessionId: newSessionId,
    mode: 'queue',
    content: [{ type: 'text', text: promptText }],
  }, new AbortController().signal)

  const reasonLine = isManual
    ? '触发原因：用户在对话中明确要求「开个新对话继续此任务」'
    : `触发时上下文用量：约 ${used} tokens（预算 ${config.budgetTokens}，阈值 ${Math.round(threshold)}）`

  // 双通道反馈：① 旧会话模型每步可见的系统级提示（不唤醒 driver、不新增事件）；
  // ② 项目目录里的 .NOTICE.md，给用户留一份可读记录。
  const modelNotice = [
    isManual
      ? '[手动交接 · 已执行] 用户在本对话中要求「开个新对话继续此任务」，任务已在**同一项目**下新建对话继续。'
      : '[自动交接 · 已执行] 本对话上下文已达阈值，任务已在**同一项目**下新建对话继续。',
    `- 新会话 ID：${newSessionId}（请引导用户切到侧栏这条新对话继续）`,
    selectionLine,
    `- 交接文档：${statePath}`,
    '- 请立即停止在本对话推进原任务，不要再调用工具或修改文件，避免两个会话并行、重复工作；',
    '  若用户还想补充信息，请提示他到新对话里说。本条提示由插件注入，不是用户的指令。',
  ].join('\n')
  const injected = notifyOldSession(ctx, id, modelNotice)
  // 先注入提示（保证旧会话即便被重新唤醒也能看到交接信息），再硬中止当前 turn。
  // 只靠提示是软约束，实测旧会话会继续跑 40+ 分钟，所以必须真正 cancel。
  const stopped = await cancelOldSession(ctx, id)

  const notice = [
    isManual ? '# 手动交接 · 已执行' : '# 自动交接 · 已执行',
    '',
    `- 原会话 ID：${id}`,
    `- 新会话 ID：${newSessionId}（请切到侧栏这条新对话继续任务）`,
    ...(titleApplied ? [`- 新会话标题：**${newTitle}**（延续上一对话并加序号）`] : []),
    selectionLine,
    `- 交接文档：${statePath}`,
    `- ${reasonLine}`,
    '- 请不要再在原会话继续推进该任务，避免两个会话并行、重复工作；如需补充信息，请直接在新对话里说。',
    '',
    injected
      ? '> 本文件由插件生成；旧会话已收到系统级提示。'
      : '> 本文件由插件生成；旧会话模型未能收到系统级提示（仅日志），请尽快手动切换。',
    stopped === 'cancelled'
      ? '> 旧会话正在执行的这一轮已被**硬中止**（等价于用户按停止按钮），不会再继续调用工具。'
      : stopped === 'already-idle'
        ? '> 旧会话当时处于空闲状态，无需中止。'
        : stopped === 'unsupported'
          ? '> 当前 DSH 未提供 sessionController.cancel，旧会话仅收到文字提示，可能仍会跑完当前这一轮。'
          : '> 硬中止旧会话失败（见日志），旧会话仅收到文字提示，可能仍会跑完当前这一轮。',
  ].join('\n')
  const noticeName = await writeNotice(cwd, stateFileName, notice)
  log(ctx, `${isManual ? '手动' : '自动'}交接完成：${id} → ${newSessionId}（文档 ${statePath}，通知 ${noticeName ?? '写入失败'}，旧会话提示 ${injected ? '已注入' : '降级'}，旧会话中止 ${stopped}，模型 ${describeSelection(selection)}${applied.applied ? '' : '（未生效）'}${isManual ? '' : `，已用 ${used}/${config.budgetTokens}`}）`)
  return true
}

/**
 * 判断一条 `user/message` 是否是「用户手输」的、要求交接对话的指令。
 *
 * 为什么只认手输：DSH 会给 `user/message` 标 `source.kind`。插件自己发的
 * 首条提示词（`sessionController.prompt`）和系统提示都不是人类输入，
 * 若不加判别会导致新会话一收到交接提示就再次触发交接，形成无限链。
 *
 * 关键词设计：用户说法很随意（「开个新对话继续此任务」「新建对话接着做」
 * 「交接一下」），所以用「动作 + 对象」两组词共现判定，避免单字误判。
 * 只检查最后一条用户消息，且限制长度，避免长篇正文里偶然提到就触发。
 *
 * @param {object} session - 会话
 * @param {object} event - session/event 事件
 * @returns {boolean}
 */
export function isHandoffRequest(session, event) {
  if (event?.type !== 'user/message') return false
  const message = event.data
  if (message === null || typeof message !== 'object') return false
  if (message.role !== 'user') return false
  // 只认人类输入：插件/系统注入的消息带其他 kind，不能自己触发自己。
  const kind = message.source?.kind
  if (kind !== 'user') return false

  const content = Array.isArray(message.content) ? message.content : []
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
  if (text === '') return false
  // 长文本多半是正常任务描述，偶含关键词不该触发交接。真实指令都很短。
  if (text.length > 120) return false

  // 判定拆成三个独立条件，比一条复合正则更好维护、更好测：
  //   A) 「新对话/新会话」的创建动作（开/新建/另起/新开）
  //   B) 「继续/接着」的延续动作 —— 有它才说明要接着原任务
  //   C) 整句就是「开个新对话」这种纯指令（无 B 也接受）
  // 同时覆盖两种语序：「开个新对话」与「新开一个对话」。
  const createsNewChat = /(新\s*开|开|新建|创建|另起|起)\s*.{0,6}\s*(新\s*)?(的\s*)?(对话|会话|聊天)|(new\s*(session|conversation|chat))/i
  const continuesTask = /(继续|接着|接续|沿用|延续|保持)\s*.{0,6}(任务|工作|活|做|干|搞|上下文|对话|会话)|此任务|这个任务|原任务|continue/i
  // 句末光秃秃一个「继续 / 接着」也算（口语常见：「开个新对话继续」）。
  const trailingContinue = /(继续|接着|接续)\s*[。.!！]?\s*$/i
  const bareCommand = /^\s*(请\s*)?(帮我\s*)?(新\s*开|开|新建|创建|另起|起)\s*.{0,6}\s*(新\s*)?(的\s*)?(对话|会话|聊天)\s*[。.!！]?\s*$/i
  // 「交接 / handoff」本身已是明确指令，不再要求对象词；
  // 但要排除两类误判：
  //   ① 「交接逻辑/机制/代码」——在讨论实现，不是下指令；
  //   ② 「交接存档/文档/提示」——交接文档首条提示词里就有这些词，
  //      若误判会让新会话一启动就再次触发，形成无限交接链。
  if (/交接|handoff/i.test(text)
    && !/交接\s*(逻辑|机制|功能|模块|代码|问题|点|实现|存档|文档|简报|提示|摘要|内容)/i.test(text)
    && !/(读取|阅读|看|按|依据|参照)\s*.{0,4}\s*交接/i.test(text)) return true
  if (!createsNewChat.test(text)) return false
  return continuesTask.test(text) || trailingContinue.test(text) || bareCommand.test(text)
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const mode = config.mode

  // 配置面必须在 off 之前注册：否则用户停用后就没有任何入口把它重新打开。
  registerConfigSurfaces(ctx, config)

  if (mode === 'off') {
    log(ctx, 'mode=off，未注册任何监听（配置入口仍可用）')
    return
  }

  const APPROVE = '确认交接'
  const decline = '暂不交接'
  const suppress = '本代不再提醒'

  const maybeHandoff = async (session) => {
    const id = session.id
    const state = stateFor(id)
    // fired = 已交接；suppressed = 用户明确拒绝/超时，避免每轮重复弹卡。
    if (state.pending || state.fired || state.suppressed) return
    // 交接只面向普通根会话：子 Agent 的会话由父会话接管，不该自己另起一条。
    if (session.header?.origin === 'subagent') return

    let measurement
    let window
    try {
      measurement = ctx.tokenMeter.measure(session)
      window = ctx.tokenMeter.contextPressure(session).contextWindow
        ?? session.requestContext?.()?.contextWindow
    } catch (error) {
      log(ctx, `用量读取失败，跳过本次检查：${String(error)}`)
      return
    }
    const used = Number(measurement?.totalTokens ?? 0)
    const capacity = Number(window ?? 0)
    if (!Number.isFinite(used) || used <= 0) return

    if (capacity > 0) state.lastWindow = capacity
    const threshold = Math.max(0, config.budgetTokens * config.thresholdRatio)
    const ratioOfCapacity = capacity > 0 ? used / capacity : 0

    // 压缩后用量明显回落 → 重新武装，允许下一个世代再触发一次（同时清掉抑制）。
    if ((state.fired || state.suppressed) && ratioOfCapacity > 0 && ratioOfCapacity <= config.rearmRatio) {
      state.fired = false
      state.suppressed = false
    }
    if (state.fired || state.suppressed || used < threshold) return

    state.pending = true
    try {
      if (mode === 'confirm') {
        const agent = ctx.agents?.get?.(id)
        if (agent === undefined) {
          log(ctx, 'confirm 模式下找不到 live agent，本次跳过（避免弹出无人应答的卡片）')
          return
        }
        const result = await ctx.userQuestions.askTimed({
          agent,
          questions: [{
            id: 'handoff',
            question: `上下文已用约 ${used} tokens（预算 ${config.budgetTokens}，阈值 ${Math.round(threshold)}）。要现在在同项目下新建对话继续任务吗？`,
            detail: '插件会先把交接文档写入项目目录，再新建对话并让它读文档继续。选「本代不再提醒」则本次压缩世代内不再询问。',
            header: '自动交接',
            options: [
              { label: APPROVE, description: '生成交接文档、新建对话并自动开跑' },
              { label: decline, description: '本次不交接' },
              { label: suppress, description: '本次压缩世代内不再提醒' },
            ],
          }],
        }, randomUUID(), config.confirmTimeoutMs)
        if ('pending' in result || !answerApproved(result, APPROVE)) {
          // 超时/暂不交接只抑制到下一个事件；明确选「本代不再提醒」才持久抑制。
          const choseSuppress = !('pending' in result) && answerApproved(result, suppress)
          if (choseSuppress) state.suppressed = true
          log(ctx, choseSuppress ? '用户选择本代不再提醒' : '用户未批准或询问超时，本次不交接')
          return
        }
      }

      // 现选模型：只在「有人刚在场」的路径上发生——confirm 模式刚被用户批准，
      // 或用户亲口要求交接（见 manualHandoff）。auto 模式必须保持无人值守，
      // 不能为了选模型把自动交接卡在一次超时上，所以那里只用面板默认值。
      let selection
      if (mode === 'confirm' && config.askModelOnHandoff) {
        selection = await pickSelection(ctx, session, config)
      }

      const ok = await performHandoff(ctx, session, config, {
        used,
        threshold,
        selection,
        reason: `上下文已用约 ${used} tokens（预算 ${config.budgetTokens}，阈值 ${Math.round(threshold)}）`,
      })
      if (ok) state.fired = true
    } catch (error) {
      log(ctx, `交接失败，保持当前对话：${String(error)}`)
    } finally {
      state.pending = false
    }
  }

  // 功能 A：从 durable 事件里保守采集「失败 / 额度用尽」，供侧栏行标红。
  // 只认 turn/end.reason.kind==='error' 这一权威终态；额度只认精确 code 白名单。
  // 新一轮 turn/start 或正常结束立即清除，杜绝陈旧红；aborted（用户取消）绝不标红。
  const trackRowError = (session, event) => {
    const sid = session?.id
    if (!sid) return
    if (event.type === 'turn/start') {
      rowErrorBySession.delete(sid)
      return
    }
    if (event.type !== 'turn/end') return
    const reason = event.data?.reason ?? {}
    if (reason.kind !== 'error') {
      rowErrorBySession.delete(sid) // completed / aborted / blocked / max-tokens 都清除
      return
    }
    const code = String(reason.error?.code ?? '')
    const quota = code === 'QUOTA' || code === 'ACCOUNT_QUOTA'
    rowErrorBySession.set(sid, quota ? 'quota' : 'failed')
  }

  // 锚在 durable 事件上；assistant/message 携带 usage，turn/end 表示整轮收口。
  // 不 poll agent/status，不用 whenIdle 判定。新建的会话初始用量很低，不会自我触发。
  const check = (session, event) => {
    trackRowError(session, event)
    // 手动触发：用户在对话里说「开个新对话继续此任务」。
    // 这条路径不检查阈值与 mode（off 已在上面提前 return），因为是用户明确要求。
    if (event.type === 'user/message' && isHandoffRequest(session, event)) {
      void manualHandoff(session)
      return
    }
    if (event.type !== 'assistant/message' && event.type !== 'turn/end') return
    void maybeHandoff(session)
  }

  /**
   * 手动交接：用户用一句话明确要求时立即执行，不等待阈值、不弹确认卡，
   * 也不受 `mode=confirm` 影响（用户已经亲口说了，再问一次是多余）。
   */
  const manualHandoff = async (session) => {
    const id = session.id
    const state = stateFor(id)
    // 同一会话只交一次；pending 用于防抖（一句提示词可能拆成多条消息）。
    if (state.pending || state.fired) {
      log(ctx, '手动交接：本会话已交接或正在交接，忽略重复请求')
      return
    }
    if (session.header?.origin === 'subagent') {
      log(ctx, '手动交接：子 Agent 会话不单独交接，忽略')
      return
    }
    state.pending = true
    try {
      let used = 0
      let threshold = 0
      try {
        used = Number(ctx.tokenMeter.measure(session)?.totalTokens ?? 0)
        threshold = Math.max(0, config.budgetTokens * config.thresholdRatio)
      } catch { /* 用量读取失败不影响手动交接 */ }

      log(ctx, `手动交接：收到用户请求，开始执行（当前约 ${used} tokens）`)
      // 用户就在场，顺手让他给这次交接挑个模型；超时/跳过都回落面板默认。
      const selection = config.askModelOnHandoff ? await pickSelection(ctx, session, config) : undefined
      const ok = await performHandoff(ctx, session, config, {
        used,
        threshold,
        selection,
        trigger: 'manual',
        reason: '用户在对话中明确要求「开个新对话继续此任务」',
      })
      if (ok) {
        state.fired = true
        log(ctx, '手动交接完成')
      } else {
        log(ctx, '手动交接未完成（缺 workspace 或项目目录，见上方日志）')
      }
    } catch (error) {
      log(ctx, `手动交接失败，保持当前对话：${String(error)}`)
    } finally {
      state.pending = false
    }
  }

  // 功能 A：把保守采集到的失败/额度状态暴露给 Client（侧栏行染色用）。
  // 走已认证的 connection.fetch 通道；服务缺失时静默跳过（测试与旧版 DSH 均无碍）。
  ctx.inject?.(['connection'], (scoped) => {
    const fetchRegistry = scoped.get?.('connection')?.fetch
    if (fetchRegistry === undefined) return
    scoped.effect(() => fetchRegistry.register({
      path: '/api/auto-handoff/row-status',
      methods: ['GET'],
      fetch: () => Response.json({
        ok: true,
        statuses: Object.fromEntries(rowErrorBySession),
      }, { headers: { 'cache-control': 'no-store' } }),
    }), 'handoff-at-75.row-status.route')
  })

  const disposeListener = ctx.on('session/event', (session, event) => check(session, event), { global: true })
  const disposeDisposed = ctx.on('session/disposed', (session) => {
    stateBySession.delete(session?.id)
    rowErrorBySession.delete(session?.id)
  }, { global: true })

  ctx.effect(() => () => {
    disposeListener()
    disposeDisposed()
    stateBySession.clear()
    rowErrorBySession.clear()
  }, 'handoff-at-75.listeners')
  log(ctx, `已启动：mode=${mode}，预算 ${config.budgetTokens} × ${config.thresholdRatio} = ${Math.round(config.budgetTokens * config.thresholdRatio)} tokens`)
}

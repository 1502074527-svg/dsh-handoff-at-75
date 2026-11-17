import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as plugin from '../index.js'

const root = await mkdtemp(path.join(tmpdir(), 'handoff-test-'))
const cwd = path.join(root, 'project')
await import('node:fs/promises').then(fs => fs.mkdir(cwd, { recursive: true }))
await writeFile(path.join(cwd, 'existing.txt'), 'seed', 'utf8')

const listeners = new Map()
function makeCtx(overrides = {}) {
  const calls = {
    created: [], prompts: [], logs: [], questions: [], contexts: [], effects: [],
    cancelled: [], renamed: [], selected: [], order: [],
  }
  const sessionId = overrides.sessionId ?? 'old-session'
  const workspace = { id: 'ws-1', title: '测试项目', path: cwd, sessionIds: [sessionId] }
  // 模拟 agent-scoped ctx：scoped.inject(['systemPrompt'], fn) 会把注册的内容记下来，
  // 并返回一个 disposer；真机上 systemPrompt.context() 就挂在这个 scope 层上。
  const scopedCtx = {
    inject: (deps, fn) => {
      assert.deepEqual(deps, ['systemPrompt'])
      const entry = { name: undefined, text: undefined, interpolate: undefined, required: undefined }
      const sp = { context: (c) => { Object.assign(entry, c); calls.contexts.push(entry); return () => {} } }
      fn({ systemPrompt: sp })
      return () => {}
    },
  }
  const ctx = {
    logger: { info: (m) => calls.logs.push(m) },
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1) }
    },
    effect(fn, label) { const d = fn(); calls.effects.push({ label, disposer: d }); return d },
    tokenMeter: {
      measure: () => ({ totalTokens: overrides.used ?? 120000 }),
      contextPressure: () => ({ contextWindow: 1000000 }),
    },
    workspaceRegistry: { list: () => [workspace] },
    workingDirectory: { get: () => cwd },
    sessionController: {
      create: async (req) => { calls.created.push(req); calls.order.push('create'); return { sessionId: 'new-session' } },
      prompt: async (req) => { calls.prompts.push(req); calls.order.push('prompt'); return { accepted: true } },
      // 交接时套用「模型 + 推理强度」（公开 API）。overrides.selectThrows 可模拟被拒绝。
      selectModel: async (req) => {
        calls.selected.push(req)
        calls.order.push('select')
        if (overrides.selectThrows !== undefined) throw overrides.selectThrows
        return { selected: req }
      },
      // Host 的实时模型目录；目录含两个强度的模型、一个无强度的模型和一个第二提供方。
      modelCatalog: async () => {
        if (overrides.catalogThrows !== undefined) throw overrides.catalogThrows
        return overrides.catalog ?? {
          default: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' },
          groups: [
            {
              id: 'deepseek', name: 'DeepSeek', models: [
                {
                  id: 'deepseek-chat', name: 'DeepSeek Chat',
                  reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }], defaultEffort: 'medium' },
                },
                { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
              ],
            },
            {
              id: 'other', name: 'Other', models: [
                { id: 'gpt-x', name: 'GPT X', reasoning: { efforts: [{ id: 'high', name: '高' }] } },
              ],
            },
          ],
        }
      },
      // 硬中止旧会话（等价用户按停止按钮）。默认成功；overrides.cancelThrows 可模拟失败。
      cancel: async (req) => {
        calls.cancelled.push(req)
        if (overrides.cancelThrows !== undefined) throw overrides.cancelThrows
        return { accepted: true }
      },
      rename: async (req) => {
        calls.renamed.push(req)
        calls.order.push('rename')
        if (overrides.renameThrows !== undefined) throw overrides.renameThrows
        return { title: req.title, seq: 1 }
      },
    },
    // 标题服务：get(session) 返回 {title}。测试里用 session.title 或 overrides.titles[session.id]。
    sessionTitle: {
      get: (s) => {
        const t = overrides.titles?.[s?.id] ?? s?.title
        return t ? { title: t } : undefined
      },
    },
    // status='running' 是真实场景（旧会话正在跑 turn）；overrides.agentStatus 可改为 idle / 省略。
    agents: {
      get: (sid) => (overrides.noLiveAgent === true
        ? undefined
        : { id: sid, status: overrides.agentStatus ?? 'running', ctx: scopedCtx }),
    },
    systemPrompt: { context: () => () => {} },
    userQuestions: {
      askTimed: async (req) => {
        calls.questions.push(req)
        const id = req.questions?.[0]?.id
        // 交接时「现选模型」两问：默认走「沿用面板默认」，按 id 精确匹配，
        // 避免把「确认交接」这类别处的默认答案误当模型选择。
        if (id === 'handoff-model') {
          return overrides.modelAnswer ?? { answers: [{ id, selected: ['沿用面板默认'] }] }
        }
        if (id === 'handoff-effort') {
          return overrides.effortAnswer ?? { answers: [{ id, selected: ['模型默认（不指定强度）'] }] }
        }
        return overrides.answer ?? { answers: [{ id: 'handoff', selected: ['确认交接'] }] }
      },
    },
    sessions: {},
  }
  return { ctx, calls, workspace }
}

/** 取 cwd 下最新的 .NOTICE.md（多个用例共用同一 cwd，必须按 mtime 取最新而非按文件名）。 */
async function readNewestNotice() {
  const fs = await import('node:fs/promises')
  const names = (await fs.readdir(cwd)).filter((f) => f.endsWith('.NOTICE.md'))
  assert.ok(names.length > 0, '应写出至少一个 .NOTICE.md')
  const withTime = await Promise.all(names.map(async (n) => {
    const stat = await fs.stat(path.join(cwd, n))
    return { n, t: stat.mtimeMs }
  }))
  withTime.sort((a, b) => b.t - a.t)
  return fs.readFile(path.join(cwd, withTime[0].n), 'utf8')
}

function emit(type, session) {
  for (const fn of listeners.get('session/event') ?? []) fn(session, { type, data: {} })
}

/** 与 emit 相同，但可带 event.data（用于 turn/end.reason 等事件）。 */
function emitData(type, session, data) {
  for (const fn of listeners.get('session/event') ?? []) fn(session, { type, data })
}

/** 模拟一条真实的用户手输消息（source.kind='user'），用于测试「提示词触发交接」。 */
function emitUserMessage(session, text) {
  const event = {
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  }
  for (const fn of listeners.get('session/event') ?? []) fn(session, event)
}
function session(overrides = {}) {
  const id = overrides.id ?? 'old-session'
  return {
    id,
    header: { cwd, origin: overrides.origin },
    requestContext: () => ({ contextWindow: 1000000 }),
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: '请做 X 并写进 report.md', source: { kind: 'user' } } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'assistant/message', data: { message: { content: '已开始处理 X' }, usage: { totalTokens: 100 } } },
      { type: 'tool/call', data: { name: 'write', arguments: '{"file_path":"/tmp/project/report.md"}' } },
      { type: 'turn/end', data: { turn: 1, reason: 'completed' } },
    ],
  }
}

// --- 1. auto 模式：达阈值 → 写文档 + 新建 + prompt ---
{
  listeners.clear()
  const SID = 'case1'
  const { ctx, calls } = makeCtx({ used: 120000, sessionId: SID })
  plugin.apply(ctx, { mode: 'auto', budgetTokens: 150000, thresholdRatio: 0.75, stateFileName: 'STATE.md' })
  assert.equal(listeners.get('session/event').length, 1)
  emit('assistant/message', session({ id: SID }))
  await new Promise(r => setTimeout(r, 50))
  assert.equal(calls.created.length, 1, '应新建 1 个会话')
  assert.deepEqual(calls.created[0], { workspaceId: 'ws-1' })
  assert.equal(calls.prompts.length, 1, '应发出首条提示词')
  assert.equal(calls.prompts[0].sessionId, 'new-session')
  assert.equal(calls.prompts[0].mode, 'queue')
  assert.match(calls.prompts[0].content[0].text, /STATE\.md/)
  assert.match(calls.prompts[0].content[0].text, /case1/)
  const notice = await readFile(path.join(cwd, 'STATE.NOTICE.md'), 'utf8')
  assert.match(notice, /new-session/, '通知文件应写明新会话 ID')
  // 旧会话模型可见的反馈：注册在 agent-scoped systemPrompt.context 上
  assert.equal(calls.contexts.length, 1, '应注册 1 条旧会话系统级提示')
  assert.equal(calls.contexts[0].name, 'handoff-at-75:notice')
  assert.match(calls.contexts[0].text, /new-session/, '提示应写明新会话 ID')
  assert.match(calls.contexts[0].text, /停止/, '提示应要求旧会话停止推进')
  assert.equal(calls.contexts[0].interpolate, false, '提示文本不应被变量插值')
  assert.equal(calls.contexts[0].required, true)
  assert.ok(calls.effects.some(e => e.label?.startsWith('handoff-at-75.notice.')), 'disposer 应交给 ctx.effect')
  const doc = await readFile(path.join(cwd, 'STATE.md'), 'utf8')
  assert.match(doc, /## 1\. 目标/)
  assert.match(doc, /请做 X/)
  assert.match(doc, /report\.md/)
  assert.match(doc, /旧会话 ID/)
  // 去重：同世代再次触发不再新建
  emit('turn/end', session({ id: SID }))
  await new Promise(r => setTimeout(r, 30))
  assert.equal(calls.created.length, 1, '一次世代只触发一次')
  console.log('PASS auto 模式：交接文档、同 Workspace 新建、首条提示词、去重')
}

// --- 2. 未达阈值不触发 ---
{
  listeners.clear()
  const SID = 'case2'
  const { ctx, calls } = makeCtx({ used: 50000, sessionId: SID })
  plugin.apply(ctx, { mode: 'auto' })
  emit('assistant/message', session({ id: SID }))
  await new Promise(r => setTimeout(r, 30))
  assert.equal(calls.created.length, 0)
  console.log('PASS 未达阈值不触发')
}

// --- 3. confirm 模式：批准才执行；拒绝不执行 ---
{
  listeners.clear()
  const SID = 'case3a'
  const { ctx, calls } = makeCtx({ used: 120000, sessionId: SID, answer: { answers: [{ id: 'handoff', selected: ['暂不交接'] }] } })
  plugin.apply(ctx, { mode: 'confirm' })
  emit('assistant/message', session({ id: SID }))
  await new Promise(r => setTimeout(r, 40))
  assert.equal(calls.questions.length, 1)
  assert.equal(calls.created.length, 0, '拒绝后不新建')
  console.log('PASS confirm 拒绝')

  listeners.clear()
  const SID2 = 'case3b'
  const approved = makeCtx({ used: 120000, sessionId: SID2 })
  plugin.apply(approved.ctx, { mode: 'confirm' })
  emit('assistant/message', session({ id: SID2 }))
  await new Promise(r => setTimeout(r, 40))
  assert.equal(approved.calls.created.length, 1, '批准后新建')
  console.log('PASS confirm 批准')
}

// --- 4. 不属于 Workspace 时跳过 ---
{
  listeners.clear()
  const SID = 'case4'
  const { ctx, calls, workspace } = makeCtx({ used: 120000, sessionId: SID })
  workspace.sessionIds = []
  plugin.apply(ctx, { mode: 'auto' })
  emit('assistant/message', session({ id: SID }))
  await new Promise(r => setTimeout(r, 30))
  assert.equal(calls.created.length, 0)
  console.log('PASS 无 Workspace 归属时跳过')
}

// --- 4b. 安全写：已存在同名文件时不覆盖，改用带时间戳的名字 ---
{
  listeners.clear()
  const SID = 'case4b'
  const { ctx, calls } = makeCtx({ used: 120000, sessionId: SID })
  await writeFile(path.join(cwd, 'TAKEN.md'), '用户原有内容', 'utf8')
  plugin.apply(ctx, { mode: 'auto', stateFileName: 'TAKEN.md' })
  emit('assistant/message', session({ id: SID }))
  await new Promise(r => setTimeout(r, 50))
  assert.equal(await readFile(path.join(cwd, 'TAKEN.md'), 'utf8'), '用户原有内容', '不得覆盖已有文件')
  assert.equal(calls.prompts.length, 1)
  assert.match(calls.prompts[0].content[0].text, /TAKEN\.\d/, '提示词应指向带时间戳的实际文件名')
  console.log('PASS 安全写：不覆盖已有文件')
}

// --- 4c. confirm 选「本代不再提醒」后不再重复弹卡 ---
{
  listeners.clear()
  const SID = 'case4c'
  const { ctx, calls } = makeCtx({ used: 120000, sessionId: SID, answer: { answers: [{ id: 'handoff', selected: ['本代不再提醒'] }] } })
  plugin.apply(ctx, { mode: 'confirm' })
  emit('assistant/message', session({ id: SID }))
  await new Promise(r => setTimeout(r, 40))
  emit('turn/end', session({ id: SID }))
  await new Promise(r => setTimeout(r, 40))
  emit('assistant/message', session({ id: SID }))
  await new Promise(r => setTimeout(r, 40))
  assert.equal(calls.questions.length, 1, '本代不再提醒后不应重复弹卡')
  console.log('PASS confirm 本代不再提醒')
}

// --- 4d. 缺少 systemPrompt / live agent 时降级，不影响已完成的新会话 ---
{
  listeners.clear()
  const SID = 'case4d'
  const { ctx, calls } = makeCtx({ used: 120000, sessionId: SID })
  ctx.systemPrompt = undefined
  ctx.agents = { get: () => undefined }
  plugin.apply(ctx, { mode: 'auto', stateFileName: 'DEGRADE.md' })
  emit('assistant/message', session({ id: SID }))
  await new Promise(r => setTimeout(r, 50))
  assert.equal(calls.created.length, 1, '降级不应影响新建会话')
  assert.equal(calls.prompts.length, 1, '降级不应影响首条提示词')
  assert.equal(calls.contexts.length, 0)
  const notice = await readFile(path.join(cwd, 'DEGRADE.NOTICE.md'), 'utf8')
  assert.match(notice, /未能收到系统级提示/, '通知文件应如实说明降级')
  console.log('PASS 反馈降级：缺服务/无 live agent 不中断交接')
}

// --- 5. off 模式不注册监听 ---
{
  listeners.clear()
  const { ctx } = makeCtx()
  plugin.apply(ctx, { mode: 'off' })
  assert.equal((listeners.get('session/event') ?? []).length, 0)
  console.log('PASS off 模式不注册监听')
}

// --- 6. Config 校验 ---
{
  const s = plugin.Config['~standard']
  assert.equal(s.validate({}).value.thresholdRatio, 0.75)
  assert.ok(s.validate({ thresholdRatio: 5 }).issues, '超范围比例应报错')
  assert.ok(s.validate({ mode: 'wat' }).issues, '非法 mode 应报错')
  assert.ok(s.validate({ stateFileName: 'a/b' }).issues, '路径式文件名应报错')
  assert.equal(s.validate({}).value.rowTint, true, 'rowTint 缺省应为 true（老用户维持染色）')
  assert.equal(s.validate({ rowTint: false }).value.rowTint, false, 'rowTint=false 应保留')
  assert.ok(s.validate({ rowTint: 'false' }).issues, 'rowTint 非布尔应报错')
  console.log('PASS Config 校验')
}

// --- 7. 配置补丁解析（设置面板 / 命令共用）---
{
  assert.deepEqual(plugin.parseConfigPatch({ mode: 'confirm' }), { patch: { mode: 'confirm' } })
  assert.equal(plugin.parseConfigPatch({ budgetTokens: 200000 }).patch.budgetTokens, 200000)
  assert.equal(plugin.parseConfigPatch({ thresholdRatio: 0.5 }).patch.thresholdRatio, 0.5)
  assert.deepEqual(plugin.parseConfigPatch({ rowTint: false }), { patch: { rowTint: false } })
  assert.deepEqual(plugin.parseConfigPatch({ rowTint: true }), { patch: { rowTint: true } })
  assert.ok(plugin.parseConfigPatch({ rowTint: 'off' }).error, 'rowTint 非布尔应拒绝')
  assert.ok(plugin.parseConfigPatch({ unknown: 1 }).error, '未知字段应拒绝')
  assert.ok(plugin.parseConfigPatch({ mode: 'wat' }).error, '非法 mode 应拒绝')
  assert.ok(plugin.parseConfigPatch({ thresholdRatio: 5 }).error, '超范围比例应拒绝')
  assert.ok(plugin.parseConfigPatch(null).error, '非对象应拒绝')
  assert.ok(plugin.parseConfigPatch({}).error, '空补丁应拒绝')
  console.log('PASS 配置补丁解析：白名单 + 校验 + 归一化')
}

// --- 8. /handoff 命令文本解析 ---
{
  assert.deepEqual(plugin.parseCommandInput(''), { kind: 'status' })
  assert.deepEqual(plugin.parseCommandInput('status'), { kind: 'status' })
  assert.deepEqual(plugin.parseCommandInput('auto'), { kind: 'patch', patch: { mode: 'auto' } })
  assert.deepEqual(plugin.parseCommandInput('confirm'), { kind: 'patch', patch: { mode: 'confirm' } })
  assert.deepEqual(plugin.parseCommandInput('off'), { kind: 'patch', patch: { mode: 'off' } })
  assert.deepEqual(plugin.parseCommandInput('budget 200000'), { kind: 'patch', patch: { budgetTokens: 200000 } })
  assert.deepEqual(plugin.parseCommandInput('ratio 0.6'), { kind: 'patch', patch: { thresholdRatio: 0.6 } })
  assert.equal(plugin.parseCommandInput('wat').kind, 'help')
  console.log('PASS /handoff 命令解析')
}

// --- 9. 配置面服务缺失时安静跳过，不影响主逻辑 ---
{
  listeners.clear()
  const { ctx, calls } = makeCtx({ used: 120000 })
  // makeCtx 没有 inject/get/connection/commands → registerConfigSurfaces 必须安全无操作
  plugin.apply(ctx, { mode: 'auto', stateFileName: 'SURFACE.md' })
  assert.equal(listeners.get('session/event').length, 1, '仍应注册事件监听')
  emit('assistant/message', session({ id: 'old-session' }))
  await new Promise(r => setTimeout(r, 50))
  assert.equal(calls.created.length, 1, '缺配置面服务不应影响交接')
  console.log('PASS 配置面服务缺失时降级')
}

// --- 10. off 模式仍注册配置入口（否则停用后无法重新启用）---
{
  listeners.clear()
  const registered = []
  const { ctx } = makeCtx()
  ctx.inject = (deps, fn) => { if (deps.includes('commands')) fn({ effect: (d) => d(), commands: { register: (def) => { registered.push(def); return () => {} } } }) }
  plugin.apply(ctx, { mode: 'off' })
  assert.equal((listeners.get('session/event') ?? []).length, 0, 'off 不注册事件监听')
  assert.equal(registered.length, 1, 'off 仍应注册 /handoff 命令')
  assert.equal(registered[0].name, 'handoff')
  console.log('PASS off 模式保留配置入口')
}

// --- 11. 配置写入走 configEditor，且写的是用户 profile 覆盖层 ---
{
  listeners.clear()
  const edits = []
  const { ctx } = makeCtx()
  let command
  ctx.get = (name) => name === 'configEditor' ? {
    edit: async (entry, change) => { edits.push({ entry, next: change({ mode: 'auto' }) }) },
  } : undefined
  ctx.fiber = { entry: { id: 'handoff-at-75' } }
  ctx.inject = (deps, fn) => { if (deps.includes('commands')) fn({ effect: (d) => d(), commands: { register: (def) => { command = def; return () => {} } } }) }
  plugin.apply(ctx, { mode: 'auto' })
  const result = await command.handler({ rawInput: 'confirm' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /先询问/)
  assert.equal(edits.length, 1, '应调用一次 configEditor.edit')
  assert.equal(edits[0].entry.id, 'handoff-at-75')
  assert.equal(edits[0].next.mode, 'confirm')
  console.log('PASS 配置写入：configEditor.edit + /handoff confirm')

  // 非法输入走 command 应返回 error，且不写 profile
  const bad = await command.handler({ rawInput: 'budget -5' })
  assert.equal(bad.kind, 'error')
  assert.equal(edits.length, 1, '非法输入不应写 profile')
  console.log('PASS 非法命令输入不写 profile')
}

// --- 12. 已认证 Fetch 路由 GET/POST（connection.fetch.register 契约） ---
{
  listeners.clear()
  const routes = []
  const edits = []
  const { ctx } = makeCtx()
  ctx.get = (name) => {
    if (name === 'configEditor') return { edit: async (_e, change) => { edits.push(change({ mode: 'auto' })) } }
    if (name === 'connection') return { fetch: { register: (route) => { routes.push(route); return () => {} } } }
    return undefined
  }
  ctx.fiber = { entry: { id: 'handoff-at-75' } }
  ctx.inject = (deps, fn) => { if (deps.includes('connection')) fn({ get: (n) => n === 'connection' ? ctx.get('connection') : undefined, effect: (d) => d() }) }
  plugin.apply(ctx, { mode: 'auto', budgetTokens: 150000, thresholdRatio: 0.75 })
  assert.equal(routes.length, 3, '配置路由 + 模型目录路由 + 行状态路由')
  const route = routes.find((r) => r.path === '/api/auto-handoff/config')
  assert.ok(route, '应注册配置路由')
  // 与 dsh-client-connection/src/rpc.ts:153 的 ConnectionFetchRoute 契约对齐。
  assert.equal(route.path, '/api/auto-handoff/config')
  assert.deepEqual(route.methods, ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')

  // 面板用 Fetch Request/Response；mock 用最小实现验证 GET/POST 行为。
  const req = (method, body) => ({
    method,
    async json() { return JSON.parse(body ?? '{}') },
  })
  const read = async (res) => ({ status: res.status, body: await res.json() })

  const got = await read(await route.fetch(req('GET')))
  assert.equal(got.status, 200)
  assert.equal(got.body.config.mode, 'auto')
  assert.equal(got.body.config.budgetTokens, 150000)
  assert.deepEqual(got.body.editable, [
    'mode', 'budgetTokens', 'thresholdRatio', 'rowTint',
    'handoffProvider', 'handoffModel', 'handoffReasoningEffort', 'askModelOnHandoff',
  ])
  assert.equal(got.body.config.rowTint, true, 'GET 配置应带 rowTint 默认值')

  const posted = await read(await route.fetch(req('POST', JSON.stringify({ thresholdRatio: 0.5 }))))
  assert.equal(posted.status, 200)
  assert.equal(posted.body.ok, true)
  assert.equal(posted.body.config.thresholdRatio, 0.5)
  assert.equal(edits.length, 1)

  // 非法值拒绝且不写 profile；非法 JSON 返回 400
  const invalid = await read(await route.fetch(req('POST', '{"mode":"wat"}')))
  assert.equal(invalid.status, 400)
  const badJson = await read(await route.fetch({ method: 'POST', async json() { throw new Error('oops') } }))
  assert.equal(badJson.status, 400)
  assert.equal(edits.length, 1, '非法请求不应写 profile')
  console.log('PASS 已认证 Fetch 路由：GET 读取、POST 写入、非法值与非法 JSON 拒绝')
}

// --- 13. 连续保存：setConfig 必须把改动并回内存快照，否则第二次保存把第一次退回旧值 ---
{
  listeners.clear()
  let command
  const routes = []
  const { ctx } = makeCtx()
  ctx.get = (name) => {
    if (name === 'configEditor') return { edit: async (_e, change) => { change({ mode: 'auto' }) } }
    if (name === 'connection') return { fetch: { register: (route) => { routes.push(route); return () => {} } } }
    return undefined
  }
  ctx.fiber = { entry: { id: 'handoff-at-75' } }
  ctx.inject = (deps, fn) => {
    if (deps.includes('commands')) fn({ effect: (d) => d(), commands: { register: (def) => { command = def; return () => {} } } })
    if (deps.includes('connection')) fn({ get: (n) => n === 'connection' ? ctx.get('connection') : undefined, effect: (d) => d() })
  }
  plugin.apply(ctx, { mode: 'auto', budgetTokens: 150000, thresholdRatio: 0.75 })

  // /handoff status 是纯查询：应报告监测状态，且不能谎称「已写入…重载后生效」。
  const status = await command.handler({ rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /监测状态：监测中/)
  assert.doesNotMatch(status.text, /已写入/, 'status 是纯查询，不应声称已写入')

  const route = routes[0]
  const req = (method, body) => ({ method, async json() { return JSON.parse(body ?? '{}') } })
  const read = async (res) => ({ status: res.status, body: await res.json() })

  // 第一次改 mode，第二次改 budget：第二次返回的 config 必须仍带第一次的 mode=confirm。
  const first = await read(await route.fetch(req('POST', JSON.stringify({ mode: 'confirm' }))))
  assert.equal(first.body.config.mode, 'confirm')
  const second = await read(await route.fetch(req('POST', JSON.stringify({ budgetTokens: 9000 }))))
  assert.equal(second.body.config.mode, 'confirm', '第二次保存不能把第一次的 mode 退回 auto')
  assert.equal(second.body.config.budgetTokens, 9000)
  // GET 也必须读到最新值，否则面板「刷新」会误以为没保存。
  const got = await read(await route.fetch(req('GET')))
  assert.equal(got.body.config.mode, 'confirm', 'GET 应返回已保存的最新值')
  assert.equal(got.body.config.budgetTokens, 9000)

  // 写入型命令仍应提示已写入。
  const patched = await command.handler({ rawInput: 'off' })
  assert.match(patched.text, /已写入/, '写入型命令应给出重载提示')

  console.log('PASS 连续保存不丢已改项 + status 纯查询不说「已写入」')
}

// --- 13. 交接后必须**真正中止**旧会话（不只注入文字提示）---
// 背景：真机实测旧会话收到「请立即停止」后仍继续跑了 40+ 分钟，
// 因为此前只有 systemPrompt 文字约束。本组用例锁死「必须调用 sessionController.cancel」。
{
  listeners.clear()
  const SID = 'case13'
  const { ctx, calls } = makeCtx({ used: 120000, sessionId: SID })
  await plugin.apply(ctx)
  emit('turn/end', session({ id: SID }))
  await new Promise(r => setTimeout(r, 60))

  assert.equal(calls.created.length, 1, '应新建新会话')
  assert.equal(calls.cancelled.length, 1, '必须对旧会话调用一次 cancel（硬中止）')
  assert.deepEqual(calls.cancelled[0], { sessionId: SID }, 'cancel 必须指向旧会话 id')

  // 中文提示仍应保留（软约束作为第二道防线，不能因为加了硬中止就删掉）
  assert.equal(calls.contexts.length, 1, '仍应注册旧会话系统级提示')
  assert.match(calls.contexts[0].text, /停止/, '提示应要求旧会话停止推进')

  // NOTICE 必须如实写明「已硬中止」，而不是含糊的「会停止」
  const text = await readNewestNotice()
  assert.match(text, /硬中止/, 'NOTICE 应写明已硬中止旧会话')

  console.log('PASS 交接后硬中止旧会话（cancel 被调用 + NOTICE 如实声明）')
}

// --- 14. 硬中止的边界：空闲/无 live agent/不支持/失败 都不能中断交接 ---
{
  // 14a 旧会话已空闲：不应调用 cancel，也不报错
  listeners.clear()
  const a = makeCtx({ used: 120000, sessionId: 'case14a', agentStatus: 'idle' })
  await plugin.apply(a.ctx)
  emit('turn/end', session({ id: 'case14a' }))
  await new Promise(r => setTimeout(r, 60))
  assert.equal(a.calls.created.length, 1, '空闲会话也应完成交接')
  assert.equal(a.calls.cancelled.length, 0, '空闲会话不需要 cancel')
  console.log('PASS 硬中止边界：旧会话空闲时不调用 cancel')
}
{
  // 14b 没有 live agent（agents.get 返回 undefined）：交接仍应成功
  listeners.clear()
  const b = makeCtx({ used: 120000, sessionId: 'case14b', noLiveAgent: true })
  await plugin.apply(b.ctx)
  emit('turn/end', session({ id: 'case14b' }))
  await new Promise(r => setTimeout(r, 60))
  assert.equal(b.calls.created.length, 1, '无 live agent 时应完成交接')
  assert.equal(b.calls.cancelled.length, 0, '无 live agent 时不应调用 cancel')
  console.log('PASS 硬中止边界：无 live agent 时交接不受影响')
}
{
  // 14c cancel 抛异常：不能影响已完成的新会话，且 NOTICE 要诚实标注失败
  listeners.clear()
  const c = makeCtx({ used: 120000, sessionId: 'case14c', cancelThrows: new Error('boom') })
  await plugin.apply(c.ctx)
  emit('turn/end', session({ id: 'case14c' }))
  await new Promise(r => setTimeout(r, 60))
  assert.equal(c.calls.created.length, 1, 'cancel 失败不应回滚新会话')
  assert.equal(c.calls.cancelled.length, 1, '应尝试过 cancel')
  const text = await readNewestNotice()
  assert.match(text, /硬中止旧会话失败|可能仍会跑完/, 'cancel 失败时 NOTICE 必须诚实告知')
  console.log('PASS 硬中止边界：cancel 失败不中断交接且诚实告知')
}

// --- 15. 提示词手动触发：「开个新对话继续此任务」 ---
// 用户要求：可以在对话里用一句话让他开新对话继续任务，不必等阈值。
{
  // 15a 关键词识别（纯函数，覆盖正反例与误判风险）
  const mkMsg = (text, kind = 'user') => ({
    type: 'user/message',
    data: { role: 'user', source: { kind }, content: [{ type: 'text', text }] },
  })
  const shouldHit = [
    '开个新对话继续此任务',
    '开个新对话继续此任务。',
    '新建对话接着做',
    '开个新对话',
    '交接',
    '帮我开个新对话接着干',
    '另起一个会话继续这个任务',
    '新开一个对话继续',
    '开个新会话接着做这个',
  ]
  for (const text of shouldHit) {
    assert.equal(plugin.isHandoffRequest({}, mkMsg(text)), true, `应识别为交接请求：${text}`)
  }
  const shouldMiss = [
    '帮我看看这个组件怎么优化',
    // 交接文档首条提示词就含「交接存档」，若误判会导致新会话自我触发、无限交接
    '请读取交接存档并继续',
    '请先读取交接存档 PROJECT_STATE 核对后再开工',
    '这个组件的交接逻辑要改',
    '交接机制怎么实现的',
    // 长文本是正常任务描述，偶含关键词不该触发
    '开个新对话继续此任务' + '正文'.repeat(60),
    '优化一下UI交互',
  ]
  for (const text of shouldMiss) {
    assert.equal(plugin.isHandoffRequest({}, mkMsg(text)), false, `不应识别为交接请求：${text.slice(0, 30)}`)
  }
  // 只认人类手输：插件/系统/模型来源一律拒绝，否则插件自己发的提示词会导致无限交接链
  for (const kind of ['plugin', 'system', 'model', '']) {
    assert.equal(plugin.isHandoffRequest({}, mkMsg('开个新对话继续此任务', kind)), false,
      `source.kind=${JSON.stringify(kind)} 不应触发交接`)
  }
  console.log('PASS 手动交接：关键词识别（正例/反例/来源门禁）')
}
{
  // 15b 端到端：低用量（远低于阈值）也能触发，且完整走完交接
  listeners.clear()
  const SID = 'case15b'
  // used=1000，远低于默认阈值 112500：证明手动触发不受阈值约束
  const { ctx, calls } = makeCtx({ used: 1000, sessionId: SID })
  await plugin.apply(ctx)
  emitUserMessage(session({ id: SID }), '开个新对话继续此任务')
  await new Promise(r => setTimeout(r, 80))

  assert.equal(calls.created.length, 1, '手动触发应立即新建会话（不受阈值约束）')
  assert.equal(calls.prompts.length, 1, '应向新会话发首条提示词')
  assert.equal(calls.cancelled.length, 1, '应硬中止旧会话')
  assert.deepEqual(calls.cancelled[0], { sessionId: SID })
  const text = await readNewestNotice()
  assert.match(text, /手动交接/, 'NOTICE 应写明是手动交接')
  assert.match(text, /用户在对话中明确要求/, 'NOTICE 应写明触发原因')
  console.log('PASS 手动交接：低用量下按用户指令触发并完整执行')
}
{
  // 15c 幂等：同一会话连续说两次，只交接一次
  listeners.clear()
  const SID = 'case15c'
  const { ctx, calls } = makeCtx({ used: 1000, sessionId: SID })
  await plugin.apply(ctx)
  emitUserMessage(session({ id: SID }), '开个新对话继续此任务')
  await new Promise(r => setTimeout(r, 80))
  emitUserMessage(session({ id: SID }), '开个新对话继续此任务')
  await new Promise(r => setTimeout(r, 80))
  assert.equal(calls.created.length, 1, '同一会话不应重复交接')
  console.log('PASS 手动交接：同一会话只交接一次')
}
{
  // 15d 子 Agent 会话不触发手动交接
  listeners.clear()
  const SID = 'case15d'
  const { ctx, calls } = makeCtx({ used: 1000, sessionId: SID })
  await plugin.apply(ctx)
  emitUserMessage(session({ id: SID, origin: 'subagent' }), '开个新对话继续此任务')
  await new Promise(r => setTimeout(r, 80))
  assert.equal(calls.created.length, 0, '子 Agent 会话不应触发交接')
  console.log('PASS 手动交接：子 Agent 会话被排除')
}

// --- 23. isResumptionPrompt：续接提示识别（正负例）---
{
  const yes = [
    '这是一次自动交接后的新对话。请先在**当前项目目录**读取交接存档 `PROJECT_STATE.2026-11-16T15-01-07-557Z.md`，核对其中「目标 / 有效决定 / 关键文件 / 真实进度 / 下一步」后再开工。',
    '请读取交接存档 PROJECT_STATE.md，核对后再开工。核对要点：1. 若存档与项目当前文件状态不一致…',
    '请简要复述你核对后的目标与下一步，然后直接继续任务。交接文档见 PROJECT_STATE.md',
    '这是一次自动交接后的新对话。请先在**当前项目目录**读取交接存档 `STATE.md`，核对后再开工。\n核对要点：\n1. 若存档与项目当前文件状态不一致…',
  ]
  for (const text of yes) {
    assert.equal(plugin.isResumptionPrompt(text), true, `应识别为续接提示：${text.slice(0, 24)}`)
  }
  const no = [
    '请做 X 并写进 report.md',
    '把 PROJECT_STATE.md 的格式改成 YAML', // 提到存档名但是改格式，不是续接
    '帮我核对一下这个交接文档里的数字', // 有「核对」但无续接动作
    '继续优化这个插件',
    '',
  ]
  for (const text of no) {
    assert.equal(plugin.isResumptionPrompt(text), false, `不应误判为续接提示：${text}`)
  }
  console.log('PASS 续接提示识别：正例命中、负例不误伤')
}

// --- 24. 链式交接：续接会话再交接时「目标」不滚雪球失真 ---
{
  listeners.clear()
  const SID = 'case24'
  const { ctx, calls } = makeCtx({ used: 120000, sessionId: SID })
  // 模拟「续接会话」的日志：首条 user/message 是续接提示（还裹着 system-reminder 噪声），
  // 第二条才是本轮真实任务。
  const chained = session({ id: SID })
  const original = chained.snapshotEvents
  chained.snapshotEvents = () => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: {
      content: [
        { type: 'text', text: '<system-reminder>工作区说明（截断）…</system-reminder>' },
        { type: 'text', text: '这是一次自动交接后的新对话。请先在**当前项目目录**读取交接存档 `PROJECT_STATE.2026-11-16T15-01-07-557Z.md`，核对其中「目标 / 有效决定 / 关键文件 / 真实进度 / 下一步」后再开工。' },
      ],
      source: { kind: 'user' },
    } },
    { type: 'user/message', data: {
      content: [{ type: 'text', text: '把侧栏图标改成绿色，并修掉交接目标失真' }],
      source: { kind: 'user' },
    } },
    ...original().slice(2),
  ]
  plugin.apply(ctx, { mode: 'auto', budgetTokens: 150000, thresholdRatio: 0.75, stateFileName: 'STATE24.md' })
  emit('assistant/message', chained)
  await new Promise(r => setTimeout(r, 50))
  assert.equal(calls.created.length, 1, '续接会话应能再次交接')
  const doc = await readFile(path.join(cwd, 'STATE24.md'), 'utf8')
  const goalSection = doc.split('## 1. 目标')[1].split('## 2.')[0].trim()
  assert.match(goalSection, /把侧栏图标改成绿色/, '目标应取真实任务，不是续接提示')
  assert.doesNotMatch(goalSection, /读取交接存档|这是一次自动交接后的新对话/, '目标不得滚进续接指令')
  assert.doesNotMatch(doc, /第 2 条用户指令：.*system-reminder/, '续接提示的噪声不得混进有效决定')
  console.log('PASS 链式交接：目标不滚雪球失真')
}

// --- 25. 交接标题续接：旧标题 + -N 后缀，且 prompt 前 rename 钉住 ---
{
  listeners.clear()
  const SID = 'case25'
  const { ctx, calls } = makeCtx({ used: 120000, sessionId: SID })
  const s = session({ id: SID })
  s.title = '做一个自动交接插件'
  plugin.apply(ctx, { mode: 'auto', budgetTokens: 150000, thresholdRatio: 0.75, stateFileName: 'STATE25.md' })
  emit('assistant/message', s)
  await new Promise(r => setTimeout(r, 50))
  assert.equal(calls.created.length, 1)
  assert.equal(calls.renamed.length, 1, '交接应 rename 新会话标题')
  assert.equal(calls.renamed[0].sessionId, 'new-session')
  assert.equal(calls.renamed[0].title, '做一个自动交接插件-1', '首次交接后缀 -1')
  // rename 必须早于 prompt（否则 LLM 自动命名会覆盖）
  const renameAt = calls.logs.findIndex(l => l.includes('新会话标题续接为'))
  assert.ok(renameAt >= 0)
  console.log('PASS 交接标题：首次 -1')
}
{
  // 旧标题已带 -2 → 新标题 -3
  listeners.clear()
  const SID = 'case25b'
  const { ctx, calls } = makeCtx({ used: 120000, sessionId: SID })
  const s = session({ id: SID })
  s.title = '做一个自动交接插件-2'
  plugin.apply(ctx, { mode: 'auto', budgetTokens: 150000, thresholdRatio: 0.75, stateFileName: 'STATE25B.md' })
  emit('assistant/message', s)
  await new Promise(r => setTimeout(r, 50))
  assert.equal(calls.renamed[0].title, '做一个自动交接插件-3', '链上递增 -3，不出现 -2-1')
  console.log('PASS 交接标题：链上递增')
}
{
  // rename 失败不应阻断交接
  listeners.clear()
  const SID = 'case25c'
  const { ctx, calls } = makeCtx({ used: 120000, sessionId: SID, renameThrows: new Error('no rename') })
  const s = session({ id: SID })
  s.title = '标题失败降级'
  plugin.apply(ctx, { mode: 'auto', budgetTokens: 150000, thresholdRatio: 0.75, stateFileName: 'STATE25C.md' })
  emit('assistant/message', s)
  await new Promise(r => setTimeout(r, 50))
  assert.equal(calls.created.length, 1, 'rename 失败仍完成交接')
  assert.equal(calls.prompts.length, 1)
  const notice = await readFile(path.join(cwd, 'STATE25C.NOTICE.md'), 'utf8')
  assert.doesNotMatch(notice, /新会话标题/, 'rename 失败不写标题行')
  console.log('PASS 交接标题：rename 失败降级不阻断')
}

// --- 26. 功能 A：失败/额度状态保守采集 + GET 路由 ---
{
  listeners.clear()
  const routes = []
  const { ctx } = makeCtx({ used: 1000 })
  ctx.get = (name) => name === 'connection'
    ? { fetch: { register: (r) => { routes.push(r); return () => {} } } } : undefined
  ctx.fiber = { entry: { id: 'handoff-at-75' } }
  ctx.inject = (deps, fn) => { if (deps.includes('connection')) fn({ get: (n) => n === 'connection' ? ctx.get('connection') : undefined, effect: (d) => d() }) }
  plugin.apply(ctx, { mode: 'auto', budgetTokens: 150000, thresholdRatio: 0.75 })
  const rowRoute = routes.find((r) => r.path === '/api/auto-handoff/row-status')
  assert.ok(rowRoute, '应注册行状态路由')
  assert.deepEqual(rowRoute.methods, ['GET'])
  const readStatuses = async () => (await (await rowRoute.fetch(new Request('http://x'))).json()).statuses
  const SID = 'row-1'
  const s = { id: SID, header: {}, snapshotEvents: () => [] }

  // 无信号时绝不标红
  assert.deepEqual(await readStatuses(), {})
  // 正常结束不标红
  emitData('turn/end', s, { reason: { kind: 'completed' } })
  assert.deepEqual(await readStatuses(), {})
  // 用户取消不标红
  emitData('turn/end', s, { reason: { kind: 'aborted' } })
  assert.deepEqual(await readStatuses(), {})
  // 失败（非额度）→ failed
  emitData('turn/end', s, { reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'boom' } } })
  assert.equal((await readStatuses())[SID], 'failed', '终态 error → failed')
  // 新一轮开始即清除
  emitData('turn/start', s, {})
  assert.deepEqual(await readStatuses(), {}, 'turn/start 清除陈旧红')
  // 额度用尽（白名单）→ quota
  emitData('turn/end', s, { reason: { kind: 'error', error: { code: 'QUOTA' } } })
  assert.equal((await readStatuses())[SID], 'quota')
  // 限流不标额度红（会自愈，误标风险高）
  emitData('turn/start', s, {})
  emitData('turn/end', s, { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } })
  assert.equal((await readStatuses())[SID], 'failed', '限流按普通失败，不冒充额度用尽')
  console.log('PASS 功能A：失败/额度保守采集（无信号不标、取消不标、新一轮清除）')
}


// --- 15. Config：模型/推理强度字段成对出现，缺省不干预 ---
{
  const s = plugin.Config['~standard']
  const base = s.validate({}).value
  assert.equal(base.handoffProvider, '', '模型缺省应为空（沿用 DSH 默认）')
  assert.equal(base.handoffModel, '')
  assert.equal(base.handoffReasoningEffort, '')
  assert.equal(base.askModelOnHandoff, true, '交接时现选缺省开启')
  assert.ok(s.validate({ handoffProvider: 'deepseek' }).issues, '只给 provider 不给 model 应报错')
  assert.ok(s.validate({ handoffModel: 'deepseek-chat' }).issues, '只给 model 不给 provider 应报错')
  assert.ok(s.validate({ handoffProvider: 'a/b', handoffModel: 'c' }).issues, 'id 里含 / 应报错')
  assert.ok(s.validate({ askModelOnHandoff: 'yes' }).issues, 'askModelOnHandoff 非布尔应报错')
  const ok = s.validate({ handoffProvider: 'deepseek', handoffModel: 'deepseek-chat', handoffReasoningEffort: 'high' })
  assert.equal(ok.value.handoffProvider, 'deepseek')
  assert.equal(ok.value.handoffReasoningEffort, 'high')
  console.log('PASS Config：交接模型字段成对校验 + 缺省不干预')
}

// --- 16. /handoff model / effort / ask 命令解析 ---
{
  assert.deepEqual(plugin.parseCommandInput('model'), { kind: 'model', arg: '' })
  assert.deepEqual(plugin.parseCommandInput('model deepseek/deepseek-chat'), { kind: 'model', arg: 'deepseek/deepseek-chat' })
  assert.deepEqual(plugin.parseCommandInput('model default'), { kind: 'model', arg: 'default' })
  assert.deepEqual(plugin.parseCommandInput('effort high'), { kind: 'effort', arg: 'high' })
  assert.deepEqual(plugin.parseCommandInput('effort default'), { kind: 'effort', arg: 'default' })
  assert.deepEqual(plugin.parseCommandInput('ask off'), { kind: 'patch', patch: { askModelOnHandoff: false } })
  assert.deepEqual(plugin.parseCommandInput('ask on'), { kind: 'patch', patch: { askModelOnHandoff: true } })
  assert.equal(plugin.parseCommandInput('ask maybe').kind, 'help')
  console.log('PASS /handoff model / effort / ask 解析')
}

// --- 17. /handoff model 走实时目录校验，并联动清理不再适用的强度 ---
{
  listeners.clear()
  const registered = []
  const edits = []
  const { ctx } = makeCtx()
  ctx.get = (name) => name === 'configEditor' ? {
    edit: async (_e, change) => { edits.push(change({})) },
  } : undefined
  ctx.fiber = { entry: { id: 'handoff-at-75' } }
  ctx.inject = (deps, fn) => { if (deps.includes('commands')) fn({ effect: (d) => d(), commands: { register: (def) => { registered.push(def); return () => {} } } }) }
  plugin.apply(ctx, { mode: 'auto', handoffProvider: 'deepseek', handoffModel: 'deepseek-chat', handoffReasoningEffort: 'low' })
  const command = registered[0]

  // 换到不支持 low 的模型：强度必须被清空，不能留一个交接时才炸的值。
  const switched = await command.handler({ rawInput: 'model other/gpt-x' })
  assert.equal(switched.kind, 'success')
  const patch = edits.at(-1)
  assert.equal(patch.handoffProvider, 'other')
  assert.equal(patch.handoffModel, 'gpt-x')
  assert.equal(patch.handoffReasoningEffort, '', '新模型不支持旧强度时应清空')

  // 目录里没有的模型：明确报错且不写 profile。
  const before = edits.length
  const bogus = await command.handler({ rawInput: 'model deepseek/nope' })
  assert.equal(bogus.kind, 'error')
  assert.match(bogus.text, /不在当前可用目录/)
  assert.equal(edits.length, before, '非法模型不应写 profile')

  // 裸 model id 唯一命中时接受。
  const bare = await command.handler({ rawInput: 'model deepseek-reasoner' })
  assert.equal(bare.kind, 'success')
  assert.equal(edits.at(-1).handoffModel, 'deepseek-reasoner')

  // 强度必须是该模型支持的档位：切到有强度的模型后，未知档位报错、已知档位写入。
  await command.handler({ rawInput: 'model deepseek/deepseek-chat' })
  const badEffort = await command.handler({ rawInput: 'effort turbo' })
  assert.equal(badEffort.kind, 'error')
  assert.match(badEffort.text, /未知档位/)
  const goodEffort = await command.handler({ rawInput: 'effort medium' })
  assert.equal(goodEffort.kind, 'success')
  assert.equal(edits.at(-1).handoffReasoningEffort, 'medium')
  // 无强度的模型：给明确错误，而不是静默写入。
  await command.handler({ rawInput: 'model deepseek/deepseek-reasoner' })
  const noEffort = await command.handler({ rawInput: 'effort low' })
  assert.equal(noEffort.kind, 'error')
  assert.match(noEffort.text, /不支持设置推理强度/)

  // 清除：model default 同时清掉强度。
  const cleared = await command.handler({ rawInput: 'model default' })
  assert.equal(cleared.kind, 'success')
  assert.deepEqual(
    { p: edits.at(-1).handoffProvider, m: edits.at(-1).handoffModel, e: edits.at(-1).handoffReasoningEffort },
    { p: '', m: '', e: '' })
  assert.match(cleared.text, /沿用 DSH 默认模型/)
  console.log('PASS /handoff model：目录校验、联动清强度、default 重置')
}

// --- 18. auto 模式：面板设定的模型在首条提示词**之前**装到新会话上 ---
{
  listeners.clear()
  const SID = 'case18'
  const { ctx, calls } = makeCtx({ used: 120000, sessionId: SID })
  plugin.apply(ctx, {
    mode: 'auto',
    stateFileName: 'MODEL.md',
    handoffProvider: 'deepseek',
    handoffModel: 'deepseek-reasoner',
    handoffReasoningEffort: 'high',
  })
  emit('assistant/message', session({ id: SID }))
  await new Promise(r => setTimeout(r, 60))
  assert.equal(calls.selected.length, 1, '应把模型装到新会话上')
  assert.deepEqual(calls.selected[0], {
    sessionId: 'new-session', provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high',
  })
  assert.deepEqual(calls.order, ['create', 'select', 'rename', 'prompt'], '必须先装模型再发首条提示词')
  const notice = await readFile(path.join(cwd, 'MODEL.NOTICE.md'), 'utf8')
  assert.match(notice, /新会话模型：deepseek\/deepseek-reasoner（推理强度 high）/, 'NOTICE 应写明模型')
  console.log('PASS auto 模式：面板默认模型在首条提示词前装好')
}

// --- 19. confirm 批准后现选：这一次的选择优先于面板默认值 ---
{
  listeners.clear()
  const SID = 'case19'
  const { ctx, calls } = makeCtx({
    used: 120000,
    sessionId: SID,
    modelAnswer: { answers: [{ id: 'handoff-model', selected: ['Other · GPT X'] }] },
    effortAnswer: { answers: [{ id: 'handoff-effort', selected: ['高'] }] },
  })
  plugin.apply(ctx, { mode: 'confirm', handoffProvider: 'deepseek', handoffModel: 'deepseek-chat', askModelOnHandoff: true })
  emit('assistant/message', session({ id: SID }))
  await new Promise(r => setTimeout(r, 80))
  assert.equal(calls.created.length, 1, '批准后应新建')
  assert.equal(calls.selected.length, 1)
  assert.deepEqual(calls.selected[0], {
    sessionId: 'new-session', provider: 'other', model: 'gpt-x', reasoningEffort: 'high',
  }, '现选值应覆盖面板默认值')
  const modelQuestion = calls.questions.find((q) => q.questions?.[0]?.id === 'handoff-model')
  assert.ok(modelQuestion, '应先问模型')
  assert.ok(modelQuestion.questions[0].options.some((o) => o.label === '沿用面板默认'), '必须提供「沿用面板默认」出口')
  const effortQuestion = calls.questions.find((q) => q.questions?.[0]?.id === 'handoff-effort')
  assert.ok(effortQuestion, '选定带强度的模型后应再问强度')
  console.log('PASS confirm 现选：模型 + 推理强度覆盖面板默认')
}

// --- 20. 选模型失败绝不能把交接弄失败 ---
{
  listeners.clear()
  const SID = 'case20'
  const { ctx, calls } = makeCtx({
    used: 120000,
    sessionId: SID,
    selectThrows: new Error('session/model-unavailable'),
  })
  plugin.apply(ctx, { mode: 'auto', stateFileName: 'FAILSEL.md', handoffProvider: 'deepseek', handoffModel: 'deepseek-chat' })
  emit('assistant/message', session({ id: SID }))
  await new Promise(r => setTimeout(r, 60))
  assert.equal(calls.created.length, 1, '选模型失败仍要新建会话')
  assert.equal(calls.prompts.length, 1, '选模型失败仍要发首条提示词')
  const notice = await readFile(path.join(cwd, 'FAILSEL.NOTICE.md'), 'utf8')
  assert.match(notice, /设置失败（session\/model-unavailable）/, 'NOTICE 应如实说明没装上')
  console.log('PASS 选模型失败降级：交接照常完成并如实记录')
}

// --- 21. 读不到模型目录时，现选降级为面板默认，交接不受阻 ---
{
  listeners.clear()
  const SID = 'case21'
  const { ctx, calls } = makeCtx({ used: 120000, sessionId: SID, catalogThrows: new Error('no llm') })
  plugin.apply(ctx, { mode: 'confirm', handoffProvider: 'deepseek', handoffModel: 'deepseek-chat', askModelOnHandoff: true })
  emit('assistant/message', session({ id: SID }))
  await new Promise(r => setTimeout(r, 80))
  assert.equal(calls.created.length, 1, '读不到目录不应阻断交接')
  assert.equal(calls.questions.filter((q) => q.questions?.[0]?.id === 'handoff-model').length, 0, '读不到目录就不该弹模型卡')
  assert.deepEqual(calls.selected[0], { sessionId: 'new-session', provider: 'deepseek', model: 'deepseek-chat' }, '回落面板默认模型')
  console.log('PASS 模型目录不可用：跳过现选、回落面板默认')
}

// --- 22. /api/auto-handoff/models：面板下拉的数据源 ---
{
  listeners.clear()
  const routes = []
  const { ctx } = makeCtx()
  ctx.get = (name) => name === 'connection'
    ? { fetch: { register: (route) => { routes.push(route); return () => {} } } }
    : undefined
  ctx.inject = (deps, fn) => { if (deps.includes('connection')) fn({ get: (n) => n === 'connection' ? ctx.get('connection') : undefined, effect: (d) => d() }) }
  plugin.apply(ctx, { mode: 'auto' })
  const route = routes.find((r) => r.path === '/api/auto-handoff/models')
  assert.ok(route, '应注册模型目录路由')
  assert.deepEqual(route.methods, ['GET'])
  const body = await (await route.fetch(new Request('http://x'))).json()
  assert.equal(body.ok, true)
  assert.equal(body.default.provider, 'deepseek')
  assert.deepEqual(body.groups.map((g) => g.id), ['deepseek', 'other'])
  const chat = body.groups[0].models.find((m) => m.id === 'deepseek-chat')
  assert.deepEqual(chat.reasoning.efforts.map((e) => e.id), ['low', 'medium'])
  assert.equal(chat.reasoning.defaultEffort, 'medium')
  assert.equal(body.groups[0].models.find((m) => m.id === 'deepseek-reasoner').reasoning, undefined, '无强度模型不带 reasoning')
  console.log('PASS /api/auto-handoff/models：目录结构供面板下拉')
}

console.log('\nALL TESTS PASSED')

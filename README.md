# 自动交接（dsh-handoff-at-75）

> **「75%」是自定义 token 预算的比例，不是模型上下文窗口的比例。** 本机模型窗口多为 96 万~100 万 token，按窗口理解会以为几乎永不触发；本插件默认按 150000 token 预算计算，达到 112500 就交接。
> **默认是全自动的**（`mode: auto`）：装完即在后台静默监测，到阈值自动新建会话并直接开跑。想先确认再执行，把 `mode` 改为 `confirm`。

一个 Host 逻辑 + 免构建 Client 面板的 DSH 插件：监测对话的上下文用量，达到可配阈值（默认「自定义 token 预算 × 75%」）时，把交接存档写进项目目录，并在**同一项目（Workspace）**下新建一条对话继续任务。交接触发逻辑在 Host 侧（`index.js`）；`client.js` 提供**左侧栏「自动交接」图标 + 中间列面板**与 **Settings → 自动交接** 两个图形入口（手写纯 JS，无打包步骤）。

## 它做什么

1. 在 durable 的 `assistant/message` / `turn/end` 事件上，用 `ctx.tokenMeter.measure(session).totalTokens` 读取当前上下文压力。
2. 当用量 ≥ `budgetTokens × thresholdRatio`（默认 `150000 × 0.75 = 112500`）时：
   - 从已提交的会话日志确定性抽取「目标 / 有效决定 / 关键文件 / 真实进度 / 下一步 / 旧会话 ID」，写成项目目录下的交接文档；**绝不覆盖已有同名文件**——若已存在则自动改用带时间戳的文件名，新对话首条提示词会指向实际文件名；
   - 用 `ctx.sessionController.create({ workspaceId })` 在同一 Workspace 新建 Session（自动完成 agent 创建、侧栏公告、workspace 挂载）；
   - 用 `ctx.sessionController.selectModel(...)` 把「交接后新会话的模型 / 推理强度」装到新会话上（必须在首条提示词之前，否则第一轮就用默认模型跑）；未设置时完全不干预，沿用 DSH 默认；
   - 用 `ctx.sessionController.prompt(...)` 给新会话发第一条用户消息，让它读交接存档后继续任务 —— `prompt` 内部 `followup()` 会唤醒 agent 直接开跑；
   - 用 `ctx.systemPrompt.context()` 在**旧会话**的 agent-scoped ctx 上注册一条持久系统级提示，让旧会话模型后续每一步都看到「任务已转到新会话、请立即停止推进」；
   - **硬中止旧会话**：用 `ctx.sessionController.cancel({ sessionId })` 结束旧会话正在执行的这一轮（等价于用户按停止按钮，`keepInbox` 保留排队输入）。只靠上面那条文字提示是不够的——实测旧会话收到提示后仍会继续跑 40+ 分钟（继续 `wait_agent`、改文件、写文档），所以必须真正中断 turn。空闲会话、无 live agent 或 cancel 失败时都降级为「仅提示」，不影响已完成的新会话；
   - 在项目目录另写一份 `<交接文档名>.NOTICE.md` 通知文件，注明新会话 ID、文档路径，以及旧会话是「已硬中止 / 空闲无需中止 / 中止失败」中的哪一种（如实告知，不含糊）；
3. 一个会话的一次压缩世代只交接一次；若压缩使占用降到 `rearmRatio`（默认 40%）以下，可重新武装。子 Agent 会话不触发。

## 在对话里手动触发交接（提示词）

不必等上下文到阈值，直接在对话里说一句就行：

```
开个新对话继续此任务
```

也接受这些说法（正则见 `isHandoffRequest`）：`新建对话接着做` / `开个新对话` / `交接` / `另起一个会话继续这个任务` / `新开一个对话继续` / `开个新会话接着做这个`。

行为与自动交接完全一致（同一项目新建会话、写交接文档、发首条提示词、硬中止旧会话），区别只有：

- **不检查阈值**，也不受 `mode=confirm` 影响——你已经亲口说了，不再弹卡二次确认；
- `.NOTICE.md` 标题为「手动交接 · 已执行」，触发原因写「用户在对话中明确要求」；
- 仍在 `mode=off` 时不生效（停用即完全不介入）。

安全边界（避免误触发/无限链）：

- **只认人类手输**：`source.kind` 必须是 `user`。插件自己发的首条提示词、系统注入都不是人类输入，否则新会话一启动就会再次触发，形成无限交接链；
- 长度 > 120 字的消息不算（多半是正常任务描述里偶然提到）；
- 「交接存档 / 交接文档 / 交接逻辑 / 交接机制」等不触发——交接文档首条提示词本身就含这些词；
- 同一会话只交接一次；子 Agent 会话不触发。

## 交接后新会话用哪个模型（v1.1）

交接出来的新对话默认继承 DSH 的默认模型。v1.1 起可以指定，两条路径都走同一个公开 API `ctx.sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`：

| 路径 | 什么时候用 | 怎么设 |
| --- | --- | --- |
| **面板默认值**（持久） | 每次交接都想用同一个模型 | Settings → 自动交接 →「交接后的新对话」：模型 + 推理强度两个下拉。也可 `/handoff model deepseek/deepseek-chat`、`/handoff effort high`，`default` 清除 |
| **交接时现选**（一次性） | 这次想临时换个更强/更省的模型 | `askModelOnHandoff=true`（默认）时，「先询问」模式批准后、或你手动说「开个新对话继续」之后，插件先弹两张卡：模型 → 推理强度。第一项永远是「沿用面板默认」，超时/跳过都回落面板值 |

要点：

- **顺序**：`create → selectModel → rename → prompt`。必须在首条提示词之前装好模型，否则新会话第一轮就已经用默认模型跑起来了。
- **目录校验**：下拉与 `/handoff model` 都对着 `sessionController.modelCatalog()` 的实时目录校验；命令里写不在目录中的模型会直接报错，不会写进配置。
- **换模型会清空强度**：旧档位对新模型未必有效（例如 Reasoner 与 Chat 的档位不同），切模型时强度自动清空，由你重选。
- **副作用（已知并接受）**：DSH 的 `selectModel` 会同时把这次选择存成「默认模型」，即之后手动新建的对话也会用它。若不想再改默认值，把面板里模型设为「沿用 DSH 默认」并关掉「交接时弹卡现选」。
- **失败只降级**：`selectModel` 被拒（`session/model-unavailable` 等）、模型目录读不到、弹卡超时，一律降级为「用默认模型继续交接」，并在日志与 `.NOTICE.md` 里如实写明；绝不让选模型把交接本身弄失败。

## 配置（`cordis.patch.yml` 的插件 config）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `budgetTokens` | `150000` | 自定义上下文预算。触发点 = 它 × `thresholdRatio`。 |
| `thresholdRatio` | `0.75` | 触发比例，对应「75%」。 |
| `mode` | `auto` | `auto` 全自动；`confirm` 先弹卡询问（含「本代不再提醒」选项）再执行；`off` 停用。 |
| `confirmTimeoutMs` | `120000` | confirm 模式等待用户回答的毫秒数，超时不交接。 |
| `stateFileName` | `PROJECT_STATE.md` | 交接文档文件名（写入项目 cwd）。若已存在，自动改用带时间戳的名字，绝不覆盖。 |
| `rearmRatio` | `0.4` | 压缩后占用降到此比例以下可再次触发，并清掉 confirm 的「本代不再提醒」抑制。 |
| `rowTint` | `true` | 侧栏会话行四色状态染色开关（进行中黄 / 待回答橙 / 完成未读绿 / 失败·额度用尽红，保留毛玻璃）。`false` 时彻底恢复宿主原生外观。面板里即时切换、即时生效，写入 profile 持久化；与 `mode` 正交——`mode=off` 不影响染色。 |
| `handoffProvider` | `''` | 交接后新会话使用的模型提供方 id（如 `deepseek`）。与 `handoffModel` 必须成对出现；两个都留空 = 不干预，沿用 DSH 当前默认模型。 |
| `handoffModel` | `''` | 模型 id（如 `deepseek-chat`）。交接时按实时模型目录校验，不在目录里则降级为默认模型并如实记录。 |
| `handoffReasoningEffort` | `''` | 推理强度档位 id（如 `high` / `medium`）。留空 = 不写显式强度、用模型默认；该模型没有档位时会话不支持设置。 |
| `askModelOnHandoff` | `true` | 交接时是否弹卡现选模型与强度。只在有人在场的路径生效：`confirm` 模式批准后、或用户手动要求交接时；`auto` 模式永远不弹（避免无人值守被一次超时卡住）。 |

配置有四个入口，都落到同一份数据：

1. **左侧栏「自动交接」图标**（`sidebar.panellist` + `main` 面板）：点击直接在中间列打开同一个设置面板；
2. **Settings → 自动交接**（`settings.section`）：切换「全自动 / 先询问 / 停用」、开关「会话行状态染色」（四色，即时生效），修改 `budgetTokens` 与 `thresholdRatio`；
3. **`/handoff` 命令**：`status` 查看、`auto|confirm|off` 切模式、`budget N`、`ratio R`、`model <provider/model|default>`、`effort <档位|default>`、`ask on|off`；
4. **配置文件**：本 bundle 自带的 `cordis.patch.yml`（初始值），以及**用户 profile 的 `cordis.patch.yml` 覆盖层**（`~/.dsh/profiles/desktop/cordis.patch.yml`，优先级更高、升级不丢）。

界面与命令的改动经 `configEditor.edit()` 写入**用户 profile 覆盖层**，由 Loader 自动重载插件后生效（无需手改文件、无需重启 Host）。首次启用 Client 半需重载 bundle 并刷新页面以加载新 manifest。永久停用把 `mode` 设为 `off`，或在 Plugins 面板停用本插件；停用不会删除已生成的交接文档。

## 界面（2026-11-16 重做）

面板不是一张设置表单，而是一块「预算刻尺」：**触发点数字（如 112,500 tokens）是视觉主角**，三个可配置项退居其后。用户来这儿九成是确认「到多少会交接」，一成才是改。

- **零边框**：卡片靠明度与极浅阴影浮起；暗色补一层 4.5% 白的内描边，否则卡片会糊进背景。
- **强调色只出现 3 处**：刻度条填充、分段器选中胶囊、焦点环。其余全为中性灰阶。
- **明暗两套色值**（不是同一套调暗）：参考图的亮橙 `#F97316` 在白底只有 2.80:1，作小图形不合格，所以明色压深到 `#DC4B06`（3.62:1）、文字用 `#B4430B`（5.60:1）；暗色反而用亮橙 `#F97316`（5.64:1，更清楚）。
- **主 CTA 自带成对前景/背景**（`--dh-cta-bg` / `--dh-cta-fg`）：不用宿主 `button-primary-fill`——它在暗色下翻成近白，与恒白的 `label-on-color` 撞成白字白底。
- **触发模式用分段器而非下拉**：默认「全自动」是危险态（无人值守会新建会话并硬中止当前 turn），必须常显，不能藏进下拉。
- **「交接后的新对话」是一张独立卡片**：模型 / 推理强度两个胶囊下拉 + 「交接时弹卡现选」开关，各自即时保存，不掺进「保存阈值」的批处理。模型目录来自 `GET /api/auto-handoff/models`；老版本 DSH 没有 `modelCatalog()` 时该路由返回 501，面板降级提示改用命令。
- 刻度条语义严格是「预算标尺」（填充段止于 ratio），**不做假的实时用量环**——Client 侧拿不到实时 token 用量。
- **主面板自带滚动区（1.1.1）**：DSH 的 `main` 插槽外层是 `overflow:hidden` 且不滚动的 flex 容器，整页面板必须自己滚。窗口较矮时，模型、侧栏显示等下半截设置不再被裁掉、可以滚到；`/api/auto-handoff/models` 返回空响应或非 JSON 时也只降级成一行提示，不再抛 `Unexpected end of JSON input`。

样式以单个 `<style id="dh75-style">` 注入（幂等，三个入口共用），变量定义在 `.dh75-root` 作用域内，插件卸载后自动失效、不污染宿主。

**验证方式**（改 UI 后跑）：

```
node preview/shoot.mjs    # 明暗 × 主面板/Settings/错误/加载，输出 preview/shots/
node preview/a11y.mjs     # 真 Chrome 读 computed style：28 项 WCAG 对比度 + 布局守护
```

`preview/` 是开发夹具（不随插件发布）：把 `client.js` 的真组件挂进真 React + 真 Chrome，所以截的是真渲染，不是另画的设计稿。

### ⚠ 勿加回 `container-type:inline-size`

2026-11-16 真机事故：面板打开后**文字竖排、每字一行**。根因是设计师建议用 `@container` 做窄容器适配，于是给 `.dh75-root` 加了 `container-type:inline-size`——它会让元素的内联尺寸**不再由内容撑开**；宿主把 `main` slot 渲染成 flex 子项，父等子撑开、子等父给宽度，形成循环依赖，双双塌成 40px，汉字逐行换行。

双变量矩阵实验（真 Chrome）：

| 父级 | container-type | width:100% | root 宽 | 结果 |
|---|---|---|---|---|
| flex 子项 | 无 | 无 | 648px | 正常 |
| flex 子项 | **有** | **无** | **40px** | **★ 竖排** |
| flex 子项 | 有 | 有 | 820px | 正常 |
| block | 有 | 无 | 820px | 正常 |

**修复**：① 去掉 `container-type`，窄屏改用 `@media`；② 保留 `width:100%` 作为防御性第二道保险。`preview/a11y.mjs` 有守护断言：检测到 `container-type !== normal` 或段落高度 > 120px 立即失败——反事实验证过，加回该属性会被抓住。

## 设计依据

- 用 `measure().totalTokens` 而非 `contextPressure()`：前者是 durable tail 的相干快照，DSH 自带的自动压缩（`dsh-compaction-basic`）也用它做阈值判断。
- 不用 `sessions.fork()`：fork 会复制整段历史，达不到「换对话省上下文」的目的。
- 不用 `agent.inject()`：它不唤醒 driver；交接必须靠 `sessionController.prompt()` 的 `followup()`。
- 旧会话反馈不用 `agent.followup()` / `agent.inject()`：二者都要求带 brand id 的 `UserMessage`，而链接安装的 bundle 无法解析 `@deepseek-ai/dsh-llm` 的 `createUserMessage`；改用 `ctx.systemPrompt.context()` 注册在 agent-scoped ctx 上，不新增事件、不唤醒 driver、无额外依赖。
- 交接内容确定性抽取自日志，不额外调用模型；新对话按文档为主、旧会话 ID 为底档接续。

## 已知边界

- 交接文档是**确定性摘要**，不是模型生成的总结：细节可能有取舍，新对话首条提示词会要求它核对项目实际文件状态，并可用旧会话 ID 查证。
- 反查「同项目」依赖 `workspaceRegistry` 的 `sessionIds`；若当前会话不属于任何 Workspace，插件跳过交接（不猜路径）。
- `contextWindow` 缺失（未知模型未声明容量）时，`measure()` 仍能给出 totalTokens，判断按 `budgetTokens` 进行；容量仅用于日志与压缩后的重新武装。
- 确认模式依赖当前有 live Agent 且有可用的回答者；否则跳过，不弹无人应答的卡片。选「暂不交接」只抑制到下一个事件，选「本代不再提醒」才持久抑制到下次压缩回落。
- 交接成功后的反馈有三层：① **硬中止旧会话当前 turn**（`sessionController.cancel`，等价用户按停止按钮），这是唯一能真正阻止旧会话继续跑的手段；② 旧会话模型每步可见的系统级提示（`ctx.systemPrompt.context()`，见上，不新增会话事件、不唤醒 driver），作为「万一又被唤醒」时的第二道防线；③ 项目目录里的 `.NOTICE.md` 文件与侧栏新会话、logger 日志。系统级提示是**注册型**的，会一直存在到插件卸载；若服务缺失或旧会话已无 live Agent，则降级为只写 `.NOTICE.md` + 日志，不影响已完成的新会话。
- auto 模式下新会话会自行开始运行并可能产生文件改动/token 消耗；这是「自动继续任务」的预期行为，若不希望如此请改用 `confirm`。
- 选模型依赖 `sessionController.modelCatalog()` / `selectModel()`：DSH 版本较旧、未登录、或提供方凭据缺失时，目录可能为空或选择被拒——此时交接照常完成，只是新会话用默认模型，`.NOTICE.md` 会写明「设置失败（原因）」。
- 交接时现选**只在有人在场的路径**弹卡：`confirm` 批准后、手动交接时。`auto` 模式刻意不弹——全自动的意义就是不用人盯着，弹一张 120 秒等不到答案的卡只会把交接拖慢。
- `selectModel` 会顺带改 DSH 的默认模型（这是它的设计，不是本插件的额外动作）；详见上一节「副作用」。

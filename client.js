/**
 * 自动交接 · Client 半（免构建，纯 JS）。
 *
 * 只 require('react')；样式走注入的 <style> + CSS 变量，跟随宿主明暗主题。
 * 三个入口共用同一套组件：
 *   1. 左侧栏图标（sidebar.panellist）
 *   2. 中间列主面板（main）
 *   3. Settings 分区（settings.section，紧凑变体）
 *
 * 设计要点（2026-11-16 重做）：
 *   - 这块面板的主角是「触发点 112,500 tokens」这个读数，不是一堆表单行；
 *   - 零边框，靠明度与阴影让卡片浮起；暗色补 1px 内描边，否则卡片糊进背景；
 *   - 强调色（暖橙）只出现 3 处：刻度条填充、选中胶囊、焦点环；
 *   - 主 CTA 是深色胶囊（参考图语言），不用宿主 brand-primary——
 *     它在暗色下翻成近白，与 label-on-color（恒白）撞成白字白底。
 *
 * 注意：本文件是手写产物（部署的 Client 模块表按此格式加载），不经过打包工具。
 * 只注册 factory，副作用全部放进 apply() 并用 ctx.effect 收尾。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-handoff-at-75',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback, useRef } = React

    // 走已认证的 /api Fetch 通道（Host 侧用 ctx.connection.fetch.register 挂载），
    // 与命令共用 setConfig()，由 Host 做 peer 鉴权。
    const API = '/api/auto-handoff/config'
    const MODELS_API = '/api/auto-handoff/models'

    /* ══════════════════════════════════════════════════════════════════
     * 样式表
     *
     * 为什么必须注入 <style> 而不是用内联 style 对象：
     *   - :hover / :focus-visible / :disabled 这些伪类写不进内联对象；
     *   - 明暗切换要用 body[data-ds-dark-theme] 后代选择器；
     *   - 窄容器适配要 @container，内联无法表达；
     *   - 状态一多，内联对象会被 Object.assign 叠成不可读的一坨。
     *
     * 变量定义在 .dh75-root 而不是 :root：插件卸载后变量自动失效，不污染宿主。
     * 暗色选择器同时写 body 与 html 两种可能挂载位置。
     * ══════════════════════════════════════════════════════════════════ */
    const CSS = `
.dh75-root{
  box-sizing:border-box;
  /* 明色：暖米白画布、纯白卡片 */
  --dh-canvas:#F6F4F0; --dh-card:#FFFFFF; --dh-sunken:#F2EFE9; --dh-field:#F7F5F1;
  --dh-ink-1:#14100D; --dh-ink-2:#5B5650; --dh-ink-3:#6E6760;
  --dh-hairline:#EDE8E1; --dh-field-edge:#D9D2C8;
  /* 强调色：参考图的 #F97316 在白底只有 2.8:1，不可做文字/小图形，
     故明色压深到 #DC4B06（图形 3.62:1）、文字用 #B4430B（5.60:1） */
  --dh-accent:#DC4B06; --dh-accent-text:#B4430B;
  --dh-accent-soft:#FBEADF; --dh-accent-soft-text:#A03A07;
  --dh-ring:rgba(196,65,12,.28);
  --dh-cta-bg:#1C1917; --dh-cta-fg:#FCFAF7; --dh-cta-hover:#2C2724;
  --dh-ghost-hover:rgba(20,16,13,.055);
  --dh-success:#146C33; --dh-error:#B42318;
  --dh-disabled-bg:#EDE8E1; --dh-disabled-fg:#7A736B;
  --dh-shadow:0 1px 2px rgba(24,18,12,.04), 0 8px 24px -8px rgba(24,18,12,.07);
  --dh-r-card:24px; --dh-p-card:28px;
  --dh-fs-display:44px; --dh-fs-num:17px; --dh-fs-body:14px; --dh-fs-sub:12.5px;

  /* 不用 container-type:inline-size：它会让元素的内联尺寸不再由内容撑开，
     在 flex 父容器里（宿主 main slot 就是）会与父级形成「互相等对方给宽度」的
     死锁，双双塌成 0px，导致每个汉字逐行换行。2026-11-16 真机竖排事故的根因。
     实测：带 container-type 时 root=8px、段落高 828px；去掉后 root=576px、段落高 22px。
     窄屏适配改用 @media，不要为了容器查询把这个属性加回来。 */
  width:100%;
  box-sizing:border-box;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  color:var(--dh-ink-1);
  -webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums;
}
body[data-ds-dark-theme] .dh75-root, html[data-ds-dark-theme] .dh75-root{
  --dh-canvas:#17161A; --dh-card:#232226; --dh-sunken:#1F1E23; --dh-field:#2A282D;
  --dh-ink-1:#F5F1EC; --dh-ink-2:#B4ADA4; --dh-ink-3:#9A938A;
  --dh-hairline:#302D33; --dh-field-edge:#3D3A42;
  /* 暗色下亮橙反而更清楚（5.64:1），用参考答案图的 #F97316 */
  --dh-accent:#F97316; --dh-accent-text:#FFA467;
  --dh-accent-soft:#35241B; --dh-accent-soft-text:#FFB489;
  --dh-ring:rgba(249,115,22,.35);
  --dh-cta-bg:#F2EDE6; --dh-cta-fg:#1A1714; --dh-cta-hover:#FFFDFA;
  --dh-ghost-hover:rgba(255,255,255,.065);
  --dh-success:#7FE3A9; --dh-error:#FF9E9E;
  --dh-disabled-bg:#333037; --dh-disabled-fg:#8A837B;
  /* 暗色阴影在近黑底几乎不可见，必须补一层 4.5% 白内描边，
     否则卡片与画布糊成一片（这是暗色卡片能否「浮起」的关键） */
  --dh-shadow:0 1px 2px rgba(0,0,0,.5), 0 8px 24px -8px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.045);
}
/* 紧凑变体（Settings 分区）：可用宽度更小，字号与内距整体降一档 */
.dh75-root[data-variant="compact"]{
  --dh-r-card:20px; --dh-p-card:20px;
  --dh-fs-display:32px; --dh-fs-num:14px; --dh-fs-body:13.5px; --dh-fs-sub:12px;
}

.dh75-root *,.dh75-root *::before,.dh75-root *::after{box-sizing:border-box}
/* 主面板的滚动层。DSH 的主面板容器（main 插槽）是 flex 子项，外层 .centre
   带 overflow:hidden 且自己不滚动——插件的整页面板必须自带滚动区，
   否则内容一超出窗口高度就被直接裁掉，窗口小的时候下半截永远够不到。
   height:100% 对「父级是给了高度的一格」成立，flex:1/min-height:0 兜住
   「父级是 flex column」的情形，两套一起写，哪种宿主布局都能滚。 */
.dh75-page{width:100%;height:100%;min-height:0;flex:1 1 auto;
  overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}
/* 主面板不再自带一层米色底：宿主已经有了面板背景，再加一层会变成「卡中卡」。
   改为纯留白容器，让白色卡片直接浮在宿主背景上（参考图正是这个关系）。 */
.dh75-shell{padding:8px 4px 24px}
.dh75-root[data-variant="compact"] .dh75-shell{padding:0}

.dh75-eyebrow{font-size:11px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;
  color:var(--dh-ink-3);margin:0 0 10px}
.dh75-h1{font-size:22px;font-weight:600;line-height:1.3;letter-spacing:-.01em;
  color:var(--dh-ink-1);margin:0 0 8px}
.dh75-lede{font-size:var(--dh-fs-body);line-height:1.6;color:var(--dh-ink-2);margin:0 0 22px;max-width:52em}

.dh75-card{background:var(--dh-card);border-radius:var(--dh-r-card);
  padding:var(--dh-p-card);box-shadow:var(--dh-shadow);border:0;margin-bottom:16px}
.dh75-root[data-variant="compact"] .dh75-card{margin-bottom:12px}

/* Hero：算式 → 大数字 → 定性 → 刻度条，构成一个「读数块」 */
.dh75-formula{display:flex;align-items:baseline;gap:10px;
  font-size:var(--dh-fs-num);font-weight:500;color:var(--dh-ink-2);letter-spacing:-.01em}
.dh75-op{color:var(--dh-ink-3);font-weight:400}
.dh75-display{font-size:var(--dh-fs-display);font-weight:600;line-height:1.09;
  letter-spacing:-.027em;color:var(--dh-ink-1);margin:10px 0 0;
  font-feature-settings:"tnum" 1}
.dh75-unit{font-size:.34em;font-weight:500;color:var(--dh-ink-3);margin-left:.34em;letter-spacing:0}
.dh75-cap{font-size:var(--dh-fs-sub);color:var(--dh-ink-3);margin:8px 0 0}
.dh75-meter{height:6px;border-radius:999px;background:var(--dh-sunken);
  overflow:hidden;margin-top:20px}
.dh75-root[data-variant="compact"] .dh75-meter{height:4px;margin-top:14px}
.dh75-meter>i{display:block;height:100%;border-radius:999px;
  background:var(--dh-accent);transition:width .18s ease}
.dh75-scale{display:flex;justify-content:space-between;align-items:center;
  margin-top:8px;font-size:11px;color:var(--dh-ink-3);letter-spacing:.02em}

.dh75-label{font-size:var(--dh-fs-body);font-weight:500;color:var(--dh-ink-1);margin:0}
.dh75-sub{font-size:var(--dh-fs-sub);line-height:1.5;color:var(--dh-ink-3);margin:2px 0 0}
.dh75-row{display:flex;align-items:center;justify-content:space-between;
  gap:16px;padding:14px 0}
.dh75-row+.dh75-row{border-top:1px solid var(--dh-hairline)}
.dh75-row:first-child{padding-top:0}
.dh75-row:last-child{padding-bottom:0}
.dh75-sec-title{font-size:var(--dh-fs-body);font-weight:600;color:var(--dh-ink-1);margin:0 0 14px}

/* 分段器取代下拉：三个选项都短，全展开能让「当前是危险的全自动」一眼可见 */
.dh75-seg{display:flex;gap:4px;padding:4px;height:40px;
  border-radius:999px;background:var(--dh-sunken)}
.dh75-seg>button{flex:1;min-width:0;border:0;border-radius:999px;background:transparent;
  font-family:inherit;font-size:var(--dh-fs-body);font-weight:500;line-height:1;color:var(--dh-ink-2);
  cursor:pointer;transition:color .15s ease,background-color .15s ease;white-space:nowrap}
.dh75-seg>button:hover:not(:disabled):not([aria-checked="true"]){color:var(--dh-ink-1)}
.dh75-seg>button[aria-checked="true"]{background:var(--dh-accent-soft);
  color:var(--dh-accent-soft-text);font-weight:600}
.dh75-seg>button:disabled{cursor:not-allowed;color:var(--dh-disabled-fg)}
.dh75-seg-hint{font-size:var(--dh-fs-sub);color:var(--dh-ink-3);margin:10px 0 0}

/* 侧栏显示开关：iOS 式 switch（布尔），与「触发时机」单选分组器分工互补。
   轨道 44×26 / 手柄 20，开启位移 18px；全部复用既有主题变量。 */
.dh75-switch{position:relative;flex:none;width:44px;height:26px;border-radius:999px;
  border:1px solid var(--dh-ink-3);background:var(--dh-sunken);padding:0;
  display:inline-flex;align-items:center;cursor:pointer;
  transition:background-color .18s ease,border-color .18s ease}
.dh75-switch::before{content:"";position:absolute;inset:-9px 0;border-radius:999px} /* 命中区扩到 44×44 */
.dh75-switch[aria-checked="true"]{background:var(--dh-accent);border-color:transparent}
.dh75-switch:hover:not(:disabled){background:var(--dh-field)}
.dh75-switch[aria-checked="true"]:hover:not(:disabled){background:var(--dh-accent-text)}
.dh75-switch:disabled{cursor:not-allowed;background:var(--dh-disabled-bg);
  border-color:var(--dh-disabled-fg)}
.dh75-switch>i{display:block;width:20px;height:20px;border-radius:50%;
  background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28),0 0 0 1px rgba(20,16,13,.18);
  margin-left:3px;transition:transform .18s ease}
body[data-ds-dark-theme] .dh75-switch>i,html[data-ds-dark-theme] .dh75-switch>i{
  background:var(--dh-ink-1)}
.dh75-switch[aria-checked="true"]>i{transform:translateX(18px)}
.dh75-switch:disabled>i{background:var(--dh-disabled-fg);box-shadow:none}
.dh75-switch:focus-visible{box-shadow:0 0 0 3px var(--dh-ring),inset 0 0 0 2px var(--dh-accent)}
/* 四色图例：8px 饱和色点，开启实、关闭淡（保留色相提示） */
.dh75-legend{display:inline-flex;gap:4px;align-items:center;flex:none;
  transition:opacity .18s ease}
.dh75-legend[aria-hidden="true"]{opacity:1}
.dh75-legend[data-off="true"]{opacity:.35}
.dh75-legend>b{display:block;width:8px;height:8px;border-radius:50%}
.dh75-legend>b:nth-child(1){background:#facc15}
.dh75-legend>b:nth-child(2){background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dh75-legend>b:nth-child(3){background:var(--dsw-alias-state-success-primary,#16a34a)}
.dh75-legend>b:nth-child(4){background:var(--dsw-alias-state-error-primary,#dc2626)}
/* 黄色随明暗：宿主用 data-ds-dark-theme 切主题，同时兼容 OS 级 prefers-color-scheme */
body[data-ds-dark-theme] .dh75-legend>b:nth-child(1),
html[data-ds-dark-theme] .dh75-legend>b:nth-child(1){background:#fde047}
@media (prefers-color-scheme: dark){
  .dh75-legend>b:nth-child(1){background:#fde047}
}
.dh75-switch-wrap{display:inline-flex;align-items:center;gap:8px;flex:none}
.dh75-switch-state{font-size:var(--dh-fs-sub);color:var(--dh-ink-3);min-width:2em}
@media (prefers-reduced-motion: reduce){
  .dh75-switch,.dh75-switch>i,.dh75-legend{transition:none}
}

/* 数字输入：胶囊形、右对齐、等宽数字 */
.dh75-input{width:148px;height:40px;padding:0 14px;border-radius:999px;
  border:1px solid transparent;background:var(--dh-field);
  font-family:inherit;font-size:var(--dh-fs-body);font-weight:500;color:var(--dh-ink-1);
  text-align:right;font-variant-numeric:tabular-nums;
  transition:box-shadow .15s ease,background-color .15s ease}
.dh75-input--ratio{width:100px}
.dh75-input:hover:not(:disabled){box-shadow:inset 0 0 0 1px var(--dh-field-edge)}
.dh75-input:disabled{background:var(--dh-disabled-bg);color:var(--dh-disabled-fg);cursor:not-allowed}
.dh75-input::placeholder{color:var(--dh-ink-3)}

/* 下拉：与数字输入同一套胶囊语言，但左对齐、可截断长模型名 */
.dh75-select{max-width:240px;height:40px;padding:0 34px 0 14px;border-radius:999px;
  border:1px solid transparent;background:var(--dh-field);
  font-family:inherit;font-size:var(--dh-fs-body);font-weight:500;color:var(--dh-ink-1);
  text-overflow:ellipsis;
  appearance:none;-webkit-appearance:none;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 18px) 18px,calc(100% - 13px) 18px;
  background-size:5px 5px,5px 5px;background-repeat:no-repeat;
  transition:box-shadow .15s ease,background-color .15s ease}
.dh75-select:hover:not(:disabled){box-shadow:inset 0 0 0 1px var(--dh-field-edge)}
.dh75-select:disabled{background:var(--dh-disabled-bg);color:var(--dh-disabled-fg);cursor:not-allowed}
.dh75-select option{color:#111;background:#fff}
body[data-ds-dark-theme] .dh75-select option,
html[data-ds-dark-theme] .dh75-select option{color:#eee;background:#222}

.dh75-actions{display:flex;align-items:center;gap:10px;margin-top:20px;flex-wrap:wrap}
.dh75-cta{height:40px;padding:0 22px;border:0;border-radius:999px;
  font-family:inherit;font-size:var(--dh-fs-body);font-weight:500;line-height:1;cursor:pointer;
  background:var(--dh-cta-bg);color:var(--dh-cta-fg);min-width:112px;
  transition:background-color .15s ease;white-space:nowrap;flex:none;
  display:inline-flex;align-items:center;justify-content:center;gap:8px}
.dh75-cta:hover:not(:disabled){background:var(--dh-cta-hover)}
.dh75-cta:disabled{background:var(--dh-disabled-bg);color:var(--dh-disabled-fg);cursor:not-allowed}
.dh75-ghost{height:36px;padding:0 14px;border:0;border-radius:999px;background:transparent;
  font-family:inherit;font-size:var(--dh-fs-body);line-height:1;color:var(--dh-ink-2);cursor:pointer;
  transition:background-color .15s ease,color .15s ease}
.dh75-ghost:hover:not(:disabled){background:var(--dh-ghost-hover);color:var(--dh-ink-1)}
.dh75-ghost:disabled{cursor:not-allowed;color:var(--dh-disabled-fg)}
.dh75-textlink{height:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;
  font-family:inherit;font-size:var(--dh-fs-body);color:var(--dh-ink-3);cursor:pointer;
  margin-left:auto;transition:color .15s ease}
.dh75-textlink:hover{color:var(--dh-ink-1)}

.dh75-status{min-height:20px;margin-top:12px;font-size:var(--dh-fs-sub);
  display:flex;align-items:center;gap:6px;transition:opacity .2s ease}
.dh75-status[data-kind="ok"]{color:var(--dh-success)}
.dh75-status[data-kind="err"]{color:var(--dh-error)}

.dh75-foot{margin-top:22px;font-size:11.5px;line-height:1.7;color:var(--dh-ink-3)}
.dh75-cmds{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.dh75-cmd{background:var(--dh-sunken);color:var(--dh-ink-2);padding:2px 8px;border-radius:6px;
  font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:11px;white-space:nowrap}
.dh75-root[data-variant="compact"] .dh75-foot{margin-top:16px}
.dh75-root[data-variant="compact"] .dh75-cmds{overflow:hidden;max-height:22px}

/* 焦点环：用 :focus-visible，鼠标点击不出现 */
.dh75-root :focus-visible{outline:none;
  box-shadow:0 0 0 3px var(--dh-ring), inset 0 0 0 2px var(--dh-accent)}

/* 骨架屏：替代「正在读取配置…」这行字 */
.dh75-skel{height:14px;border-radius:8px;background:var(--dh-sunken);margin-bottom:10px;
  animation:dh75-pulse 1.4s ease-in-out infinite}
@keyframes dh75-pulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes dh75-spin{to{transform:rotate(360deg)}}
.dh75-spin{width:14px;height:14px;border-radius:50%;
  border:2px solid currentColor;border-top-color:transparent;
  animation:dh75-spin .8s linear infinite;flex:none}

/* 窄屏：主 CTA 撑满一行。用 @media 而非 @container ——
   @container 需要 container-type:inline-size，而该属性在 flex 父容器里
   会让宽度塌陷（见 .dh75-root 注释），真机上已造成竖排事故，勿改回。 */
@media (max-width:520px){
  .dh75-actions .dh75-cta{flex:1 0 100%}
  .dh75-row{flex-wrap:wrap}
  .dh75-input{width:100%}
  .dh75-select{max-width:100%;width:100%}
}
`

    /* 幂等注入：三个入口先后渲染同一组件，必须只插一份样式。 */
    let styleEl = null
    function ensureStyle() {
      if (styleEl !== null && styleEl.isConnected) return styleEl
      try {
        const existing = document.getElementById('dh75-style')
        if (existing !== null) { styleEl = existing; return styleEl }
        styleEl = document.createElement('style')
        styleEl.id = 'dh75-style'
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
      } catch { /* 无 DOM 环境兜底 */ }
      return styleEl
    }

    /* ══════════════════════════════════════════════════════════════════
     * 功能 A：侧栏会话行按状态染半透明色（保留原生 vibrancy 毛玻璃）。
     * 稳定钩子只有 data-row-key；宿主 class 是哈希的、会随版本变，故不用。
     * 染色放在 ::before 薄色层（z0），hover 覆盖 z1，文字/状态点 z2，
     * 右键菜单在更上层——互不覆盖。行本身不加 backdrop-filter / 不透明背景，
     * 毛玻璃来自侧栏 root 的 macOS 原生 vibrancy。
     * 独立 <style> 注入、卸载时移除，不污染宿主全局（架构师 §7 + UI 规范 §2）。
     * ══════════════════════════════════════════════════════════════════ */
    const ROW_TINT_CSS = `
/* 黄色无现成 token，自定义；@media 跟随系统明暗 */
html [data-row-key^="session:"]{ --dh75-running:#facc15 }
@media (prefers-color-scheme: dark){ html [data-row-key^="session:"]{ --dh75-running:#fde047 } }

/* 行定位 + 内容层级：文字/点/时间压在染色层之上 */
html [data-row-key^="session:"]{ position:relative }
html [data-row-key^="session:"] > span{ position:relative; z-index:2 }
html [data-row-key^="session:"]::before,
html [data-row-key^="session:"]::after{
  content:""; position:absolute; inset:0; border-radius:inherit;
  pointer-events:none; background-color:transparent;
}
html [data-row-key^="session:"]::before{ z-index:0 }
html [data-row-key^="session:"]::after{ z-index:1 }
@media (prefers-reduced-motion: no-preference){
  html [data-row-key^="session:"]::before,
  html [data-row-key^="session:"]::after{ transition:background-color 180ms ease }
}

/* 染色层：薄半透明色，高通量选择器压过宿主 .sessionRow:hover/selected。
   :not([data-dh75-tone="none"]) 抑制无状态；archived 行由 JS 直接设 none。 */
html [data-row-key^="session:"][data-dh75-tone="pending"]::before{
  background-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent) !important }
html [data-row-key^="session:"][data-dh75-tone="failed"]::before,
html [data-row-key^="session:"][data-dh75-tone="quota"]::before{
  background-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 38%, transparent) !important }
html [data-row-key^="session:"][data-dh75-tone="running"]::before{
  background-color:color-mix(in srgb, var(--dh75-running) 32%, transparent) !important }
html [data-row-key^="session:"][data-dh75-tone="done"]::before{
  background-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 34%, transparent) !important }

/* hover：中性 6~8% 覆盖，不变色相 */
@media (prefers-color-scheme: light){
  html [data-row-key^="session:"]:hover::after{ background-color:rgba(0,0,0,.06) !important }
}
@media (prefers-color-scheme: dark){
  html [data-row-key^="session:"]:hover::after{ background-color:rgba(255,255,255,.08) !important }
}

/* 选中态：靠左侧蓝色强调条识别，不靠颜色（与四种状态色相均不同）。
   宿主选中类是哈希的（css.selected），稳定钩子是 role=treeitem 行上的 aria-selected。 */
html [data-row-key^="session:"][aria-selected="true"]{
  box-shadow:inset 3px 0 0 0 var(--dsw-alias-state-business-primary) }

/* 失败/额度：红色文字角标。状态点是行内第一个 <span>（宿主类 css.slot 是哈希的，
   DOM 里没有 slot 属性），absolute 挂在它上面、不占位、不推挤标题。 */
html [data-row-key^="session:"][data-dh75-tone="failed"] > span:first-child::after,
html [data-row-key^="session:"][data-dh75-tone="quota"] > span:first-child::after{
  content:"!"; position:absolute; top:-3px; right:-4px;
  width:12px; height:12px; border-radius:50%;
  font:700 9px/12px system-ui,sans-serif; text-align:center;
  color:#fff; background:var(--dsw-alias-state-error-primary);
  box-shadow:0 0 0 1.5px rgba(255,255,255,.85); pointer-events:none }
@media (prefers-color-scheme: dark){
  html [data-row-key^="session:"][data-dh75-tone="failed"] > span:first-child::after,
  html [data-row-key^="session:"][data-dh75-tone="quota"] > span:first-child::after{
    box-shadow:0 0 0 1.5px rgba(0,0,0,.65) }
}
`
    let rowStyleEl = null
    function ensureRowStyle() {
      if (rowStyleEl !== null && rowStyleEl.isConnected) return rowStyleEl
      try {
        const existing = document.getElementById('dh75-row-tint-style')
        if (existing !== null) { rowStyleEl = existing; rowStyleEl.disabled = !tintEnabled; return rowStyleEl }
        rowStyleEl = document.createElement('style')
        rowStyleEl.id = 'dh75-row-tint-style'
        rowStyleEl.textContent = ROW_TINT_CSS
        rowStyleEl.disabled = !tintEnabled
        document.head.appendChild(rowStyleEl)
      } catch { /* 无 DOM 环境兜底 */ }
      return rowStyleEl
    }
    function removeRowStyle() {
      try { rowStyleEl?.remove() } catch { /* ignore */ }
      rowStyleEl = null
    }

    /* ── 染色开关：模块级共享状态（Main / Settings / Observer 共用一份） ──
     * Host config 的 rowTint 是持久真源；localStorage 只作「首帧早置闸」的同步镜像，
     * 避免重启后 Host 请求返回前先闪一下颜色。二者冲突时以 Host 为准。 */
    const TINT_STORAGE_KEY = 'dh75.rowTint'
    function readInitialTint() {
      try {
        const v = localStorage.getItem(TINT_STORAGE_KEY)
        if (v === 'off') return false
        if (v === 'on') return true
      } catch { /* 隐私模式等：忽略 */ }
      return true // 缺省 / 老用户维持既有染色
    }
    let tintEnabled = readInitialTint()
    const tintListeners = new Set()
    /** 切换染色总闸。CSS 用 style.disabled 一次撤掉全部染色规则（O(1)、无逐行抖动）。 */
    function setTintEnabled(value) {
      const next = value !== false
      try { localStorage.setItem(TINT_STORAGE_KEY, next ? 'on' : 'off') } catch { /* ignore */ }
      if (rowStyleEl) rowStyleEl.disabled = !next
      if (next === tintEnabled) return
      tintEnabled = next
      for (const fn of tintListeners) { try { fn(next) } catch { /* ignore */ } }
    }
    function subscribeTint(fn) {
      tintListeners.add(fn)
      return () => tintListeners.delete(fn)
    }
    function useTint() {
      const [on, setOn] = useState(tintEnabled)
      useEffect(() => subscribeTint(setOn), [])
      return on
    }

    function useConfig() {
      const [config, setConfig] = useState(undefined)
      const [error, setError] = useState('')
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState('')

      const reload = useCallback(async () => {
        try {
          // /api 通道用 browserAuth 签发的同源 cookie 鉴权；页面加载时已种下，
          // credentials:'same-origin' 确保把它带上（照抄 agent-manager/client.js:850-854）。
          const res = await fetch(API, { cache: 'no-store', credentials: 'same-origin' })
          const data = await res.json()
          if (!data.ok) throw new Error(data.error || '读取失败')
          setConfig(data.config)
          setError('')
        } catch (e) {
          // Host 返回的 error 可能自带「读取配置失败：」前缀，避免拼成两遍。
          const raw = String(e.message ?? e)
          setError(/^读取配置失败/.test(raw) ? raw : '读取配置失败：' + raw)
        }
      }, [])

      useEffect(() => { void reload() }, [reload])

      // Host config 是 rowTint 的持久真源：读到后覆盖首帧的 localStorage 镜像，
      // 保证「重启后以 Host 为准」且两处面板实例同步（架构师 §6）。
      useEffect(() => {
        if (config && typeof config.rowTint === 'boolean') setTintEnabled(config.rowTint)
      }, [config])

      const save = useCallback(async (patch) => {
        setSaving(true)
        setMessage('')
        setError('')
        try {
          const res = await fetch(API, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          const data = await res.json()
          if (!data.ok) throw new Error(data.error || '保存失败')
          setConfig(data.config)
          setMessage('已保存，插件重载后生效。')
          return true
        } catch (e) {
          const raw = String(e.message ?? e)
          setError(/^保存失败/.test(raw) ? raw : '保存失败：' + raw)
          return false
        } finally {
          setSaving(false)
        }
      }, [])
      return { config, error, saving, message, reload, save }
    }

    /**
     * 模型目录：给「交接后的新对话」两个下拉填选项。
     * 目录来自 Host 的 sessionController.modelCatalog()；老版本 DSH 没有该能力时
     * 路由返回 501，这里把 catalog 置 null 并保留 error，面板降级为「读不到目录」提示，
     * 用户仍可用 /handoff model 命令设置。目录只在挂载时读一次（模型配置变动后刷新面板即可）。
     */
    function useModels() {
      const [catalog, setCatalog] = useState(undefined)
      const [error, setError] = useState('')
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const res = await fetch(MODELS_API, { cache: 'no-store', credentials: 'same-origin' })
            // 不能直接 res.json()：宿主异常/网关抖动时可能回空体或 HTML，
            // 那样会抛 "Unexpected end of JSON input"，把面板变成一行红字。
            // 先取文本再解析，解析失败按「目录不可用」降级，错误里带上 HTTP 状态。
            const text = await res.text()
            let data = null
            try { data = text ? JSON.parse(text) : null } catch { data = null }
            if (!alive) return
            if (!data || !data.ok) {
              const detail = (data && data.error) || `HTTP ${res.status}${text ? '' : '（空响应）'}`
              throw new Error(detail)
            }
            setCatalog(data)
            setError('')
          } catch (e) {
            if (!alive) return
            setCatalog(null)
            const raw = String(e.message ?? e)
            setError(/^读取模型目录失败/.test(raw) ? raw : '读取模型目录失败：' + raw)
          }
        }
        void load()
        return () => { alive = false }
      }, [])
      return { catalog, error }
    }

    const MODES = [
      { value: 'auto', label: '全自动', desc: '到阈值自动新建对话并直接开跑' },
      { value: 'confirm', label: '先询问', desc: '到阈值先弹卡，批准后才交接' },
      { value: 'off', label: '停用', desc: '不监测、不交接，插件完全不介入' },
    ]

    /** 大数字：输入时随 draft 实时变化，所以用 draft 而不是已保存的 config。 */
    function HeroCard({ budget, ratio }) {
      const b = Number(budget)
      const r = Number(ratio)
      const point = Number.isFinite(b) && Number.isFinite(r) ? Math.round(b * r) : 0
      const pct = Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 0
      return h('div', { className: 'dh75-card' },
        h('div', { className: 'dh75-formula' },
          h('span', null, Number.isFinite(b) ? b.toLocaleString() : '—'),
          h('span', { className: 'dh75-op' }, '×'),
          h('span', null, Number.isFinite(r) ? String(r) : '—')),
        h('div', { className: 'dh75-display' },
          point.toLocaleString(),
          h('span', { className: 'dh75-unit' }, 'tokens')),
        h('div', { className: 'dh75-cap' }, '触发点 · 达到即交接'),
        h('div', {
          className: 'dh75-meter',
          role: 'img',
          'aria-label': `触发点在预算的 ${Math.round(pct * 100)}% 处`,
        }, h('i', { style: { width: (pct * 100) + '%' } })),
        h('div', { className: 'dh75-scale' },
          h('span', null, '0'),
          h('span', null, Math.round(pct * 100) + '%'),
          h('span', null, '100%')))
    }

    function Panel({ variant, close }) {
      ensureStyle()
      const { config, error, saving, message, reload, save } = useConfig()
      const { catalog, error: modelsError } = useModels()
      const [draft, setDraft] = useState(undefined)
      const dirty = useRef(false)
      const tintOn = useTint()

      const toggleTint = () => {
        if (saving || config === undefined) return
        const previous = tintEnabled
        const next = !previous
        setTintEnabled(next)           // 乐观：先改共享状态 → 两处面板 + observer 立即同步
        void save({ rowTint: next }).then((ok) => {
          if (ok) {
            setMessage(next ? '已开启会话行染色' : '已关闭会话行染色')
          } else {
            setTintEnabled(previous)   // 失败回滚：控件、CSS、observer 一并还原
          }
        })
      }

      useEffect(() => {
        if (config === undefined) return
        // 保存成功后 config 会变，但不能覆盖用户正在输入的值。
        if (dirty.current) return
        setDraft({ budget: String(config.budgetTokens), ratio: String(config.thresholdRatio) })
      }, [config])

      const setField = (key) => (value) => {
        dirty.current = true
        setDraft((d) => ({ ...d, [key]: value }))
      }

      const shellProps = {
        className: 'dh75-root',
        'data-variant': variant === 'compact' ? 'compact' : 'main',
      }

      if (config === undefined || draft === undefined) {
        const loadingBody = h('div', null,
          h('div', { className: 'dh75-skel', style: { width: '100%' } }),
          h('div', { className: 'dh75-skel', style: { width: '68%' } }),
          h('div', { className: 'dh75-skel', style: { width: '40%', marginBottom: 0 } }))
        const errorBody = h('div', null,
          h('div', { style: { fontSize: 'var(--dh-fs-body)', color: 'var(--dh-error)', fontWeight: 500, marginBottom: 6 } }, '没能读到配置'),
          h('div', { className: 'dh75-sub', style: { marginBottom: 16 } }, error),
          h('button', { type: 'button', className: 'dh75-cta', onClick: reload }, '重试'))
        return h('div', shellProps,
          h('div', { className: 'dh75-shell' },
            h('div', { className: 'dh75-card' }, error === '' ? loadingBody : errorBody)))
      }

      const modeDesc = MODES.find((m) => m.value === config.mode)?.desc ?? ''
      const compact = variant === 'compact'

      // 交接后新会话的模型：'' = 不干预；否则手选 provider::model。
      const modelValue = config.handoffProvider && config.handoffModel
        ? `${config.handoffProvider}::${config.handoffModel}`
        : ''
      const modelOptions = (catalog && Array.isArray(catalog.groups) ? catalog.groups : []).flatMap((group) =>
        (group.models ?? []).map((model) => ({
          value: `${group.id}::${model.id}`,
          label: `${group.name} · ${model.name}`,
          efforts: model.reasoning?.efforts ?? [],
        })))
      const currentOption = modelOptions.find((option) => option.value === modelValue)
      const efforts = currentOption && Array.isArray(currentOption.efforts) ? currentOption.efforts : []
      // 目录已读（成功或失败）但仍匹配不上 → 把配置里的模型原样列出来，避免下拉显示空白。
      const modelMissing = modelValue !== '' && catalog !== undefined && currentOption === undefined
      const saveModel = (value) => {
        // 换模型就清空强度：旧档位对新模型未必有效，Host 会拒绝不匹配的组合。
        if (value === '') {
          void save({ handoffProvider: '', handoffModel: '', handoffReasoningEffort: '' })
          return
        }
        const at = value.indexOf('::')
        void save({
          handoffProvider: value.slice(0, at),
          handoffModel: value.slice(at + 2),
          handoffReasoningEffort: '',
        })
      }
      const modelHint = modelsError !== ''
        ? modelsError + '（可用 /handoff model 命令设置）'
        : '新建对话使用的模型；「沿用 DSH 默认」= 不干预'
      const effortHint = modelValue === ''
        ? '先在左侧选模型；不选则跟随模型默认'
        : efforts.length === 0
          ? '该模型没有可调档位'
          : '只对左侧这个模型生效'
      const askOn = config.askModelOnHandoff !== false

      const commitNumbers = () => {
        const b = Number(draft.budget)
        const r = Number(draft.ratio)
        if (!Number.isFinite(b) || !Number.isFinite(r)) return
        dirty.current = false
        void save({ budgetTokens: b, thresholdRatio: r })
      }

      const header = compact
        ? null
        : h('div', null,
            h('p', { className: 'dh75-eyebrow' }, '上下文预算 · Automatic Handoff'),
            h('h1', { className: 'dh75-h1' }, '自动交接'),
            h('p', { className: 'dh75-lede' },
              '上下文用量达到触发点时，把交接存档写进项目目录，并在同一项目下新建对话继续任务。'))

      return h('div', shellProps,
        h('div', { className: 'dh75-shell' },
          header,

          // Hero：预算 × 比例 = 触发点
          h(HeroCard, { budget: draft.budget, ratio: draft.ratio }),

          // 触发时机：分段器，让危险的默认值「全自动」常显
          h('div', { className: 'dh75-card' },
            h('p', { className: 'dh75-sec-title' }, '触发时机'),
            h('div', { className: 'dh75-seg', role: 'group', 'aria-label': '触发时机' },
              MODES.map((m) => h('button', {
                key: m.value,
                type: 'button',
                role: 'radio',
                'aria-checked': config.mode === m.value,
                'aria-label': m.label,
                tabIndex: config.mode === m.value ? 0 : -1,
                disabled: saving,
                onClick: () => { if (config.mode !== m.value) void save({ mode: m.value }) },
                onKeyDown: (event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  const i = MODES.findIndex((x) => x.value === config.mode)
                  const next = MODES[(i + (event.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length]
                  if (next.value !== config.mode) void save({ mode: next.value })
                },
              }, m.label))),
            h('p', { className: 'dh75-seg-hint' }, modeDesc)),

          // 交接后的新对话：模型与推理强度（默认值），以及是否在交接时弹卡现选。
          // 三行各自即时保存（与 mode 分段器同款），不参与「保存阈值」的批处理。
          h('div', { className: 'dh75-card' },
            h('p', { className: 'dh75-sec-title' }, '交接后的新对话'),
            h('div', { className: 'dh75-row' },
              h('div', null,
                h('p', { className: 'dh75-label' }, '模型'),
                h('p', { className: 'dh75-sub', id: 'dh75-model-sub' }, modelHint)),
              h('select', {
                className: 'dh75-select',
                value: modelValue,
                disabled: saving || catalog === undefined,
                'aria-label': '交接后新会话的模型',
                'aria-describedby': 'dh75-model-sub',
                onChange: (e) => saveModel(e.target.value),
              }, [
                h('option', { key: '', value: '' }, '沿用 DSH 默认'),
                ...modelOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
                // 配置里的模型已不在当前目录（换了账号/下线了）：保留可见，避免静默变回默认。
                ...(modelMissing
                  ? [h('option', { key: 'missing', value: modelValue },
                      `${config.handoffProvider} · ${config.handoffModel}（未在可用目录）`)]
                  : []),
              ])),
            h('div', { className: 'dh75-row' },
              h('div', null,
                h('p', { className: 'dh75-label' }, '推理强度'),
                h('p', { className: 'dh75-sub', id: 'dh75-effort-sub' }, effortHint)),
              h('select', {
                className: 'dh75-select',
                value: config.handoffReasoningEffort || '',
                disabled: saving || efforts.length === 0,
                'aria-label': '交接后新会话的推理强度',
                'aria-describedby': 'dh75-effort-sub',
                onChange: (e) => void save({ handoffReasoningEffort: e.target.value }),
              }, [
                h('option', { key: '', value: '' }, '模型默认'),
                ...efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name)),
              ])),
            h('div', { className: 'dh75-row' },
              h('div', null,
                h('p', { className: 'dh75-label' }, '交接时弹卡现选'),
                h('p', { className: 'dh75-sub', id: 'dh75-ask-sub' },
                  '「先询问」批准后、或你手动要求交接时，先选模型与强度再建对话；全自动模式不弹，避免卡住')),
              h('div', { className: 'dh75-switch-wrap' },
                h('button', {
                  type: 'button',
                  className: 'dh75-switch',
                  role: 'switch',
                  'aria-checked': askOn,
                  'aria-label': '交接时弹卡现选模型',
                  'aria-describedby': 'dh75-ask-sub',
                  disabled: saving,
                  onClick: () => void save({ askModelOnHandoff: !askOn }),
                }, h('i')),
                h('span', { className: 'dh75-switch-state' }, askOn ? '开' : '关')))),

          // 侧栏显示：四色染色开关（与交接触发正交，即时生效、无需保存阈值）
          h('div', { className: 'dh75-card' },
            h('p', { className: 'dh75-sec-title' }, '侧栏显示'),
            h('div', { className: 'dh75-row' },
              h('div', null,
                h('p', { className: 'dh75-label' }, '会话行状态染色'),
                h('p', { className: 'dh75-sub', id: 'dh75-tint-sub' },
                  '进行中·待回答·完成未读·失败按状态着色，保留原生毛玻璃；即时生效。')),
              h('div', { className: 'dh75-switch-wrap' },
                h('span', {
                  className: 'dh75-legend',
                  'aria-hidden': 'true',
                  'data-off': tintOn ? undefined : 'true',
                }, [1, 2, 3, 4].map((n) => h('b', { key: n }))),
                h('button', {
                  type: 'button',
                  className: 'dh75-switch',
                  role: 'switch',
                  'aria-checked': tintOn,
                  'aria-label': '会话行状态染色',
                  'aria-describedby': 'dh75-tint-sub',
                  disabled: saving,
                  onClick: toggleTint,
                }, h('i')),
                h('span', { className: 'dh75-switch-state' }, tintOn ? '开' : '关')))),

          // 参数
          h('div', { className: 'dh75-card' },
            h('div', { className: 'dh75-row' },
              h('div', null,
                h('p', { className: 'dh75-label' }, 'Token 预算'),
                h('p', { className: 'dh75-sub', id: 'dh75-budget-sub' }, '自定义预算，不是模型窗口上限')),
              h('input', {
                type: 'number', min: 1000, step: 1000,
                className: 'dh75-input',
                value: draft.budget,
                disabled: saving,
                inputMode: 'numeric',
                'aria-label': 'Token 预算',
                'aria-describedby': 'dh75-budget-sub',
                onChange: (e) => setField('budget')(e.target.value),
              })),
            h('div', { className: 'dh75-row' },
              h('div', null,
                h('p', { className: 'dh75-label' }, '触发比例'),
                h('p', { className: 'dh75-sub', id: 'dh75-ratio-sub' }, '0.1 ~ 1，默认 0.75')),
              h('input', {
                type: 'number', min: 0.1, max: 1, step: 0.05,
                className: 'dh75-input dh75-input--ratio',
                value: draft.ratio,
                disabled: saving,
                inputMode: 'decimal',
                'aria-label': '触发比例',
                'aria-describedby': 'dh75-ratio-sub',
                onChange: (e) => setField('ratio')(e.target.value),
              }))),

          // 操作
          h('div', { className: 'dh75-actions' },
            h('button', {
              type: 'button',
              className: 'dh75-cta',
              disabled: saving,
              onClick: commitNumbers,
            }, saving ? h(React.Fragment, null, h('span', { className: 'dh75-spin' }), '保存中…') : '保存阈值'),
            h('button', {
              type: 'button', className: 'dh75-ghost', disabled: saving,
              onClick: () => { dirty.current = false; void reload() },
            }, '刷新'),
            close ? h('button', { type: 'button', className: 'dh75-textlink', onClick: close }, '关闭') : null),

          // 状态行：固定高度防跳动，aria-live 不抢焦点
          h('div', {
            className: 'dh75-status',
            role: 'status',
            'aria-live': 'polite',
            'data-kind': message !== '' ? 'ok' : (error !== '' ? 'err' : undefined),
          }, message !== ''
            ? h(React.Fragment, null, h('span', null, '✓'), message)
            : error !== '' ? h(React.Fragment, null, h('span', null, '!'), error) : ' '),

          // 脚注：命令胶囊，弱化到最低
          h('div', { className: 'dh75-foot' },
            h('div', { className: 'dh75-cmds' },
              ['/handoff status', '/handoff confirm', '/handoff model deepseek/deepseek-chat', '/handoff effort high']
                .map((c) => h('code', { key: c, className: 'dh75-cmd' }, c))),
            compact
              ? null
              : h('div', null, '改动写入用户 profile 覆盖层，升级不丢；插件重载后生效。'))))
    }

    /**
     * 侧栏图标：双气泡对角错位 = 「旧对话 → 新对话」（无箭头极简版）。
     *
     * 用户 2026-11-16 选定：沿用「双窗传递」构图、把方块换成对话气泡；
     * 本轮再定：粗细不动，去掉箭头，只靠透明度与错位表达传递，20px 最干净。
     * 几何要点（20px 实测迭代过 4 版才定）：
     *   - 两个气泡沿对角拉开（旧左上 / 新右下），否则会挤成一团；
     *   - 线宽恒为 1.7（1.8 在 20px 下会糊），本版没有箭头、无需再加粗的 1.9；
     *   - 旧气泡 opacity .42 表示「已过去」，新气泡实线；全部 currentColor 跟随明暗。
     * 与 icon.svg（插件清单/管理面板图标）同形，只是那里用低饱和绿、这里用 currentColor。
     */
    function SidebarIcon(props) {
      const size = props && props.size ? props.size : 20
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        // 旧对话：左上，半透明，尾巴朝左下
        h('path', {
          d: 'M3 3.2h7.4a2.2 2.2 0 0 1 2.2 2.2v3a2.2 2.2 0 0 1-2.2 2.2H7.8l-2.7 2v-2H3a2.2 2.2 0 0 1-2.2-2.2v-3A2.2 2.2 0 0 1 3 3.2Z',
          opacity: .42,
        }),
        // 新对话：右下，实线，尾巴朝右下（与旧气泡拉开对角空档，无箭头）
        h('path', {
          d: 'M13.6 12.4h7.4a2.2 2.2 0 0 1 2.2 2.2v3a2.2 2.2 0 0 1-2.2 2.2h-2.4v2l-2.7-2h-2.3a2.2 2.2 0 0 1-2.2-2.2v-3a2.2 2.2 0 0 1 2.2-2.2Z',
        }))
    }

    /**
     * 功能 A：侧栏会话行染色观察器。
     * 注册到 shell.overlay（root scope、list 类型、整个 app 生命周期常驻），渲染 null。
     * - props.useSessionStatus 是宿主注入的 standard hook（顶层无条件调用）；
     * - Host 采集的失败/额度状态走 /api/auto-handoff/row-status 轮询；
     * - MutationObserver 只观察 childList/subtree（不观察 attributes，避免自触发死循环）；
     * - 状态优先级：quota/failed(红) > pending(橙) > running(黄) > done(绿) > none。
     */
    const TONE_LABEL = {
      pending: '待您处理', failed: '失败', quota: '额度用尽或失败',
      running: '进行中', done: '已完成，有未读消息', none: '',
    }
    function RowTintObserver(props) {
      const useSessionStatus = props.useSessionStatus
      const liveRef = useRef(null)
      const hostRef = useRef({})
      const live = useSessionStatus ? useSessionStatus((s) => s) : null
      liveRef.current = live

      const paint = useCallback(() => {
        if (typeof document === 'undefined') return
        const enabled = tintEnabled
        const liveMap = liveRef.current
        const hostMap = hostRef.current
        const rows = document.querySelectorAll('[data-row-key^="session:"]')
        for (const row of rows) {
          const sid = String(row.getAttribute('data-row-key') || '').slice('session:'.length)
          // 归档行在宿主里 class 是哈希的，稳定信号是 aria-description（仅归档会话行设置）。
          // 归档=退出活动流，按架构师决策强制抑制一切染色。
          const archived = row.hasAttribute('aria-description')
          const status = liveMap && typeof liveMap.get === 'function' ? liveMap.get(sid) : undefined
          const hostTone = hostMap[sid] // 'failed' | 'quota'
          let tone = 'none'
          // 关闭态：CSS 总闸已撤掉视觉，这里同时清掉 JS 写的文字角标属性，
          // 让行彻底回到宿主原生（架构师 §5：关闭=恢复原生外观）。
          if (enabled && !archived) {
            if (hostTone === 'quota' || hostTone === 'failed') tone = hostTone
            else if (status?.pendingInteraction) tone = 'pending'
            else if (status?.running) tone = 'running'
            else if (status?.completionUnread) tone = 'done'
          }
          if (row.getAttribute('data-dh75-tone') !== tone) row.setAttribute('data-dh75-tone', tone)
          // 文字状态（颜色非唯一信号）。先剥掉上一次加的前缀，避免状态切换时 label 叠加。
          const prev = row.getAttribute('data-dh75-label') || ''
          const baseTitle = (row.getAttribute('title') || '')
          const stripped = prev && baseTitle.startsWith(prev + '：')
            ? baseTitle.slice(prev.length + 1) : baseTitle
          const label = TONE_LABEL[tone]
          if (label) {
            if (prev !== label || stripped !== baseTitle) row.setAttribute('title', `${label}：${stripped}`)
            row.setAttribute('data-dh75-label', label)
          } else if (prev) {
            row.setAttribute('title', stripped)
            row.removeAttribute('data-dh75-label')
          }
        }
      }, [])

      useEffect(() => { paint() }, [live, paint])
      // 开关切换：CSS 总闸已由 setTintEnabled 一次置位；这里重扫可见行，
      // 清/写 JS 侧的 data-dh75-tone 与文字角标，使开与关都即时生效、无需刷新。
      useEffect(() => subscribeTint(() => paint()), [paint])
      useEffect(() => {
        ensureRowStyle()
        let alive = true
        const poll = async () => {
          try {
            const res = await fetch('/api/auto-handoff/row-status', { cache: 'no-store', credentials: 'same-origin' })
            if (!res.ok) return
            const data = await res.json()
            if (alive && data && data.ok && data.statuses) {
              hostRef.current = data.statuses
              paint()
            }
          } catch { /* 路由不可用（旧版/测试）时静默，绝不用推断标红 */ }
        }
        void poll()
        const timer = setInterval(poll, 2000)
        const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => paint()) : null
        if (mo && typeof document !== 'undefined') {
          mo.observe(document.body, { childList: true, subtree: true })
        }
        return () => {
          alive = false
          clearInterval(timer)
          mo?.disconnect()
          // 卸载时清理注入的样式与行属性，避免全局污染（架构师 §7）。
          removeRowStyle()
          if (typeof document !== 'undefined') {
            document.querySelectorAll('[data-dh75-tone]').forEach((r) => {
              r.removeAttribute('data-dh75-tone')
              const prev = r.getAttribute('data-dh75-label') || ''
              const t = r.getAttribute('title') || ''
              if (prev && t.startsWith(prev + '：')) r.setAttribute('title', t.slice(prev.length + 1))
              r.removeAttribute('data-dh75-label')
            })
          }
        }
      }, [paint])
      return null
    }

    /**
     * 中间列整页面板。
     *
     * width:100% 让内容铺满宿主给的可用宽度（宿主把 main slot 渲染成 flex 子项，
     * 只有 maxWidth 时宽度要等子元素撑开）。同时它是防御性的第二道保险：
     * 万一将来有人把 container-type:inline-size 加回 .dh75-root，
     * 这个显式宽度能避免「父子互等宽度 → 双双塌成 0px → 每字一行」的竖排事故。
     * 2026-11-16 真机实测踩过，勿删。
     */
    function MainPanel() {
      // 外面那层 .dh75-page 是滚动容器：宿主不会替我们滚，必须自带（见 CSS 注释）。
      return h('div', { className: 'dh75-page' },
        h('div', { style: { width: '100%', maxWidth: 720, margin: '0 auto', padding: '8px 4px 24px' } },
          h(Panel, { variant: 'main' })))
    }

    /** Settings 分区版：宽更窄，用紧凑变体。 */
    function SettingsPanel({ close }) {
      return h(Panel, { variant: 'compact', close })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式注入点：在这里做一次，保证面板渲染前样式已就位。
        ctx.effect(() => { ensureStyle() }, 'handoff-at-75.style')

        // 1) 左侧栏常驻入口。
        //    sidebar.panellist 的 id 与 main 的 key 必须一致，点击才会打开对应面板。
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'handoff-at-75',
          order: 60,
          label: () => '自动交接',
        }, SidebarIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'handoff-at-75',
        }, MainPanel))

        // 2) Settings 里的「自动交接」分区。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'handoff-at-75',
          order: 120,
          label: () => '自动交接',
        }, SettingsPanel))

        // 3) 功能 A：侧栏会话行染色观察器。shell.overlay 常驻、additive、渲染 null，
        //    不占版面、不与现有交互抢夺任何 slot。
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'handoff-at-75-row-tint',
        }, RowTintObserver))
      },
    }
  },
})

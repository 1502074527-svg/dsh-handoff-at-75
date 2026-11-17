# 投稿到 awesome-dsh-plugin · 操作清单

依据 `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md`（2026-11-17 核对）。
发布材料已在本目录备好，按下面顺序做即可。

## 0. 发布前先满足硬性条件

CI 会自动查这几项，缺一项就绿色不了：

- [ ] 把插件目录推成一个**公开 GitHub 仓库**（当前是本地目录，不是 git 仓库）
- [ ] 仓库创建**满 1 天**后再提 PR（太新的仓库会被自动过滤；重新提交不受惩罚）
- [ ] 给仓库加 **`dsh-plugin` topic**（仓库页 → About → Topics）
- [ ] `package.json` 的 `dsh.bundle` 和根目录 `cordis.patch.yml` 都已在仓库里（✅ 本地已具备）

## 1. 把发布材料带进仓库

本目录 `assets/` 下已备好：

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `icon-180.png` | 市场卡片图标（192×192，双气泡） | 文档**拒收 SVG**，必须用这个 PNG |
| `screenshots.json` | 截图清单（6 张） | 放在 `package.json` 同级的 `assets/` 下 |
| `screenshots/*.png` | 主面板/设置/四色染色/开关四态 | 路径是相对 `screenshots.json` 的，勿改名、勿加 `..` 或开头 `/` |
| `submission.yml.example` | 投稿条目模板 | 把 `OWNER/REPO` 换成真实仓库 |

- `screenshots.json` 已按文档要求写好：1–8 张、相对路径、无 `..`、无开头 `/`。提交到仓库后，下一次 nightly build 会自动收录（约每 24h）。
- 图标 URL 需指向 GitHub 托管地址，模板里写的 `raw.githubusercontent.com/.../main/assets/icon-180.png` 就是本图标推上去后的地址。

> 注意：`assets/` 目前**不在** `package.json` 的 `files` 白名单里。它不进 npm 包没关系——市场和截图读取的是 GitHub 仓库里的文件，不是 npm 包内容。

## 2. 打开 PR（只有一个文件）

在 `awesome-dsh-plugin` 仓库：

1. Fork → 新建分支
2. 新建文件 `data/plugins/<owner>__<repo>.yml`，内容来自 `submission.yml.example`（替换 `OWNER/REPO`）
   - 文件名规则：owner 和 repo 用 `__` 连接；含 `/` 或特殊字符按文档规则转换
3. **不要手改 README**——它由 `data/plugins/*.yml` 生成，合并后自动重建
4. 提 PR，一个 PR 最多 3 个条目（这里只有 1 个）

想本地预览生成结果（可选）：

```bash
cd awesome-dsh-plugin
npm ci
node scripts/generate-readme.mjs
```

提交生成结果也接受，但必须与数据源一致。

## 3. 条目内容核对点

模板里的描述已按文档逐条对照代码，没有夸大：

- `en` 以句号结尾；含 `: ` 已用单引号包裹（否则 YAML 解析失败）
- `category: session` —— 核心行为是会话到阈值自动续接；`workflow` 是备选，但分类不准只会被维护者直接改，不会打回
- 描述里提到的功能（交接文档、同 workspace 新会话、`-N` 后缀、四色染色开关）都能在代码里找到，没有写数字

## 4. 提交后会发生什么

- PR 触发 CI：查条目数量、`dsh.bundle`、仓库年龄、双语一致性、README 能否重新生成
- CI 过了是**前置条件不是结论**：维护者会实际读你的仓库，核对描述属实、分类合理、是否重复、源码有无可疑行为
- 需要改动时会以 PR 评论指出具体项，并打 `hold: author` 标签；推修复到同一分支再留一条评论即可，标签由维护者摘除
- 一个常见 red check 是 `READMEs match data/plugins`：这通常是你分支的 README 快照落后于 main，rebase 到最新 main 即可，不要自己改 README

## 可选：更好的安装体验

- 发 npm 包：预构建安装免 `allowBuilds` 构建授权（不影响收录，只是体验更好）
- 不发 npm：在 GitHub Release 挂预构建 tarball，条目里加 `tarball:` 字段指向它

# dsh-tinyfish

**给 dsh 免费用上搜索和抓取 —— 四个后端，藏在模型已经认识的那两个工具背后。**

[English](README.md) | 中文

![工具不变，后端免费](assets/hero.zh.png)

dsh 自带的 `web_search` / `web_fetch` 背后是 DeepSeek 的付费 Search & Fetch API。本项目保留这两个工具
—— 名字、参数、渲染全同 —— 只把请求转给免费的 TinyFish、Keenable、AnySearch、Exa，并行查询后融合。

## 你会得到什么

| | 原版 dsh | 装了这个 |
| --- | --- | --- |
| 成本 | 各 $0.75 / 1,000 次 | **$0** |
| 模型看到的工具 | `web_search`、`web_fetch` | `web_search`、`web_fetch` —— 完全不变 |
| 每次搜索的源 | 一个付费 API | 四个免费后端，融合去重 |
| 需要注册吗 | 要付费 Key | **不需要** —— 免 Key 源 + 免 Key 读正文 |
| 额外工具 / MCP | — | 没有 |
| 延迟（实测） | — | p50 **约 630ms**，800ms 软截止 |
| 可逆 | — | 一条 `--revert`，改前自动备份 |

## 让 agent 帮你装

复制下面这段给任意 coding agent（dsh、Claude Code、Codex 都行），它自带步骤和自检。

```text
把本机 dsh 的网页搜索/抓取换成免费的。不要删除、禁用或替换 tool-web，官方 web_search / web_fetch
的名字和参数必须保持原样。

git clone https://github.com/gg686-jkl/dsh-tinyfish.git && cd dsh-tinyfish
node install.mjs                              # 用户指定了 profile 才加 --profile <名字>

然后：原样贴回脚本打印的几行（provider row mounted / web seam pointed at the free provider /
official web_search/web_fetch enabled / search backends），运行
`dsh --profile "${DSH_PROFILE:-web}" --dump-config | grep -c web-tinyfish`（期望 1），并提醒我重启
app、开新会话。只允许改当前 profile 的 cordis.patch.yml（脚本会先备份）；不要写 AGENTS.md。
任何一步失败就直说，不要假装成功。完整版：https://github.com/gg686-jkl/dsh-tinyfish/blob/main/PROMPT.md
```

## 或者自己装

```bash
git clone https://github.com/gg686-jkl/dsh-tinyfish.git
cd dsh-tinyfish
node install.mjs
```

没有 git（手机上常见）：

```bash
curl -fsSL https://codeload.github.com/gg686-jkl/dsh-tinyfish/tar.gz/refs/heads/main | tar xz
cd dsh-tinyfish-main && node install.mjs
```

重启 dsh，开一个**新会话**，装完了。

[TinyFish key](https://agent.tinyfish.ai/api-keys) 是可选的：多一路搜索源，抓取也从「原始 HTML」变成
「提取后的正文」。

```bash
node install.mjs --key sk-tinyfish-xxxx --force
```

## 检查 / 撤销

```bash
dsh --profile "${DSH_PROFILE:-web}" --dump-config | grep -c web-tinyfish   # 期望 1
node install.mjs --revert                                                 # 回到原版
```

## 原理

```
web_search ─► tinyfish(Key) ┐
              keenable      ├─ 并行 ─► 加权 RRF ─► 去重 ─► 单站 2 条 ─► 取前 N
              anysearch     │
              exa(免Key)    ┘       800ms 软截止，2.5s 硬上限，5 分钟缓存

web_fetch  ─► tinyfish 提取正文 ─► exa 免 Key markdown ─► 直连 HTTP（按页面字符集解码）
```

只注册了一个 `ctx.web` provider。工具名、schema、描述、渲染仍归 `@deepseek-ai/dsh-tool-web`，所以模型
看到的和它训练时一模一样 —— 没有 `mcp__*` 前缀，也没有多出来的工具。

每个设计决定的动机、实测数字、以及**被否决的方案**都在
[docs/DESIGN.md](docs/DESIGN.md)。数字可复现：

```bash
node probe.mjs --bench     # 每源 recall/垃圾率/延迟 + 多策略对比，带 95% 置信区间
node --test bench/         # 融合、缓存、熔断、重试、凭据脱敏规则
```

## 常见问题

**某个源挂了或被限流怎么办？** 其他源照常回答。失败只记日志；连续失败的源冷却 1 分钟；限流不重试，
因为窗口期内重试还是 429。不会因为一个源出问题就返回空结果。

**工具会变吗？** 不会。名字、参数 schema、描述、输出格式全是官方原版。

**Key 真的可以不填？** 可以。搜索用免 Key 源，读正文走 Exa 免 Key 档。有 Key 才多一路源和正文提取。

**要花钱吗？** 在这个额度内不花钱：TinyFish 500 次搜索/小时、1,000 次抓取/天；Keenable 免 Key
1,000 次/小时；AnySearch 免 Key 1,000 次/天；Exa 免 Key 档按限流免费。

**怎么改启用哪些源？** 改 profile 的 `cordis.patch.yml` 里 `web-tinyfish` 行的 `backends:`，重启即可；
不认识的 id 会被忽略。

**怎么看一次搜索到底发生了什么？** 启动 dsh 前设 `DSH_WEB_DEBUG=1`，每次搜索打一行：各源延迟、融合后
条数、失败原因。

**权重是什么？** 每个源带 `trust`（Exa 1.0、TinyFish 0.95、Keenable 0.9、AnySearch 0.85），可用
`weights:` 覆盖。实测它和等权落在同一置信区间 —— 用途是让你在本机把不靠谱的源降权，不是号称排序更好。

**想要 24 个源和设置界面？** `node install.mjs --with-dsh-search` 装上
[bestnite/search](https://github.com/bestnite/search) 的插件（24 个后端、图形设置页、约 17 MB）。
它会往会话里加自己的工具；我们这条仍是默认值，工具列表保持干净。

**浏览器自动化、深度研究呢？** `--with-mcp` 会挂 TinyFish 的 MCP server。那些收费；搜索和抓取免费。

**dsh-go 手机端能用吗？** 能，同样的命令，不装任何依赖。

**以前装过旧版？** `node install.mjs --force` 原地升级。

## 说明

- 需要 dsh ≥ 0.2、Node ≥ 22；除了这个仓库本身，什么都不装。
- 各后端的端点、额度与接入规则参考 [bestnite/search](https://github.com/bestnite/search)（MIT，调研了
  24 家），免费子集由本项目零依赖实现。
- key 存在 `$DSH_HOME/tinyfish.key`（mode 600），不进 YAML。
- TinyFish 的抓取接口不返回 HTTP 状态码，所以提取成功时显示 `200`；直连兜底返回真实状态码。

MIT

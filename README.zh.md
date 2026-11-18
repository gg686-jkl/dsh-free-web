# dsh-tinyfish

**给 dsh 免费用上搜索和抓取 —— 四个免费后端，藏在模型已经认识的那两个工具背后。**

[English](README.md) | 中文

![工具不变，后端免费](assets/hero.zh.png)

dsh 自带的 `web_search` / `web_fetch` 背后是 DeepSeek 的付费 Search & Fetch API（**各 $0.75 / 1,000 次**）。
本项目保留这两个工具 —— 名字、参数、渲染全同 —— 只把请求转给免费的 TinyFish、Keenable、AnySearch、Exa，
并行查询后融合。**不用任何 Key 就能用**，不挂 MCP，也不增加任何工具。

## 让 agent 帮你装

复制下面这段，丢给任意 coding agent（dsh、Claude Code、Codex 都行）—— 它自带步骤，装完会自检。

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

重启 dsh，开一个**新会话**。此后搜索和抓取都走免费后端。

[TinyFish key](https://agent.tinyfish.ai/api-keys) 是可选的，加它有两点好处：多一路搜索源，
以及抓取返回干净的正文而不是原始 HTML。

```bash
node install.mjs --key sk-tinyfish-xxxx --force
```

## 检查

```bash
dsh --profile "${DSH_PROFILE:-web}" --dump-config | grep -c web-tinyfish   # 期望 1
```

## 撤销

```bash
node install.mjs --revert
```

## 常见问题

**实际跑的是什么？** `web_search` 同时问 TinyFish（有 Key 时）、Keenable、AnySearch（都免 Key）和
Exa（免 Key 的 MCP 档），再按**加权 RRF** 融合：按 URL 去重、按标题合并近重复页面、把「标题就是一个网址」
的条目降权，并限制单个站点最多占 2 条（一个站霸屏说明不了什么）。**软截止 800ms** —— 到点先返回已到的
结果，不再等最慢的源（2.5s 是硬上限）；重复查询走 5 分钟缓存；连续失败的源冷却 1 分钟；限流不重试，
因为窗口期内重试还是 429。`web_fetch` 依次尝试 TinyFish → Exa 免 Key MCP（markdown，不需要 Key）→
直连 HTTP（按页面声明的字符集解码，GBK 不再乱码）。

**工具会变吗？** 不会。名字、参数 schema、描述、输出格式都是官方原版；本项目只是注册 `ctx.web`
的 provider，模型看到的还是它训练时认识的那两个工具 —— 没有额外工具，也没有 `mcp__*` 前缀。

**要花钱吗？** 不用。TinyFish 搜索/抓取免费（500 次/小时、1,000 次抓取/天），Keenable 免 Key
1,000 次/小时，AnySearch 免 Key 1,000 次/天，Exa 免 Key 档按限流免费。换成 DeepSeek 自己的接口
是各 $0.75 / 1,000 次。

**Key 真的可以不填？** 可以。没有 Key 时用三个免 Key 源搜索；抓取也能拿到正文，因为 Exa 免 Key 档会
直接返回提取后的 markdown。

**怎么知道这些改动有用？** `node probe.mjs --bench` 只用采集一次的数据评估多套策略，每项带 Wilson
95% 置信区间；`docs/DESIGN.md` 记录了采纳和否决的每一项。52 条查询上：软截止把 p50 从 923ms 压到
632ms 且召回不变；站点上限把 top-5 里最大单站占比从 53% 降到 35%。规则本身由 `node --test bench/` 覆盖。

**怎么改启用哪些源？** 改 profile 的 `cordis.patch.yml` 里 `web-tinyfish` 行的 `config:`
（`backends: [tinyfish, keenable, anysearch, exa]`），重启即可。改之前先跑 `node probe.mjs`：
它不启动 dsh，直接测每个源的延迟和结果，用数据决定。

**想要 24 个源和设置界面？** `node install.mjs --with-dsh-search` 会装上
[bestnite/search](https://github.com/bestnite/search) 的插件（24 个后端、图形设置页、约 17 MB）。
它会往会话里加自己的几个工具；我们这条仍是默认值，所以工具列表保持干净。

**浏览器自动化、深度研究呢？** `--with-mcp` 会挂 TinyFish 的 MCP server。那些是收费能力；
搜索和抓取才是免费的。

**dsh-go 手机端能用吗？** 能，同样的命令，不装任何依赖。

**权重是什么？** 每个源带一个 `trust`（Exa 1.0、TinyFish 0.95、Keenable 0.9、AnySearch 0.85），
在融合里给它的话加权；可在 `web-tinyfish` 行的 `weights:` 里覆盖。实测它和等权落在同一个置信区间里 ——
它的用途是让你在本机把某个不靠谱的源降权，而不是号称排序更好。

**怎么看一次搜索到底发生了什么？** 启动 dsh 前设 `DSH_WEB_DEBUG=1`，每次搜索会打一行：各源延迟、
融合后条数、以及失败原因。

**以前装过 MCP-only 的旧版？** `node install.mjs --force` 原地升级。

## 说明

- 需要 dsh ≥ 0.2、Node ≥ 22；除了这个仓库本身，什么都不装。
- 各后端的端点、额度与接入规则参考 [bestnite/search](https://github.com/bestnite/search)（MIT，调研了 24 家），
  本项目零依赖地实现了其中的免费子集。
- key 存在 `$DSH_HOME/tinyfish.key`（mode 600），不进 YAML。
- TinyFish 的抓取接口不返回 HTTP 状态码，所以提取成功时工具显示 `200`；直连兜底返回真实状态码。

MIT

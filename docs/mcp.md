# 声明通道：让 agent 主动把知识写进图里

## 先看这里：插件自带的三个工具才是正路

插件注册了三个工具，**不需要任何额外配置**，模型直接就能用：

| 工具 | 用途 |
| --- | --- |
| `semantica_record_decision` | AI 声明**自己的**决策：选了什么、为什么、当时什么场景 |
| `semantica_add_entity` | 声明一个真实存在的实体（产品/库/概念/组织…） |
| `semantica_add_relationship` | 声明两个东西之间的关系 |

它们写进的是**当前会话**那张图，和侧边栏看到的完全是同一个文件
（`<harness>/dsh-semantica-graph/session-<会话id>.json`）。

**为什么不用上游那个 MCP server 来做这件事**：它是单例进程、内存里只有一张图、
落在固定的 `SEMANTICA_KG_PATH` —— 所有对话的声明会混在一起，而插件展示的单位是
当前会话。两条对齐的路都试过、都走不通：

- `dsh-mcp-client` spawn 子进程时环境会先过一道清洗，**所有 `DSH_*` 变量被删掉**，
  所以会话 id 传不进去；
- 配置里的 `env` 是静态字符串，**没有按会话插值的能力**。

插件自己的工具就没有这个问题：工具执行上下文里有 `exec.agent.session.header.id`，
天生知道该写哪个文件。拿不到会话 id 时**直接报错、一个文件都不写** ——
绝不猜一个默认值把 A 对话的知识写进 B 对话的图里。

**AI 的决策和用户的选择在图上分得开**：工具写的是 `decision_maker: "ai"`，
从提问工具读到的是 `decision_maker: "user"`。

**重新抽取不会丢掉声明**：重建只读对话日志，声明不在输入里，所以重建时会把
「标记过的」节点与边搬回来（`graph_worker.py` 的 `_carry_declared`）。搬回来的数量
在 stats 的 `carried` 里报出来。不这么做的话，用户每点一次「重新抽取」，
AI 声明过的东西就静默消失一次 —— 那种丢失事后补不回来。

---

# 可选：把上游的 semantica MCP 也接进来

上面那三个工具是插件自己实现的（会话级）。上游的 `semantica-mcp` 提供的是
**15 个工具 + 一张全局图**，适合「跨会话的长期知识库」这种用法 ——
`find_precedents`、`get_causal_chain`、`get_graph_analytics`、`run_reasoning`
这些插件没实现的都在它那边。两条路可以同时存在，互不干扰。

下面是接入它的配置。

上游 [semantica](https://github.com/semantica-agi/semantica) 推荐的用法是 **MCP 优先**
（它的 `integrations/openclaw/README.md` 把 MCP 标为 "(recommended)"，REST 是替代方案）。
`semantica-mcp` 把 15 个工具挂给模型，让 agent 在**做事的当下**把决策/实体/关系写进图里，
而不是等对话结束后有人去记录里反推。

本插件走的是另一条路：读会话事件、按规则重建图。两条路是互补的 ——
声明得到的是真决策（agent 自己说"我选了 X，因为 Y"），反推只能拿到事后可见的痕迹。
本文件只负责前者：把 MCP 通道接进 DSH。

## 接进来的配置

**推荐用安装脚本**，它是幂等的、动文件前先备份：

```bash
node scripts/install.mjs            # 安装（同时幂等维护 MCP 条目）
node scripts/install.mjs --dry-run  # 只打印将要做的事
node scripts/install.mjs --remove   # 连 MCP 条目一起移除
```

脚本写进 profile 的 patch 层（本机是
`~/Library/Application Support/dsh-desktop/harness/profiles/web/cordis.patch.yml`），
用一对哨兵标记圈住自己维护的那一段：

```
# >>> dsh-semantica-graph: semantica MCP   ← 标记之间的内容由脚本维护
# <<< dsh-semantica-graph: semantica MCP
```

标记之外一个字都不动（用文本级处理而不是 YAML 解析再序列化 —— 那个文件里有用户
自己的注释和 `!!js` 表达式，过一遍 parser/serializer 会把注释全丢掉）。
四种情况都验过：空列表 `[]` → 替换；用户已有条目 → 追加；重复跑 → 报「已是最新」；
`--remove` → 只摘掉标记块、用户自己的条目留着。

手动写的话，条目长这样（路径按需替换）：

```yaml
- insert:
    - id: mcp-semantica
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: semantica
        transport: stdio
        command: '/Users/<you>/Library/Application Support/dsh-desktop/harness/semantica-venv/bin/semantica-mcp'
        env:
          SEMANTICA_KG_PATH: '/Users/<you>/Library/Application Support/dsh-desktop/harness/dsh-semantica-graph/kg.json'
        failOnStartupError: false
```

`dsh-mcp-client` 一台服务器一条配置项，字段是**扁平**的（不是 `servers:` 映射），
必须是 `{id, name, config}` 的行。`insert` 不带 `id` 时是往根列表追加条目。

## 两个必须知道的限制

**1. 子进程环境会被清洗。** `dsh-mcp-client` 以 `scrubbedParentEnv()` 为基座 spawn 子进程：
删掉匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的环境变量名和**所有 `DSH_*`**，再合并配置里的 `env`。
所以 `SEMANTICA_KG_PATH` 必须在配置里显式写死，继承父进程环境是拿不到的。

**2. MCP resources 与 prompts 不受支持。** `dsh-mcp-client` 只桥接工具能力。
semantica 声明了 3 个 resource（`semantica://graph/summary`、`semantica://decisions/list`、
`semantica://schema/info`），在 DSH 里**不会**出现。需要那些内容就用对应的工具
（`get_graph_summary`、`query_decisions`）。

## 工具名

模型看到的是 `mcp__semantica__<tool>`，例如 `mcp__semantica__record_decision`。
serverName 是本地配置、固定不变，因此会话历史与权限规则在重启后仍然有效。

15 个工具：

| 用途 | 工具 |
| --- | --- |
| 决策 | `record_decision` `query_decisions` `find_precedents` `get_causal_chain` `analyze_decision_impact` |
| 图 | `add_entity` `add_relationship` `query_graph` `update_node` `delete_node` |
| 抽取 | `extract_entities` `extract_relations` |
| 推理与分析 | `run_reasoning` `get_graph_analytics` |
| 导出 | `export_graph` `get_graph_summary` |

## 验证

改完配置**不用重启**就能验证配置树（只 dump，不启动）：

```bash
DSH_HOME="$HOME/Library/Application Support/dsh-desktop/harness" \
  node "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile web --dump-config | grep -A 10 mcp-semantica
```

应该看到 `id: mcp-semantica` 那一行连同 `serverName`、`command`、`env` 都在。

单独验证服务器本身能握手（不经过 DSH）：

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
 | SEMANTICA_KG_PATH=/tmp/kg.json "$VENV/bin/semantica-mcp" 2>/dev/null
```

实测返回 `serverInfo {name: semantica, version: 0.6.8}` 与 15 个工具。

**工具是否真的挂上，要看 harness 重启后的工具列表** —— 配置层验证通过不等于连接成功。
`failOnStartupError: false` 时首次连接失败不会中止启动，只在日志里记录错误、工具不出现；
排查时把它设成 `true` 可以让失败直接暴露。

## 待解决：声明写进哪张图

`semantica-mcp` 是**单例图**：一个进程一张图，路径由 `SEMANTICA_KG_PATH` 决定
（`semantica_mcp/mcp/session.py`，启动时若文件非空则 `load_from_file`）。
而插件的展示单位是**当前会话**。两者对不上，有三种做法：

1. **共享一张图 + 按会话打标** —— agent 在 `record_decision(metadata={...})` 里带上会话标识，
   插件按标识过滤。要求 agent 知道自己的会话 id。
2. **按 Agent 作用域各起一个实例** —— `dsh-mcp-client` 允许不同 Agent 复用同一个 serverName
   （`activeServerNames` 是按注册作用域隔离的），所以每个 Agent 可以挂一份自己的配置、
   指向各自的 `SEMANTICA_KG_PATH`。能不能做到「每会话一份」取决于 DSH 的 Agent 作用域粒度，
   尚未验证。
3. **插件自己按会话 spawn 一份并注册工具** —— 隔离最彻底，等于自己实现一遍 MCP 桥接。

当前落盘的是**做法 1 的共享图**（`dsh-semantica-graph/kg.json`）。在选定之前，
插件侧展示的仍然是它自己重建的图（`session-<id>.json`），两者互不干扰。

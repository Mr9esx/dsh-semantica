# semantica MCP：让 agent 主动声明知识图谱

上游 [semantica](https://github.com/semantica-agi/semantica) 推荐的用法是 **MCP 优先**
（它的 `integrations/openclaw/README.md` 把 MCP 标为 "(recommended)"，REST 是替代方案）。
`semantica-mcp` 把 15 个工具挂给模型，让 agent 在**做事的当下**把决策/实体/关系写进图里，
而不是等对话结束后有人去记录里反推。

本插件走的是另一条路：读会话事件、按规则重建图。两条路是互补的 ——
声明得到的是真决策（agent 自己说"我选了 X，因为 Y"），反推只能拿到事后可见的痕迹。
本文件只负责前者：把 MCP 通道接进 DSH。

## 接进来的配置

写进 profile 的 patch 层（本机是
`~/Library/Application Support/dsh-desktop/harness/profiles/web/cordis.patch.yml`）：

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

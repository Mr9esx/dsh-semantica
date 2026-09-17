# 决策层与图分析：用的是 semantica 哪些原生能力

这份文档记录 `src/graph_worker.py` 里决策层与图分析部分**具体调了哪些上游接口、
为什么这么调、以及不调某些接口的实测依据**。所有数字都是在本机真实会话
（53 轮 / 1400 段 / ~21 万字符）上量出来的。

## 决策：`ContextGraph.record_decision`

### 为什么不再自己拼节点

原来是自己造 `type: "decision"` 节点、再照抄 Explorer 的
`explorer/routes/decisions.py` 读的那六个字段（category / scenario / reasoning /
outcome / confidence / timestamp）。能work，但代价是：

- 字段名对不上，那个区就**静默变空** —— 这种耦合本不该存在；
- 拿不到 semantica 自己的决策生命周期。因果链、影响面、先例检索、合规规则、
  PROV-O 导出，全部建立在它内部的决策索引上，手搓的节点进不去那套索引。

上游 README 的 Decision Intelligence 一节写得很直白：
"a decision is not a log line. It is a first-class graph node."
而 `Decision` 的字段和 Explorer 读的字段**完全一致** —— Explorer 的
`schemas.py` 里那个 timestamp 校验器的注释就是
`Accept the epoch floats ContextGraph.record_decision() writes`。
走原生接口是「按构造对齐」，不需要逆向任何人。

### 数据来源

只有对话里的提问工具（AskUserQuestion）同时带「问了什么 + 每个选项什么意思」
和「用户最终选了什么」，是会话中**唯一**结构化的选择记录。所以这一层记的是
**用户确认过的选择**，`decision_maker="user"`。

AI 自己做的决策埋在自然语言和思考过程里、没有结构，事后反推不可靠 ——
那种决策要由 agent 在做事的当下主动声明（见 [mcp.md](mcp.md)）。
两件事不能混：把用户的选择标成 AI 的决策是错的。

### 调用时踩到的三个坑

**1. 空字段会抛异常。** `record_decision` 对空 `category` / `scenario` / `reasoning`
直接抛 `ValueError: Category must be a non-empty string`。
而提问工具里这几个字段**本来就可能空**：`category` 是问题的 header，用户可以不填；
`reasoning` 是选中项的 description，自由输入时压根没有。实测 23 条决策里有 **8 条**缺字段。
补占位符而不是丢掉这条决策，占位符写明「原始记录里没有」，不是编一个理由出来。
补了多少条会在 stats 的 `decisionsFilled` 里报出来。

**2. 会额外建 `category` 与 `decision_maker` 节点。** 每条决策连一个
`belongs_to → category_<名字>` 边和一个 `made_by → user` 边。这是上游的建模方式，
保留：`category` 让同类的决策在图上聚到一起，`decision_maker` 让「谁决定的」可见。
代价是节点数多出 24 个（23 条决策 + 1 个 user）。

**3. `entities=` 参数决定决策连不连得上实体。** 不传的话决策在整个图里
只连着自己那个 category，而 Explorer 的决策详情面板里**唯一有实质内容的卡片就是
Causal Chain**（它走 `get_neighbors`）—— 少一类出边，面板就更空。
传了会建 `decision --involves--> entity` 边。

实体的匹配方式刻意用「实体名**字面出现**在决策文本里」，不用语义相似度：
提问文本里真的写了这个词，这是**事实**；语义相似是猜，猜错会污染图。
决策文本 = 问题标题 + 问题正文 + 选项文字 + 用户选的答案。

## 因果链：`add_causal_relationship`

关系类型只允许 `CAUSED` / `INFLUENCED` / `PRECEDENT_FOR` 三种。
这里邻接的两条决策之间用 **`INFLUENCED`**，理由是同一会话里前一条决策就在后一条
决策的上下文里（agent 的上下文窗口包含整段会话），所以「影响了」是可断言的；
而 `CAUSED` 需要真正的因果证据，这个图里没有，不能写。

取代了原来的 `next_decision` 自造边 —— 那条边名字自解释，但外部工具不认识它，
`find_precedents` / `get_causal_chain` 这类接口看不到。

一条决策最终的出边构成（实测，23 条决策）：

| 边 | 条数 | 来自 |
| --- | --- | --- |
| `involves` | 45 | `entities=` |
| `belongs_to` | 23 | `record_decision` 自动 |
| `made_by` | 23 | `record_decision` 自动 |
| `decided_at` | 23 | 我们补的：指向提问工具节点 |
| `INFLUENCED` | 22 | `add_causal_relationship` |

## 图分析：中心性、社区、连通分量

用 `ContextGraph(advanced_analytics=True)` 建图（上游 README 的写法），然后：

| 结果 | 接口 | 耗时 |
| --- | --- | --- |
| `degreeCentrality` | `CentralityCalculator.calculate_degree_centrality` | 0.1s |
| `eigenvectorCentrality` | `calculate_eigenvector_centrality` | 0.1s |
| `closenessCentrality` | `calculate_closeness_centrality` | 3.2s |
| `community` | `CommunityDetector.detect_communities`（louvain） | 0.9s |
| `component` / `componentSize` | `ConnectivityAnalyzer.analyze_connectivity` | — |

结果通过 `add_node_attribute` 写回节点属性，Explorer 的节点详情就能看到，
不需要改前端。实测 4140 个节点全部拿到属性。

### 刻意不算的

**betweenness —— 实测 4149 个节点要 18.3 秒**，而这张图的用处是「一眼看出哪些实体是枢纽」，
degree + eigenvector 各 0.1 秒就够了。

**`calculate_pagerank` —— 在 semantica 0.6.8 上是坏的**，直接抛
`RuntimeError: PageRank calculation failed: 'dict' object is not callable`。
不是我们不用，是用不了。

**`get_decision_insights()` —— 一个调用 23.6 秒。** 它返回的
`advanced_analytics` 里有五样东西，逐样核对过：

| 里面的东西 | 我们是否已有 |
| --- | --- |
| `centrality_analysis` | 已有，直接调 `CentralityCalculator` |
| `community_analysis` | 已有，直接调 `CommunityDetector` |
| `graph_metrics` | 节点/边计数，本来就有 |
| `connectivity_analysis` | **没有** → 已用 `ConnectivityAnalyzer` 补上 |
| `node_embeddings` | node2vec 128 维，只服务先例/相似度检索 |

汇总字段（`total_decisions` / `categories` / `outcomes` / `confidence_stats`）
逐字段比对过，**我们自己算的和它算的完全一致**，所以不吃这个亏。

那 23.6 秒基本都花在 `node_embeddings` 上：4140 个节点 × 128 维。
那些向量导出的 JSON 用不上（塞进去会让文件大一个数量级），而且需要用它的地方
（`find_precedents`、相似决策检索）在 **MCP server 自己的进程里**，它会自己算。
所以这是「不在导出路径上重复计算」，不是丢准确度。

另外它返回的社区是 `frozenset`，整个塞进 JSON 会让 worker 的响应序列化直接炸掉
（实测 `TypeError: Object of type frozenset is not JSON serializable`）—— 这是不用它的第二个理由。

## 耗时构成

一次完整重建（53 轮 / 1400 段）实测：

| 阶段 | 耗时 |
| --- | --- |
| NER 抽取 | 11.4s |
| 关系抽取 | 0.8s |
| 骨架（轮/消息/工具节点） | 0.01s |
| 建图 + 决策 + 因果边 | 0.1s |
| 图分析（三种中心性 + 社区） | 4.3s |
| 落盘 | 0.1s |
| **合计** | **~17s** |

决策与图分析这一层只占 4.4 秒 —— 贵的从来是 NER。

## 已知取舍：因果链的长度

Explorer 的 `/api/decisions/{id}/chain` 走 `get_neighbors(id, 5)`，也就是**5 跳邻域**。
`involves` 边接上之后，每条决策的链从个位数涨到 **78~121 步**
（实测 6 条：11 / 121 / 78 / 111 / 83 / 114），而前端是 `t.map` 直接渲染、没有截断。

根因不是 hop-1 的实体数（已按「在文本里出现的位置」排序后限到 5 个，
实测 `involves` 从 48 条降到 45 条 —— 多数决策本来就只有 ≤5 个实体）。
是 hop-2 之后顺着实体继续展开导致的。

想回到 1~5 步的短链，唯一的开关是**不传 `entities=`**（决策就只剩
`decided_at` / `belongs_to` / `made_by` / `INFLUENCED` 四类出边）。
代价是决策与实体之间**没有任何直接关联**，`entity_analysis` 归零。
当前选择保留实体关联（准确优先），链长偏长的问题留给前端处理。

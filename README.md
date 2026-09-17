# dsh-semantica-graph

把 DSH 的对话，自动变成知识图谱。

图在对话里看，不用去翻聊天记录。

长版文档在 `docs/` 里：
[设计取舍与事故复盘](docs/技术细节.md)

## 能干什么

- 对话里开个开关，每轮自动抽取知识。
- 面板里看「本对话」这张图。
- 也能看整台机器的「全部」图。
- 展示用 semantica 自带的 Explorer。
- 分析（枢纽/社区/决策）插件自己算。

## 装

```bash
node scripts/install.mjs
```

要重启一次 DSH Desktop 才生效。

退回官方 MCP：`node scripts/install.mjs --upstream`

## 用

1. 打开「知识图谱」标签页。
2. 在输入框那一排点「图谱提取 开」。
3. 模型从下一轮开始自己写。

面板是空的时候别慌，它给了两步：

① 点「复制提取指令」 ② 粘到输入框发出去

## 图存在哪

| 文件 | 里面是什么 |
| --- | --- |
| `kg.json` | 所有会话的合并图 |
| `sessions/<会话>.json` | 只有本对话写的东西 |

「本对话」优先读自己那份。

读不到才退回按会话标筛。

## 自检

```bash
npm run check
npm run selftest
npm run visual
```

包装层要用 semantica venv 的 python：

```bash
"$DSH_SEMANTICA_PYTHON" \
  mcp/selftest.py
```

## 已知边界

- 开关只能「要求」模型写，不能强制它写。
- 没带 entities 的决策不进本对话。
- 中文 NER 漏抽，图会偏薄。
- 老会话没有自己的文件，只能退回筛选。
- 包装层之前的数据不带会话标。

## 许可

MIT

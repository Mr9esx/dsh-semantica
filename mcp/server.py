#!/usr/bin/env python3
"""DSH 版本地 Semantica MCP server：**写入按会话分文件**。

## 为什么要包这一层

上游 `semantica.mcp_server` 的存储假设是「一台机器一张图」：一个 `SEMANTICA_KG_PATH`，
所有会话的写入都落进同一个文件。于是两个会话写同一个 id 时会互相覆盖 —— 真实案例：
`session-d1648c08` 先写 `guangzhou`（type=Location，带 user_city），`session-d7c9295a`
之后也写 `guangzhou`（type=City），而 semantica 的 `add_entity` 是**整套 metadata 替换**，
前一个会话的字段就没了 —— 前一个会话的「本对话」视图也跟着少一个节点（它还导致过一条
悬挂边：边还在、端点没了）。

## 怎么包（不复制上游语义）

import 上游的 `TOOLS` 与 stdio 循环，只把 5 个**写**工具的 handler 包一层：

  1. 先照现状写**合并图**（`SEMANTICA_KG_PATH`）—— 「全部」视图、跨会话复用、回退到上游
     都靠它，行为与不装本包装层时完全一致；
  2. 再把上游的图对象与落盘路径**临时**切到 `<sessions>/<conversation>.json`，跑**同一个
     handler** —— 得到本会话自己的物理文件。别的会话再怎么写，都动不了它。

之所以敢用「换路径 + 重跑同一个函数」而不是自己重写一遍写入逻辑：上游每个写 handler 都是
**在调用时**读 `os.environ["SEMANTICA_KG_PATH"]` 并 `graph.save_to_file(...)`，并且都带着
「落盘失败就回滚内存」的处理。重写一遍等于把它的语义复制一份，早晚会漂。

读工具**不路由**：`query_graph` / `query_decisions` / `find_precedents` 看的仍是合并图 ——
跨会话复用（同一条知识不重复建节点）必须保留，这是这个图的立身之本。

## 怎么知道是哪个会话

· `add_entity` / `add_relationship`：`metadata.conversation`（提示词里已强制要求带）；
· `record_decision` / `update_node` / `delete_node`：优先参数 `conversation`（本服务器给这
  三个工具额外加了可选参数，`tools/list` 里能看到），没有就拿 `entities` / `node_id` 去合并
  图里查这些节点带的标（兜底，等价于现状）；
· 都拿不到 → **只写合并图**。不猜：宁可退化成现状，也不要往错误的会话文件里写。

## 环境变量

· `SEMANTICA_KG_PATH`：合并图（上游本来就要的）；
· `DSH_SEMANTICA_SESSIONS_DIR`：会话文件目录，默认 `<合并图同目录>/sessions/`。
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any, Callable, Optional

# 上游：工具定义、图对象、stdio 循环全用它的
import semantica.mcp_server as up

#: 需要按会话镜像的写工具（读工具不动）
WRITE_TOOLS = frozenset(
    {"add_entity", "add_relationship", "record_decision", "update_node", "delete_node"}
)

#: 给这几个「上游没有 metadata」的工具额外加一个可选参数（提示词也会让模型显式带上）
NEEDS_CONVERSATION_ARG = ("record_decision", "update_node", "delete_node")

#: 最多缓存多少个会话的图对象（每个会话一个 ContextGraph）
MAX_CACHED_SESSIONS = 64

_session_graphs: dict[str, Any] = {}

log = up.log


# ── 路径 ────────────────────────────────────────────────────────────────────
def merged_path() -> str:
    """合并图路径（上游的 SEMANTICA_KG_PATH）。"""
    return os.environ.get("SEMANTICA_KG_PATH", "").strip()


def sessions_dir() -> Path:
    """会话文件目录。默认跟合并图放一起，方便用户一眼看全。"""
    raw = os.environ.get("DSH_SEMANTICA_SESSIONS_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    mp = merged_path()
    base = Path(mp).expanduser().parent if mp else Path.home() / ".dsh"
    return base / "sessions"


def session_file(conversation: str) -> Path:
    """某个会话的图文件。文件名要做净化 —— 会话 id 来自模型，不能直接当路径用。"""
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", conversation).strip("_")[:120] or "unknown"
    return sessions_dir() / f"{safe}.json"


# ── 图对象 ──────────────────────────────────────────────────────────────────
def _new_graph():
    from semantica.context import ContextGraph

    return ContextGraph(advanced_analytics=True)


def session_graph(conversation: str):
    """本会话的图对象（懒加载 + 缓存）。"""
    key = str(session_file(conversation))
    cached = _session_graphs.get(key)
    if cached is not None:
        return cached

    graph = _new_graph()
    path = Path(key)
    try:
        if path.exists() and path.stat().st_size > 0:
            graph.load_from_file(str(path))
    except Exception:
        log.warning("本会话图文件读不了，按空图起点继续：%s", path, exc_info=True)

    if len(_session_graphs) >= MAX_CACHED_SESSIONS:
        _session_graphs.pop(next(iter(_session_graphs)), None)
    _session_graphs[key] = graph
    return graph


# ── 认会话 ──────────────────────────────────────────────────────────────────
def _clean(value: Any) -> Optional[str]:
    return value.strip() if isinstance(value, str) and value.strip() else None


def owner_of_node(node_id: str) -> Optional[str]:
    """从**合并图**里读这个节点带的会话标。

    注意层级：上游存节点的形状是
    `{"id":…, "type":…, "content":…, "metadata": {"label":…, "metadata": {<用户 metadata>}}}`，
    用户 metadata（`conversation` 在里面）嵌在第二层。
    """
    try:
        graph = up._get_graph()  # noqa: SLF001 —— 就是上游那唯一的图对象
        for node in graph.find_nodes():
            if not isinstance(node, dict) or node.get("id") != node_id:
                continue
            meta = node.get("metadata")
            if not isinstance(meta, dict):
                return None
            inner = meta.get("metadata")
            if isinstance(inner, dict):
                found = _clean(inner.get("conversation"))
                if found:
                    return found
                # 兜底：有的写入把 conversation 放在第一层
                found = _clean(meta.get("conversation"))
                if found:
                    return found
            return _clean(meta.get("conversation"))
    except Exception:
        log.debug("查节点归属失败：%s", node_id, exc_info=True)
    return None


def conversation_of(tool: str, args: dict) -> Optional[str]:
    """这次写入算哪个会话的。拿不到就返回 None（只写合并图）。"""
    found = _clean(args.get("conversation"))
    if found:
        return found

    meta = args.get("metadata")
    if isinstance(meta, dict):
        found = _clean(meta.get("conversation"))
        if found:
            return found

    # record_decision 走 entities，update/delete 走 node_id，add_* 的 id 也可能就是标的载体
    candidates: list[str] = []
    entities = args.get("entities")
    if isinstance(entities, list):
        candidates += [e for e in entities if isinstance(e, str) and e.strip()]
    for key in ("node_id", "id"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            candidates.append(value)
    for node_id in candidates:
        owner = owner_of_node(node_id)
        if owner:
            return owner
    return None


# ── 镜像写入 ────────────────────────────────────────────────────────────────
def mirror(tool: str, handler: Callable[[dict], dict], args: dict, conversation: str) -> dict:
    """把同一次写入再跑一遍，落到本会话的文件里。"""
    target = session_file(conversation)
    graph = session_graph(conversation)

    saved_graph = up._graph  # noqa: SLF001
    saved_path = os.environ.get("SEMANTICA_KG_PATH")
    up._graph = graph  # noqa: SLF001 —— 上游 handler 里的 _get_graph() 会拿到它
    os.environ["SEMANTICA_KG_PATH"] = str(target)
    try:
        return handler(args)
    finally:
        up._graph = saved_graph  # noqa: SLF001
        if saved_path is None:
            os.environ.pop("SEMANTICA_KG_PATH", None)
        else:
            os.environ["SEMANTICA_KG_PATH"] = saved_path


def wrap(tool: str, handler: Callable[[dict], dict]) -> Callable[[dict], dict]:
    """包一个写工具：先合并图（现状），再会话文件（新增）。"""

    def wrapped(args: Optional[dict] = None) -> dict:
        payload = args if isinstance(args, dict) else {}
        # 1) 合并图：这一步的结果就是返回给模型的结果，和不装包装层时一模一样
        result = handler(payload)

        # 2) 会话文件：失败绝不影响模型看到的结果（只记日志）
        conversation = conversation_of(tool, payload)
        if not conversation:
            log.info("工具 %s 认不出会话，只写合并图", tool)
            return result
        try:
            mirrored = mirror(tool, handler, payload, conversation)
        except Exception:
            log.warning("工具 %s 写入会话 %s 失败", tool, conversation, exc_info=True)
            return result
        if isinstance(mirrored, dict) and mirrored.get("error"):
            # 常见且无害：这个节点/边在本会话文件里不存在（比如删的是别的会话建的节点）
            log.info("工具 %s 在会话 %s 上无效：%s", tool, conversation, mirrored.get("error"))
        return result

    wrapped.__name__ = f"dsh_wrapped_{tool}"
    return wrapped


def install() -> list[str]:
    """把包装挂到上游工具表上。返回被包装的工具名。"""
    patched: list[str] = []
    for tool in up.TOOLS:
        name = tool.get("name")
        if name in WRITE_TOOLS:
            original = tool["_handler"]
            if getattr(original, "__name__", "").startswith("dsh_wrapped_"):
                continue  # 幂等（--reload 之类重复调用时别套两层）
            tool["_handler"] = wrap(name, original)
            patched.append(name)
        if name in NEEDS_CONVERSATION_ARG:
            _add_conversation_param(tool)
    return patched


def _add_conversation_param(tool: dict) -> None:
    """给 record_decision / update_node / delete_node 的 schema 加一个可选参数。"""
    schema = tool.get("inputSchema")
    if not isinstance(schema, dict):
        return
    props = schema.get("properties")
    if not isinstance(props, dict) or "conversation" in props:
        return
    props["conversation"] = {
        "type": "string",
        "description": (
            "本会话的 id（形如 session-xxxx）。带上它，这次写入会同时落到这个会话自己的图"
            "文件里；不带也能工作（会按 entities / node_id 去查归属）。"
        ),
    }


def main() -> None:
    patched = install()
    log.warning(
        "DSH semantica-mcp 包装层已启用：写入按会话分文件；合并图=%s；会话目录=%s；已包 %s",
        merged_path() or "(未设置)",
        sessions_dir(),
        ",".join(patched) or "(无)",
    )
    up.main()


if __name__ == "__main__":
    sys.exit(main())

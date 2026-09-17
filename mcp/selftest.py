#!/usr/bin/env python3
"""包装层自检：起一个真的 server 子进程，走真的 JSON-RPC。

重点复现真实事故而不是只测 happy path：

  session-d1648c08 先写 `guangzhou`（type=Location + user_city），
  session-d7c9295a 之后也写 `guangzhou`（type=City）。

上游的 add_entity 是整套 metadata 替换，所以合并图里只剩后一个 —— 但**两个会话各自的
文件里必须各自保留自己写的那份**，这正是 C 要买到的东西。

文件格式（`ContextGraph.save_to_file`）：
    {"graph_id":…, "nodes":[{"id":…, "type":…, "properties":{"label":…, "metadata":{<用户 metadata>}, …}}],
     "edges":[…], "links":[]}
决策不是单独的数组，而是 `type == "decision"` 的节点（category/outcome/confidence 都在
properties 里）。

用法：python3 mcp/selftest.py   （退出码非 0 表示有断言没通过）
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE / "server.py"

# 自检必须用**装了 semantica 的那个解释器**跑。系统 python / conda 里没有它，直接跑会在
# 子进程里炸出一串 ImportError，看起来像包装层坏了 —— 所以先说人话。
try:
    import semantica  # noqa: F401
except ImportError:  # pragma: no cover
    print(
        "这个脚本要在装了 semantica 的解释器下跑（venv），比如：\n"
        '  "$HOME/Library/Application Support/dsh-desktop/harness/semantica-venv/bin/python" mcp/selftest.py',
        file=sys.stderr,
    )
    raise SystemExit(2)

CONV_A = "session-d1648c08-61b2-4b1b-80ff-8ac31ac8944d"
CONV_B = "session-d7c9295a-9a19-42cc-a11d-468209728143"

failures: list[str] = []
checks = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global checks
    checks += 1
    print(f"{'✓' if ok else '✗'} {label}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(label)


class Server:
    """一个真的 server 子进程（stdio JSON-RPC）。"""

    def __init__(self, merged: Path, sessions: Path):
        env = dict(os.environ)
        env["SEMANTICA_KG_PATH"] = str(merged)
        env["DSH_SEMANTICA_SESSIONS_DIR"] = str(sessions)
        env["SEMANTICA_LOG_LEVEL"] = "ERROR"
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            bufsize=1,
        )
        self.seq = 0
        self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}})

    def rpc(self, method: str, params: dict | None = None) -> dict:
        self.seq += 1
        req: dict = {"jsonrpc": "2.0", "id": self.seq, "method": method}
        if params is not None:
            req["params"] = params
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("server 没回话")
        return json.loads(line)

    def call(self, tool: str, args: dict) -> dict:
        resp = self.rpc("tools/call", {"name": tool, "arguments": args})
        if "error" in resp:
            return {"error": resp["error"].get("message", "rpc error")}
        return json.loads(resp["result"]["content"][0]["text"])

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


# ── 读文件的小工具（结构对齐上面 docstring） ────────────────────────────────
def raw(path: Path) -> dict:
    if not path.exists():
        return {}
    data = json.loads(path.read_text("utf8"))
    return data if isinstance(data, dict) else {}


def nodes(path: Path) -> dict[str, dict]:
    return {n.get("id"): n for n in (raw(path).get("nodes") or []) if isinstance(n, dict)}


def props(path: Path, node_id: str) -> dict:
    node = nodes(path).get(node_id) or {}
    value = node.get("properties")
    return value if isinstance(value, dict) else {}


def meta(path: Path, node_id: str) -> dict:
    value = props(path, node_id).get("metadata")
    return value if isinstance(value, dict) else {}


def decisions(path: Path) -> list[dict]:
    return [n for n in (raw(path).get("nodes") or []) if isinstance(n, dict) and n.get("type") == "decision"]


def edges(path: Path) -> int:
    return len(raw(path).get("edges") or [])


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="dsh-semantica-mcp-") as tmp:
        root = Path(tmp)
        merged = root / "kg.json"
        sessions = root / "sessions"
        merged.write_text("", "utf8")
        file_a = sessions / f"{CONV_A}.json"
        file_b = sessions / f"{CONV_B}.json"

        # ── 路径契约：包装层和插件必须算出同一个文件名，否则插件会静默退回按标筛 ──
        sys.path.insert(0, str(HERE))
        import server as wrapper  # noqa: PLC0415

        import os as _os

        saved_dir = _os.environ.pop("DSH_SEMANTICA_SESSIONS_DIR", None)
        saved_kg = _os.environ.get("SEMANTICA_KG_PATH")
        try:
            _os.environ["SEMANTICA_KG_PATH"] = str(merged)
            check(
                "没设 DSH_SEMANTICA_SESSIONS_DIR 时，会话目录默认落在合并图同级的 sessions/（插件算的是同一条）",
                str(wrapper.session_file(CONV_A)) == str(sessions / f"{CONV_A}.json"),
                str(wrapper.session_file(CONV_A)),
            )
            check(
                "会话 id 里的路径成分被净化（与 src/kg.js 的 sessionGraphPath 同一张表）",
                wrapper.session_file("../../evil/id").name == "evil_id.json"
                and wrapper.session_file("session-abc-123").name == "session-abc-123.json"
                and wrapper.session_file("").name == "unknown.json",
                " / ".join(
                    wrapper.session_file(x).name for x in ("../../evil/id", "session-abc-123", "")
                ),
            )
        finally:
            _os.environ.pop("DSH_SEMANTICA_SESSIONS_DIR", None)
            if saved_dir is not None:
                _os.environ["DSH_SEMANTICA_SESSIONS_DIR"] = saved_dir
            if saved_kg is None:
                _os.environ.pop("SEMANTICA_KG_PATH", None)
            else:
                _os.environ["SEMANTICA_KG_PATH"] = saved_kg

        srv = Server(merged, sessions)
        try:
            tools = srv.rpc("tools/list")["result"]["tools"]
            names = sorted(t["name"] for t in tools)
            check(
                "tools/list 一个都不少（15 个，包装层不许悄悄丢工具）",
                len(names) == 15 and {"delete_node", "update_node", "query_graph"} <= set(names),
                ",".join(names),
            )
            check(
                "record_decision / update_node / delete_node 的 schema 里多了可选参数 conversation",
                all(
                    "conversation" in (t.get("inputSchema", {}).get("properties") or {})
                    for t in tools
                    if t["name"] in ("record_decision", "update_node", "delete_node")
                ),
                json.dumps(
                    {
                        t["name"]: sorted(t.get("inputSchema", {}).get("properties") or {})
                        for t in tools
                        if t["name"] in ("record_decision", "update_node", "delete_node")
                    },
                    ensure_ascii=False,
                ),
            )
            check(
                "没给读工具乱加参数（query_graph 的参数集没变）",
                "conversation"
                not in (next(t for t in tools if t["name"] == "query_graph")["inputSchema"].get("properties") or {}),
                "",
            )

            # ── 事故剧本：两个会话写同一个 id ────────────────────────────────
            srv.call(
                "add_entity",
                {
                    "id": "guangzhou",
                    "label": "广州",
                    "type": "Location",
                    "metadata": {"conversation": CONV_A, "user_city": True},
                },
            )
            check("A 写完后才有 A 的会话文件", file_a.exists())
            check("B 没写过，B 的文件不该被凭空创建", not file_b.exists(), str(file_b))
            check(
                "A 的文件里 guangzhou 是 A 写的样子（type=Location + user_city）",
                nodes(file_a).get("guangzhou", {}).get("type") == "Location"
                and meta(file_a, "guangzhou").get("user_city") is True
                and meta(file_a, "guangzhou").get("conversation") == CONV_A,
                json.dumps(props(file_a, "guangzhou"), ensure_ascii=False)[:200],
            )
            check(
                "合并图里也有（现状路径没被破坏）",
                nodes(merged).get("guangzhou", {}).get("type") == "Location",
                json.dumps(props(merged, "guangzhou"), ensure_ascii=False)[:160],
            )

            srv.call(
                "add_entity",
                {
                    "id": "guangzhou",
                    "label": "广州市",
                    "type": "City",
                    "metadata": {"conversation": CONV_B, "note": "B 的写法"},
                },
            )
            check(
                "合并图里被 B 覆盖了（上游行为，包装层不掩盖）",
                nodes(merged).get("guangzhou", {}).get("type") == "City"
                and meta(merged, "guangzhou").get("conversation") == CONV_B,
                json.dumps(props(merged, "guangzhou"), ensure_ascii=False)[:200],
            )
            check(
                "★ A 的文件里仍是 A 那份（Location + user_city 一个不少）",
                nodes(file_a).get("guangzhou", {}).get("type") == "Location"
                and meta(file_a, "guangzhou").get("user_city") is True
                and meta(file_a, "guangzhou").get("conversation") == CONV_A,
                json.dumps(props(file_a, "guangzhou"), ensure_ascii=False)[:200],
            )
            check(
                "B 的文件里是 B 那份",
                nodes(file_b).get("guangzhou", {}).get("type") == "City",
                json.dumps(props(file_b, "guangzhou"), ensure_ascii=False)[:160],
            )

            # ── 边也分流 ────────────────────────────────────────────────────
            srv.call(
                "add_entity",
                {"id": "weather-a", "label": "A 的天气", "type": "Observation", "metadata": {"conversation": CONV_A}},
            )
            srv.call(
                "add_relationship",
                {
                    "source": "guangzhou",
                    "target": "weather-a",
                    "type": "HAS_WEATHER",
                    "metadata": {"conversation": CONV_A},
                },
            )
            check("A 的文件里有 1 条边", edges(file_a) == 1, str(edges(file_a)))
            check("B 的文件里 0 条边", edges(file_b) == 0, str(edges(file_b)))
            check("合并图里 1 条边", edges(merged) == 1, str(edges(merged)))

            # ── record_decision：三条认会话的路径 ───────────────────────────
            srv.call(
                "record_decision",
                {
                    "category": "A 的决策",
                    "scenario": "只看 A 自己写的节点",
                    "reasoning": "weather-a 只有 A 写过，标没被别人覆盖",
                    "outcome": "归到 A",
                    "confidence": 0.9,
                    "entities": ["weather-a"],
                },
            )
            check(
                "★ 不传 conversation，也能按 entities 的标归到 A",
                len(decisions(file_a)) == 1 and len(decisions(file_b)) == 0,
                json.dumps({"a": len(decisions(file_a)), "b": len(decisions(file_b))}),
            )

            srv.call(
                "record_decision",
                {
                    "category": "B 的决策",
                    "scenario": "显式传 conversation",
                    "reasoning": "entities 为空也认得出",
                    "outcome": "归到 B",
                    "confidence": 0.5,
                    "conversation": CONV_B,
                },
            )
            check(
                "★ 显式传 conversation 时归到 B（entities 为空也行）",
                len(decisions(file_b)) == 1,
                str(len(decisions(file_b))),
            )

            # 这条专门盯住设计边界：guangzhou 的标已经被 B 覆盖，按 entities 推出来的是 B
            srv.call(
                "record_decision",
                {
                    "category": "边界",
                    "scenario": "entities 指向一个被别的会话覆盖过标的节点",
                    "reasoning": "MCP 里没有调用方身份，只能从数据推",
                    "outcome": "跟着现在的标走（B）",
                    "confidence": 0.4,
                    "entities": ["guangzhou"],
                },
            )
            check(
                "被覆盖过标的节点：自动归属跟着新标走（已知边界，靠显式 conversation 解决）",
                len(decisions(file_b)) == 2 and len(decisions(file_a)) == 1,
                json.dumps({"a": len(decisions(file_a)), "b": len(decisions(file_b))}),
            )

            merged_before = len(decisions(merged))
            srv.call(
                "record_decision",
                {
                    "category": "无归属",
                    "scenario": "既没有 conversation 也没有 entities",
                    "reasoning": "测兜底",
                    "outcome": "只进合并图",
                    "confidence": 0.3,
                },
            )
            check(
                "认不出会话时只写合并图（不猜）",
                len(decisions(merged)) == merged_before + 1
                and len(decisions(file_a)) == 1
                and len(decisions(file_b)) == 2,
                json.dumps(
                    {"merged": len(decisions(merged)), "a": len(decisions(file_a)), "b": len(decisions(file_b))}
                ),
            )

            # ── update_node / delete_node ──────────────────────────────────
            srv.call("update_node", {"node_id": "weather-a", "properties": {"status": "done"}, "conversation": CONV_A})
            check(
                "update_node + conversation 落到 A 的文件",
                props(file_a, "weather-a").get("status") == "done",
                json.dumps(props(file_a, "weather-a"), ensure_ascii=False)[:200],
            )
            srv.call("delete_node", {"node_id": "weather-a", "conversation": CONV_A})
            check(
                "delete_node 是软删（status=archived），A 的文件跟着变",
                props(file_a, "weather-a").get("status") == "archived",
                json.dumps(props(file_a, "weather-a"), ensure_ascii=False)[:200],
            )
            check(
                "B 的文件没被 A 的操作碰到",
                "weather-a" not in nodes(file_b),
                json.dumps(sorted(nodes(file_b)), ensure_ascii=False),
            )

            # ── 读工具不路由：跨会话复用必须保留 ───────────────────────────
            blob = json.dumps(srv.call("query_graph", {"mode": "search", "query": "guangzhou"}), ensure_ascii=False)
            check("query_graph 看的仍是合并图（B 的内容读得到，跨会话复用不丢）", "guangzhou" in blob, blob[:200])
        finally:
            srv.close()

    print()
    if failures:
        print(f"包装层自检：{checks - len(failures)}/{checks} 通过，{len(failures)} 项未通过")
        for name in failures:
            print(f"  ✗ {name}")
        return 1
    print(f"包装层自检全部通过（{checks} 项）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

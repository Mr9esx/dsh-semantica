#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-semantica-graph 的 Python 工作进程。

常驻运行，按 NDJSON 协议从 stdin 读请求、向 stdout 写响应：

    请求  {"id":1,"cmd":"build_context_graph","payload":{"segments":[...],"outPath":"..."}}
    响应  {"id":1,"ok":true,"stats":{...}}
    响应  {"id":1,"ok":false,"error":"..."}

启动后立刻写一行 {"ready":true,"semantica":"<版本>"}，让 Node 侧能区分
「进程没起来」与「请求失败」。

建图用的是 Semantica 本体的能力：
  - NamedEntityRecognizer  → 实体（人 / 组织 / 地点 / 概念 / 文件 / 技术…）
  - RelationExtractor      → 实体之间的关系三元组
  - ContextGraph           → 上游的原生图结构，交给它自带的 Explorer 浏览
三者都来自 semantica 这个开源库的公开入口。

图的骨架（轮次 / 消息 / 工具调用）由 Node 侧从 DSH 会话事件抽好一并送进来，
Python 侧负责语义层：从文本里抽出实体与关系，组装成 ContextGraph 并落盘。
"""

import sys
import os
import json
import time
import re
import traceback
from datetime import datetime

# ── 版本探测（import 可能很慢，先报版本不阻塞协议） ──────────────────────────

SEMANTICA_VERSION = "unknown"

# 关系抽取的规模上限（见 build_graph 里的说明）。
# Semantica 默认关系是共现式的 O(实体对)，不限规模时长会话会跑到分钟级。
MAX_REL_ENTS = 12      # 每段最多送多少个实体去配对
MAX_REL_CHARS = 1200   # 每段送进去的文本上限
_import_error = None

try:
    import semantica as _semantica

    SEMANTICA_VERSION = getattr(_semantica, "__version__", "unknown")
except Exception as exc:  # pragma: no cover - 环境问题
    _import_error = repr(exc)


def _out(obj):
    """写一行 JSON 到 stdout 并立刻 flush（Node 侧按行读）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# ── 懒加载 Semantica 抽取器（按语言分别持有） ───────────────────────────────
#
# 为什么要分语言：Semantica 的 NER 默认走 spaCy，而它内部把模型名硬编码成
# en_core_web_lg/md/sm。用英文模型跑中文，spaCy 会把整句当成一个实体
# （实测「Semantica 是一个知识图谱开源项目，作者是」→ PRODUCT），图会彻底废掉。
# 换成 zh_core_web_sm 后同一段文本给出 Semantica/ORG、北京/GPE、张三/PERSON。
# NamedEntityRecognizer(**config) 会把 config 透传给 NERExtractor，因此
# 用 model= 指定模型即可。

_ner_cache = {}          # lang -> NamedEntityRecognizer
_rel_cache = {}          # lang -> RelationExtractor | None
_extract_error = None
_zh_model_available = None


def _is_cjk(text):
    """判断文本是否以中文为主（CJK 汉字占比）。"""
    if not text:
        return False
    cjk = 0
    for ch in text:
        if "\u4e00" <= ch <= "\u9fff":
            cjk += 1
    return cjk >= 2 and cjk / max(1, len(text)) > 0.12


def _model_for(lang):
    return "zh_core_web_sm" if lang == "zh" else "en_core_web_sm"


def _get_ner(lang):
    """按语言取（并缓存）NER 实例。"""
    global _extract_error, _zh_model_available
    if lang in _ner_cache:
        return _ner_cache[lang]
    try:
        from semantica.semantic_extract import NamedEntityRecognizer

        try:
            ner = NamedEntityRecognizer(model=_model_for(lang))
        except Exception:
            # 指定模型不可用（比如没下 zh 模型）→ 退回库默认，至少还能跑
            if lang == "zh":
                _zh_model_available = False
            ner = NamedEntityRecognizer()
        _ner_cache[lang] = ner
        return ner
    except Exception as exc:
        _extract_error = repr(exc)
        _ner_cache[lang] = None
        return None


def _get_rel(lang):
    """按语言取（并缓存）关系抽取器；不可用时返回 None（实体照常抽取）。"""
    if lang in _rel_cache:
        return _rel_cache[lang]
    try:
        from semantica.semantic_extract import RelationExtractor

        try:
            rel = RelationExtractor(model=_model_for(lang))
        except Exception:
            rel = RelationExtractor()
        _rel_cache[lang] = rel
    except Exception:
        _rel_cache[lang] = None
    return _rel_cache[lang]


def _has_zh_model():
    """探测中文 spaCy 模型是否装了（用于在 UI 上给出准确提示）。"""
    global _zh_model_available
    if _zh_model_available is not None:
        return _zh_model_available
    try:
        import spacy.util as _u

        _zh_model_available = _u.is_package("zh_core_web_sm")
    except Exception:
        _zh_model_available = False
    return _zh_model_available


def _entity_fields(ent):
    """把 Semantica 的 Entity 读成 (name, type, confidence)。"""
    if isinstance(ent, dict):
        name = ent.get("name") or ent.get("text") or ent.get("label")
        etype = ent.get("type") or ent.get("label_") or ent.get("category") or "ENTITY"
        conf = ent.get("confidence")
    else:
        name = getattr(ent, "name", None) or getattr(ent, "text", None)
        etype = getattr(ent, "type", None) or getattr(ent, "label", None) or "ENTITY"
        conf = getattr(ent, "confidence", None)
    if name is None:
        return None
    return str(name).strip(), str(etype).strip() or "ENTITY", conf


def _name_of(value):
    """
    从一个端点取实体名。

    Relation.subject / object 拿到的是 **Entity 对象**而不是字符串 —— 直接 str()
    会得到 "Entity(text='Semantica', label='ORG', ...)" 这种 repr，跟实体名对不上，
    结果就是关系全部被过滤掉（实测：901 个节点、0 条关系）。
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        for k in ("text", "name", "label", "value"):
            v = value.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        return None
    for k in ("text", "name", "label"):
        v = getattr(value, k, None)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _relation_fields(rel):
    """把 Semantica 的 Relation 读成 (subject, predicate, object, confidence)。"""
    if isinstance(rel, dict):
        s = rel.get("subject") or rel.get("head") or rel.get("source")
        p = rel.get("predicate") or rel.get("relation") or rel.get("type") or rel.get("label")
        o = rel.get("object") or rel.get("tail") or rel.get("target")
        conf = rel.get("confidence")
    else:
        s = getattr(rel, "subject", None) or getattr(rel, "head", None) or getattr(rel, "source", None)
        p = (
            getattr(rel, "predicate", None)
            or getattr(rel, "relation", None)
            or getattr(rel, "type", None)
            or getattr(rel, "label", None)
        )
        o = getattr(rel, "object", None) or getattr(rel, "tail", None) or getattr(rel, "target", None)
        conf = getattr(rel, "confidence", None)

    s_name = _name_of(s)
    o_name = _name_of(o)
    if not s_name or not o_name:
        return None
    if isinstance(p, (list, tuple)):
        p = " ".join(str(x) for x in p if x)
    return s_name, str(p or "related_to").strip() or "related_to", o_name, conf


# ── 归一化：同一实体跨段合并 ────────────────────────────────────────────────

_WS = re.compile(r"\s+")


# Explorer 前端拿 `→`(U+2192) 当**自己的**内部边键分隔符：
#
#     const a = `${source}→${target}`          // 边键
#     const [o, s] = i.split("→")              // 再拆回来恢复端点
#     e.mergeDirectedEdgeWithKey(f, o, s, …)   // graphology 给不存在的端点自动补节点
#
# 所以节点 id 或边端点里只要出现 `→`，拆回来时端点就错位：
#   "turn:1→ent:北京→g".split("→") → ["turn:1", "ent:北京", "g"]   ← g 被丢掉
# 于是凭空多出一个 `ent:北京` 节点，而它是补出来的、**没有坐标**，
# sigma 立刻抛 "Coordinates of node ent:北京 are invalid"，Explorer 的
# per-workspace 错误边界接管整个视图，界面变成
# "…this view cannot be displayed"。
#
# 实测：用一个 3 节点、只有一个 id 含 `→` 的图谱就能复现；把真实图谱里
# 8 处边端点的 `→` 换掉，报错即消失。所以保留字符必须从 id 里抹掉。
# 注意只清 id —— 显示用的 label/content 保留原样，信息不丢。
_RESERVED_ID_CHARS = {"\u2192": "_"}  # →


def _norm_key(name):
    """实体去重键：小写、折叠空白、去掉首尾标点、抹掉 Explorer 的保留字符。"""
    s = _WS.sub(" ", str(name)).strip().strip(".,;:!?()[]{}<>\"'`。，、；：！？（）【】《》“”‘’")
    for bad, good in _RESERVED_ID_CHARS.items():
        if bad in s:
            s = s.replace(bad, good)
    return s.lower()


def _sanitize_ids(nodes, edges):
    """
    落盘前把节点 id 与边端点里的 Explorer 保留字符统一换掉（兜底那道）。

    `_norm_key` 已经管住了实体这个入口，但 id 还可能来自别处（段落 id、
    工具调用 id、以后新增的节点类型…），所以这里再扫一遍，代价只是一次遍历。
    重映射是**一致**的：节点表按新 id 重建，边端点跟着改写；两条边撞成同一条
    就丢掉，两个节点撞成一个就把 mentions 合并 —— 都不会丢数据。

    返回 (新节点表, 新边表, 改名数量)。
    """
    def safe(value):
        s = str(value)
        for bad, good in _RESERVED_ID_CHARS.items():
            if bad in s:
                s = s.replace(bad, good)
        return s

    remap = {}
    new_nodes = {}
    for nid, nd in nodes.items():
        sid = safe(nid)
        if sid != nid:
            remap[nid] = sid
        if sid in new_nodes:
            try:
                new_nodes[sid]["properties"]["mentions"] += nd["properties"].get("mentions", 0)
            except Exception:
                pass
            continue
        nd = dict(nd)
        nd["id"] = sid
        new_nodes[sid] = nd

    if not remap:
        return nodes, edges, 0

    new_edges = []
    seen = set()
    for e in edges:
        s = safe(e.get("source_id"))
        t = safe(e.get("target_id"))
        if not s or not t or s == t:
            continue
        key = (s, t, e.get("type"))
        if key in seen:
            continue
        seen.add(key)
        e = dict(e)
        e["source_id"] = s
        e["target_id"] = t
        new_edges.append(e)
    return new_nodes, new_edges, len(remap)


def _looks_like_noise(name):
    """
    过滤明显无意义的「实体」。

    对话里实体抽取的噪音主要来自工具调用：bash 命令行、文件路径、参数片段。
    spaCy 会把 `/Users/x/Library/Application Support`、`2>&1`、`1.` 这类东西
    当成 ORG/CARDINAL。实测不拦的话，度数最高的十个「实体」全是路径和 shell 片段，
    真正的语义实体（Semantica、React…）反而被淹掉。
    """
    s = str(name).strip()
    if len(s) < 2 or len(s) > 60:
        return True
    # 路径 / URL 片段
    if "/" in s or "\\" in s:
        return True
    # shell 运算符与参数拼接（2>&1、a=b、x|y）
    if re.search(r"[&|><=(){}\[\]]", s):
        return True
    # 纯数字、序号、百分号结尾的数字
    if re.fullmatch(r"[\d\s.,:%$-]+", s):
        return True
    # 至少要有一个字母或汉字，且不能是单个字符
    if not re.search(r"[A-Za-z\u4e00-\u9fff]", s):
        return True
    if len(re.sub(r"[^A-Za-z\u4e00-\u9fff]", "", s)) < 2:
        return True
    return False


# 这些是被 spaCy 大量误报成实体的通用词（macOS 路径上的目录名、常见命令名）
_STOPWORDS = {
    "users", "library", "application support", "applications", "desktop",
    "downloads", "contents", "resources", "documents", "library/application support",
    "the", "this", "that", "and", "for", "with", "from", "bash", "grep", "cat",
    "echo", "node", "npm", "python", "python3", "true", "false", "null", "none",
    "stdout", "stderr", "exit", "code", "error", "name", "type", "value", "data",
}


def _is_stopword(name):
    return str(name).strip().lower() in _STOPWORDS


# ── 实体噪声：以下是**实测**出来的形态，不是想当然 ──────────────────────────
#
# 用本仓库作者的一次真实会话量的（28 轮 / 997 段 / 325 个实体）：
#   · PERSON 125 个里几乎全是代码标识符和普通英文词 —— graph(度 23)、tool、
#     out、locale、TypeError、text、title…，真正的人名只有 `张三` 这种占位符
#   · CARDINAL 28 个全是 `134px` / `625px` / `上百` / `②本体`
#   · DATE 18 个是 `今天` / `localhost` / `汉化` / `00014 个月`
#   · LAW 2 个是 `GROUP BY` / `Exclude all local artifacts`
#   · `cy`（NORP，度 44，全图第 5）来自 `cytoscape/d3/mermaid` —— 被切了一半
# 不拦掉的话实体层的信噪比是反的：噪声度更高、排得更前，AI 分析先看到的就是它们。
#
# 取舍方向很关键：**纠正类型，但不丢术语**。行内代码里的 `numpy` / `graph`
# 正是这场对话在谈的东西，strip_markdown 的注释也写明了要保留它们 ——
# 所以只把 spaCy 给错的类型（numpy 被标成 GPE）改成 CODE，实体本身留着。
# 只有「被切碎的词」和「本身就不该是实体的词」才整条丢。

# 这些类型在技术对话里实测全是度量/时间片段，没有信息量。
# （真正的日期如 `2026-09-16` 早被 _looks_like_noise 的纯数字规则拦住了。）
_NOISE_ETYPES = frozenset({
    "CARDINAL", "DATE", "TIME", "MONEY", "QUANTITY", "PERCENT",
    "WORK_OF_ART", "LAW", "EVENT",
})

# spaCy 的「命名实体」类型 —— 判断代码标识符时不能采信这几个。
_CODE_UNTRUSTED_ETYPES = frozenset({"PERSON", "ORG", "GPE", "FAC", "NORP", "LOC"})

# 标识符形状的判据比「行内代码」更强，连 PRODUCT 一起纠 —— 实测
# browserAllowedLoopback 被标成 PRODUCT。GUI 这类全大写缩写不会命中标识符形状
# （它只有首字母大写，没有「小写紧跟大写」的转折），所以不会被误伤。
_CODE_UNTRUSTED_ETYPES_SHAPE = _CODE_UNTRUSTED_ETYPES | {"PRODUCT"}

# 代码标识符 / 技术术语统一标成它。Explorer 的配色是按数据里的类型动态生成的，
# 类型也没有硬编码白名单（实测 _get_entity_type_colors 支持任意类型），所以新类型安全。
_CODE_ETYPE = "CODE"

# 标识符形状本身就是「这是代码」的证据，不必等反引号。
# 实测漏网的 `browserAllowedLoopback`（被标成 PRODUCT）就是这个形状。
#
# 判据刻意收窄到**小写开头**的驼峰，以及下划线 / :: / -> ：
#   browserAllowedLoopback ✓  openDetails ✓  open_details ✓  std::vector ✓
#   TypeScript ✗  GitHub ✗  PostgreSQL ✗  GUI ✗  Semantica ✗
# 因为「小写紧跟大写」对以大写开头的一串同样成立，而现实世界里的名字
# （GitHub / TypeScript / PostgreSQL）恰好都是那个形状 —— 按宽判据会把它们
# 一起当成代码。写成反引号的 `NamedEntityRecognizer` 这类另有「行内代码」那条兜住。
_IDENTIFIER_SHAPE = re.compile(r"_|::|->|^[a-z][A-Za-z0-9]*[A-Z]")

# 含中文的标签，spaCy 的这几个类型**实测等于随机**：
#   GPE  → 白捡 / 扇出 / 上界 / 平台层 / 硬伤 / 里加 / 加真 / 初始值
#   PERSON → 白名单 / 简单力 / 哈希类名 / 浏览器 / 返回值 / 决策链 / 内容区 / 偏门面
#   FAC  → 假数据 / 核心槽 / GitHub 仓库     NORP → 平方级 / 图标变
#   LOC  → zhcorewebsm / 提示                ORG  → 静默复查 / 中英 / 中心度 / 沙箱 iframe
# 这些词本身不少是有意义的（扇出、上界、白名单 都是这场对话在谈的概念），
# 所以**不丢实体，只把类型改成诚实的 UNKNOWN**。语言类标得准（中文/英文 → LANGUAGE），
# 予以保留；术语只要带反引号或标识符形状就还是会变成 CODE。
_CJK_UNTRUSTED_ETYPES = frozenset({
    "PERSON", "ORG", "GPE", "FAC", "NORP", "LOC", "PRODUCT", "WORK_OF_ART", "LAW", "EVENT",
})
_CJK_LABEL = re.compile(r"[\u4e00-\u9fff]")
_UNKNOWN_ETYPE = "UNKNOWN"

# 序数词。**按整词匹配，不按类型丢** —— 实测 zh 模型把名词 `第三方`
# 也标成了 ORDINAL，按类型丢会误伤它。
_ORDINAL_LABEL = re.compile(r"^第[一二三四五六七八九十百千两0-9]+$")
_ORDINAL_WORDS = frozenset({
    "first", "second", "third", "fourth", "fifth",
    "首次", "首先", "最初", "最后", "其次",
})


def _looks_like_fragment(name, text, start, end):
    """
    实体名是不是某个更长的词被切下来的一截。

    实测两个来源：`cytoscape/d3/mermaid` → `cy`；`MIT LICENSE` → `MIT LICEN`。
    共同点是**跨度的紧邻字符还是 ASCII 字母或数字** —— 那它一定不是完整的词。

    只对含 ASCII 字母的名字判断。中文没有词间空格，紧邻汉字是常态
    （`白名单里` 的「里」就紧挨着），按邻接判会把正常词整片丢掉。
    """
    if not isinstance(name, str) or not re.search(r"[A-Za-z]", name):
        return False
    if not isinstance(start, int) or not isinstance(end, int):
        return False
    if start < 0 or end > len(text) or start >= end:
        return False

    def _word_char(ch):
        return ch.isascii() and (ch.isalnum() or ch == "_")

    if start > 0 and _word_char(text[start - 1]):
        return True
    if end < len(text) and _word_char(text[end]):
        return True
    return False


def _is_ordinal_label(name):
    s = str(name).strip()
    return bool(_ORDINAL_LABEL.match(s)) or s.lower() in _ORDINAL_WORDS


def _entity_span(ent):
    """取实体的字符跨度（对**归一化后**文本的偏移）。"""
    if isinstance(ent, dict):
        s, e = ent.get("start_char"), ent.get("end_char")
    else:
        s, e = getattr(ent, "start_char", None), getattr(ent, "end_char", None)
    return (s if isinstance(s, int) else None, e if isinstance(e, int) else None)


def _in_inline_code(raw, name):
    """
    这个词在**原文**里是不是写在行内代码（反引号）里。

    这是本仓库最可靠的「它是代码标识符、不是现实世界的命名实体」证据 ——
    技术对话里的术语基本都带反引号写。拿它纠正 spaCy 给错的类型，
    比按大小写、下划线去猜准得多，也和 strip_markdown「保留行内代码内容」的
    既有设计方向一致。
    """
    if not raw or not name:
        return False
    for m in _INLINE_CODE.finditer(raw):
        if name in m.group(1):
            return True
    return False


# ── markdown 归一化 ────────────────────────────────────────────────────────
#
# 助手的正文是 markdown。直接把它喂进 spaCy 会出两类脏实体：
#   1. 行内代码的反引号被一起吃进实体名 —— 抽出 `conversation 这种带反引号的标签
#   2. 代码块里成片的标识符被当成实体 —— Side / openDetails / bar` 之类
# 所以先还原成接近自然的句子。策略上区分对待：
#   · 代码块整块丢弃（内容几乎全是标识符，对语义图没有价值，噪声占比极高）
#   · 行内代码只去反引号、保留内容（`numpy` / `cytozine` 这类术语本身是有价值的实体）
_FENCE = re.compile(r"```[\s\S]*?```|~~~[\s\S]*?~~~")
_INLINE_CODE = re.compile(r"`([^`\n]*)`")
_MD_IMAGE = re.compile(r"!\[([^\]\n]*)\]\([^)\n]*\)")
_MD_LINK = re.compile(r"\[([^\]\n]*)\]\([^)\n]*\)")
_MD_REF_LINK = re.compile(r"\[([^\]\n]*)\]\[[^\]\n]*\]")
_MD_AUTOLINK = re.compile(r"<(https?://[^>\s]+)>")
_MD_HEADING = re.compile(r"^[ \t]{0,3}#{1,6}[ \t]+", re.M)
_MD_RULE = re.compile(r"^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$", re.M)
_MD_TABLE_SEP = re.compile(r"^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$", re.M)
_MD_TABLE_ROW = re.compile(r"^[ \t]*\|(.+)\|[ \t]*$", re.M)
_MD_QUOTE = re.compile(r"^[ \t]{0,3}>[ \t]?", re.M)
_MD_LIST = re.compile(r"^[ \t]{0,6}(?:[-*+]|\d{1,3}[.)])[ \t]+", re.M)
_MD_EMPH = re.compile(r"(\*\*\*|\*\*|\*|___|__|_)(?=\S)([\s\S]*?\S)\1")


def strip_markdown(text):
    """把 markdown 还原成接近自然的句子，再交给 NER。"""
    if not text:
        return ""
    s = text
    s = _FENCE.sub(" ", s)                 # 代码块整块丢弃
    s = _MD_IMAGE.sub(r"\1", s)            # 图片保留 alt
    s = _MD_LINK.sub(r"\1", s)             # 链接保留可见文字
    s = _MD_REF_LINK.sub(r"\1", s)
    s = _MD_AUTOLINK.sub(r"\1", s)
    s = _INLINE_CODE.sub(r"\1", s)         # 行内代码去反引号、留内容
    s = _MD_HEADING.sub("", s)
    s = _MD_TABLE_SEP.sub(" ", s)
    s = _MD_TABLE_ROW.sub(r"\1", s)
    s = _MD_RULE.sub(" ", s)
    s = _MD_QUOTE.sub("", s)
    s = _MD_LIST.sub("", s)
    s = _MD_EMPH.sub(r"\2", s)
    s = s.replace("`", " ")                # 落单的反引号
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


# ── 产出 Semantica 原生 ContextGraph ────────────────────────────────────────

def _iso_local(ms):
    """
    把 DSH 事件的 epoch 毫秒转成 ISO 8601 —— **不带时区偏移**的本地时间。

    为什么故意不带偏移（"+08:00" 那种），这一点很容易搞反，务必看清：

    Explorer 前后端对「无时区时间」的处理是**约定式**的，不是真的换算：

      后端 `_parse_flexible_dt`：
        带偏移 → 折成 UTC 再把 tzinfo 抹掉（07:38 这种）
        不带偏移 → 原样保留，什么都不做
      前端 `new Date("2026-09-16T07:38:41")`：
        JS 规范规定「只有日期时间的字符串按**本地时区**解释」

    两者拼起来的结果是：写带偏移的 `15:38:41+08:00`，后端折成 `07:38:41` 交出去，
    前端又把这个裸值当本地时间，最终时间轴显示 `07:38` —— 整整差 8 小时
    （实测 `/api/temporal/bounds` 就是这么返回的）。
    写不带偏移的本地 `15:38:41`，后端原样透传，前端按本地解释，两边都是 `15:38` ✓

    所以这里必须写裸的本地时间。图文件本身也是给人看的，本地时间更直观。
    """
    if ms is None:
        return None
    try:
        ts = float(ms)
    except (TypeError, ValueError):
        return None
    # 会话事件的时间是毫秒；防御性地兼容误传的秒级时间戳
    if ts > 1e11:
        ts /= 1000.0
    try:
        # fromtimestamp 给的就是不带 tzinfo 的本地时间 —— 正是要的形态
        return datetime.fromtimestamp(ts).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


# tool 节点 content 的上限。1821 个 tool 节点 × 每个几百字符，图文件大约涨 1MB；
# 换来的是详情里能看到「跑了什么、输出什么」，而且 content 会进 Explorer 的搜索索引。
_TOOL_ARGS_CHARS = 300
_TOOL_RESULT_CHARS = 200


def _tool_content(tc):
    """tool 节点的详情正文：一句话标题 + 参数 + 输出。"""
    title = str(tc.get("title") or tc.get("name") or "tool").strip()
    args = str(tc.get("argsSummary") or "").strip()
    result = str(tc.get("resultSummary") or "").strip()
    parts = [title]
    if args:
        parts.append(args[:_TOOL_ARGS_CHARS])
    if result:
        parts.append("── 输出 ──\n" + result[:_TOOL_RESULT_CHARS])
    return "\n".join(parts)


def build_context_graph(payload):
    """
    把对话造成本体的 ContextGraph，落盘成 JSON。

    这条路产出的是 Semantica 自己的图结构（context.context_graph.ContextGraph），
    用途是交给它自带的 Knowledge Explorer（`semantica-explorer --graph <file>`）浏览。
    这样能直接拿到上游那 6 个 workspace 和整套 /api 接口，而不是自绘一个子集。

    与 build_graph 的区别只在输出格式：抽取入口、语言路由、规模上限、
    噪声过滤全部复用同一套函数，两个命令的结果应当是一致的。
    """
    from semantica.context.context_graph import ContextGraph

    out_path = payload.get("outPath")
    if not out_path:
        raise ValueError("build_context_graph 需要 payload.outPath")

    segments = payload.get("segments") or []
    messages = payload.get("messages") or []
    tool_calls = payload.get("toolCalls") or []
    turns = payload.get("turns") or []
    decisions = payload.get("decisions") or []

    t0 = time.time()
    timing = {"ner": 0.0, "relation": 0.0}

    nodes = {}          # id -> {id, type, properties}
    edges = []
    seen_edge = set()

    def node(nid, ntype, props):
        """按 id 去重地登记一个节点。"""
        if nid not in nodes:
            nodes[nid] = {"id": nid, "type": ntype, "properties": dict(props)}

    def time_of(ms):
        """
        给节点属性补 `valid_from`。

        Explorer 的时间轴靠它判定节点在某个时刻是否「活跃」
        （前端 `xc()`：没有 valid_from 也没有 valid_until 就直接 return false），
        而时间轴上下界也是从所有节点的 valid_from/valid_until 里取的极值 ——
        一个都不写的话，界面上会退化成写死的兜底值 `1970 → 2030`。
        """
        iso = _iso_local(ms)
        return {"valid_from": iso} if iso else {}

    def edge(src, dst, etype, weight=1.0, props=None):
        """按 (源, 目标, 类型) 去重地登记一条边。"""
        if not src or not dst or src == dst:
            return False
        key = (src, dst, etype)
        if key in seen_edge:
            return False
        seen_edge.add(key)
        edges.append({
            "source_id": src,
            "target_id": dst,
            "type": etype,
            "weight": float(weight) if isinstance(weight, (int, float)) else 1.0,
            "properties": props or {},
        })
        return True

    # ── 1. 对话骨架：轮次 → 消息 / 工具调用 ────────────────────────────────
    for t in turns:
        node(f"turn:{t.get('turn')}", "turn",
             {"label": f"第 {t.get('turn', '?')} 轮", "kind": "turn",
              **time_of(t.get("time"))})

    # 段的 source 是「裸 id」（Node 侧给的是 user:123 / assistant:456 / <call.id>），
    # 而节点 id 带了 msg: / tool: 前缀。不建这张对照表的话，每段都匹配不上、
    # 一律 fallback 成 seg:<seq> 影子节点 —— 于是同一批内容既有一份 message/tool
    # 节点，又有一份 seg 节点，而实体边全挂在影子上，从实体点进去走不到真正的
    # 消息（实测 400 段全部如此）。这里把两种写法对齐。
    anchor_of = {}
    for m in messages:
        if m.get("id") is not None:
            anchor_of[str(m.get("id"))] = f"msg:{m.get('id')}"
    for tc in tool_calls:
        if tc.get("id") is not None:
            anchor_of[str(tc.get("id"))] = f"tool:{tc.get('id')}"

    # 已知会建出节点的 tool id —— `edge()` 不校验端点是否存在，只连真的有的，
    # 免得留下悬空边。
    known_tools = {f"tool:{tc.get('id')}" for tc in tool_calls if tc.get("id") is not None}

    for m in messages:
        mid = f"msg:{m.get('id')}"
        node(mid, "message", {
            "label": (m.get("excerpt") or m.get("text") or "")[:120],
            "role": m.get("role"),
            "kind": "message",
            **time_of(m.get("time")),
        })
        if m.get("turn") is not None:
            edge(f"turn:{m.get('turn')}", mid, "contains")
        # 这条消息调了哪些工具。
        #
        # 原本图里只有 `turn --contains--> tool`，消息和它调用的工具只是「同一个轮次里
        # 的两个兄弟」，没有直接边 —— 于是「这条结论是跑哪几条命令得出的」走不通。
        # Explorer 的 /neighbors 和 /chain 又都只走出边，所以 msg→tool 必须是这个方向
        # （反过来 tool→msg 是入边，加了也点不动，只会多一堆边）。
        #
        # 会成环吗：不会。`get_neighbors` 里 `visited = {node_id}` 是 BFS 去重的
        # （semantica/context/context_graph.py），环安全。
        for cid in m.get("toolCallIds") or []:
            if f"tool:{cid}" in known_tools:
                edge(mid, f"tool:{cid}", "calls", props={"kind": "tool-call"})

    for tc in tool_calls:
        cid = f"tool:{tc.get('id')}"
        # 标签用人类可读的 title（工具描述），不是工具名 —— 用工具名的话
        # 实测 677 个节点里 398 个都叫 "bash"，在 Explorer 里完全分不出来。
        node(cid, "tool", {
            "label": tc.get("title") or tc.get("name") or "tool",
            "kind": "tool",
            "tool": tc.get("name"),
            # 详情正文：标题 + 参数 + 输出。
            # 这里曾经没有 content —— 于是它一路回落到 label（只有一行描述），
            # 点开 bash 节点看不到跑了什么命令、更看不到输出；而 argsSummary /
            # resultSummary 在 JS 侧算好了、也传过来了，只是没人用。
            # 另外 Explorer 的搜索索引是拿 content 建的，补上之后命令与输出都可搜。
            "content": _tool_content(tc),
            **time_of(tc.get("time")),
        })
        if tc.get("turn") is not None:
            edge(f"turn:{tc.get('turn')}", cid, "contains")

    # ── 1.5 决策层：对话里结构化的「选择」 ──────────────────────────────────
    #
    # Explorer 的 Decisions 区（`explorer/routes/decisions.py`）只认
    # **type == "decision"** 的节点，并从 properties 里读这几个字段：
    #   category / scenario / reasoning / outcome / confidence / timestamp
    # 类型对不上、或字段名不对，那个区就是空的。实测：只放一个 decision 节点
    # 进去，`/api/decisions` 立刻返回完整的 7 个字段。
    #
    # 数据来自对话里的提问工具（AskUserQuestion）——它的事件同时带
    # 「问了什么 + 每个选项什么意思」和「用户最后选了什么」，是对话中**唯一**
    # 结构化的决策记录。别的决策都埋在自然语言里，抽出来不可靠，不做。
    decisions_n = 0
    decided = []          # [(决策原始记录, 节点 id)]，按时间顺序，用来串出边
    for dec in decisions:
        outcome = str(dec.get("outcome") or "").strip()
        if not outcome:
            continue
        did = f"dec:{dec.get('id')}"
        node(did, "decision", {
            # 显示名就是用户的选择本身，一眼能看出这条决策的结论。
            "label": outcome[:120],
            "kind": "decision",
            "category": str(dec.get("category") or ""),
            "scenario": str(dec.get("scenario") or ""),
            # 选中项自己的 description ＝ 为什么这么选。Explorer 的决策详情
            # 就是拿这个当「推理依据」展示的。
            "reasoning": str(dec.get("reasoning") or ""),
            "outcome": outcome,
            # 用户明确做了选择，不存在 NER 那种不确定性，所以是 1.0。
            "confidence": 1.0,
            "timestamp": _iso_local(dec.get("time")),
            # 被放弃的选项也留下来：决策记录比普通节点多的价值就在于
            # 「当时还有哪些别的路可走」。
            "alternatives": dec.get("alternatives") or [],
            # selected = 点了现成选项；custom = 自己打字，那是更明确的表态。
            "choiceKind": dec.get("kind"),
            "questionId": dec.get("questionId"),
            "content": outcome,
            **time_of(dec.get("time")),
        })
        if dec.get("turn") is not None:
            edge(f"turn:{dec.get('turn')}", did, "contains", props={"kind": "decision"})
        decided.append((dec, did))
        decisions_n += 1

    # 决策的**出边** —— 没有它 Explorer 的因果链永远是空的。
    #
    # `ContextGraph.get_neighbors` 只走 `self._adjacency[当前节点]`，也就是**出边**：
    #     outgoing_edges = self._adjacency.get(current_id, [])
    # 而决策节点天然只有入边（turn → dec，谁提出了这个问题），
    # 于是 `/api/decisions/{id}/chain` 实测返回 `{"chain": []}`。
    #
    # 这一点为什么是要命的：Explorer 的决策详情面板里**唯一的实质内容就是那张
    # 标题为 "Causal Chain" 的卡片**。翻它的 bundle（DecisionWorkspace）可以看到
    # 详情只渲染四样：decision_id、outcome 徽章、category 药丸，再加这张卡片 ——
    # `reasoning` / `scenario` / `confidence` 各出现 **0 次**，写了也不会显示。
    # 卡片一空，整页就剩一个长 id 和两个小标签，用户看到的就是"点进去空白"。
    #
    # 所以这里必须保证**任何一条决策都有出边**，包括只有一个提问的短会话。
    #
    # 补两类：
    #   decided_at     这条决策来自哪次提问 —— 提问工具节点，**必然存在**且出边为 0，
    #                  它一个人就能保证链非空（长度 1）
    #   next_decision  时间上的下一条决策，串成一条决策链
    #
    # 连什么**不能**连，也是量出来的 —— 各类节点的平均出边数：
    #
    #     turn      128.6（最大 517）   ← 一进 turn 就扇出到整轮消息+工具，再经实体炸到全图
    #     entity      1.1
    #     message     0.8
    #     tool        0.0               ← 安全
    #
    # 最初加的是 `dec --led_to--> turn:N+1`（决策的后果），链直接从 0 涨到 **412 个**。
    # 而前端是 `t.map(...)` 直接渲染、没有任何截断，412 步就是一堵墙。
    # 换成 tool 和 decision（都几乎无扇出）之后，链长落在 1~5 步 —— 恰好是「链」该有的长度。
    #
    # `next_decision` 是**时序相邻**，不是证明出来的因果：隔了十轮的决策之间
    # 未必有因果关系。这里刻意用一个自解释的边名，免得读图的人误以为
    # 是推理出来的依赖。真实因果需要别的证据，这个图里没有。
    for i, (dec, did) in enumerate(decided):
        # 提问工具节点 —— `toolCalls` 里那条 ask_user_question 调用，
        # 它的 title 就是问题的可读标题，作为链的第一步正合适。
        call_id = dec.get("callId")
        if call_id:
            edge(did, f"tool:{call_id}", "decided_at", props={"kind": "question"})
        if i + 1 < len(decided):
            edge(did, decided[i + 1][1], "next_decision", props={"kind": "decision-chain"})

    # ── 2. 语义层：逐段抽实体与关系 ────────────────────────────────────────
    ent_ids = {}        # 归一化名 -> 节点 id
    ent_span = {}       # 实体节点 id -> [最早提及 ms, 最晚提及 ms]
    ent_last_turn = {}  # 实体节点 id -> 最后一次被提及时的轮次
    ent_code = set()    # 实体节点 id -> 至少有一次提及写在行内代码里
    relations = 0

    # 每轮的结束时刻 = 下一轮的开始；最后一轮没有下一轮，用全段最晚时刻兜底。
    # 用途见下面写 valid_until 的地方。
    _turn_start = {}
    for _t in turns:
        _n, _ms = _t.get("turn"), _t.get("time")
        if _n is None or _ms is None:
            continue
        try:
            _v = float(_ms)
        except (TypeError, ValueError):
            continue
        _turn_start[int(_n)] = _v / 1000.0 if _v > 1e11 else _v
    _order = sorted(_turn_start)
    turn_end = {
        n: (_turn_start[_order[i + 1]] if i + 1 < len(_order) else None)
        for i, n in enumerate(_order)
    }
    _seg_times = []
    for _s in segments:
        try:
            _v = float(_s.get("time"))
        except (TypeError, ValueError):
            continue
        _seg_times.append(_v / 1000.0 if _v > 1e11 else _v)
    session_end = max(_seg_times) if _seg_times else None
    if session_end is not None:
        for _n in _order:
            if turn_end[_n] is None:
                turn_end[_n] = session_end

    for seg in segments:
        # 与 build_graph 一致：先归一化 markdown 再抽取。
        # raw_text 单独留着：判断「这个词是不是写在反引号里」要用带反引号的原文。
        raw_text = seg.get("text") or ""
        text = strip_markdown(raw_text)
        if not text:
            continue

        seg_ms = seg.get("time")

        ref = seg.get("source")
        anchor = anchor_of.get(str(ref)) if ref is not None else None
        if anchor is None and ref and ref in nodes:
            anchor = ref
        if anchor is None:
            anchor = f"seg:{seg.get('seq')}"
            node(anchor, "segment", {
                "label": text[:80],
                "role": seg.get("role"),
                "kind": "segment",
                "seq": seg.get("seq"),
                **time_of(seg_ms),
            })

        lang = "zh" if _is_cjk(text) else "en"
        ner = _get_ner(lang)
        if ner is None:
            continue

        try:
            _t = time.time()
            raw_ents = ner.extract_entities(text)
            timing["ner"] += time.time() - _t
        except Exception:
            raw_ents = []

        local = []
        for ent in raw_ents or []:
            parsed = _entity_fields(ent)
            if not parsed:
                continue
            name, etype, _conf = parsed
            if _looks_like_noise(name) or _is_stopword(name):
                continue
            # 被切碎的词先丢 —— 它连一个完整的词都不是
            e_start, e_end = _entity_span(ent)
            if _looks_like_fragment(name, text, e_start, e_end):
                continue
            if _is_ordinal_label(name):
                continue
            # 度量/时间类：实测全是 134px、6个月、上百 这种片段
            if str(etype).upper() in _NOISE_ETYPES:
                continue
            # 类型纠错**只记证据**，不在这里改类型。
            #
            # 这里踩过一次：当场改是错的，因为节点的 etype 在**第一次**提及建立节点时
            # 就定下来了，后面的提及即使带证据也覆盖不了 —— 结果完全取决于哪一段先被扫到。
            # 实测 `numpy` 就是受害者：它有时裸写（"因 numpy ABI 冲突损坏"）、
            # 有时带反引号（"`numpy` 原版本 1.26.4"），谁先出现谁定类型，
            # 于是它仍然挂着 spaCy 给的 GPE。改成先收证据、最后统一改。
            key = _norm_key(name)
            if not key:
                continue
            nid = f"ent:{key}"
            if _in_inline_code(raw_text, name):
                ent_code.add(nid)
            if nid not in nodes:
                node(nid, "entity", {
                    "label": name, "etype": etype, "kind": "entity", "mentions": 0,
                })
            nodes[nid]["properties"]["mentions"] += 1
            # 实体是跨段聚合的，所以给它的不是一个时刻而是一段跨度：
            # 第一次被提到 → 最后一次被提到。这样时间轴上的实体才不会永远不活跃。
            if seg_ms is not None:
                try:
                    ms = float(seg_ms)
                    if ms > 1e11:
                        ms /= 1000.0
                    span = ent_span.get(nid)
                    if span is None:
                        ent_span[nid] = [ms, ms]
                        ent_last_turn[nid] = seg.get("turn")
                    else:
                        if ms < span[0]:
                            span[0] = ms
                        if ms > span[1]:
                            span[1] = ms
                            ent_last_turn[nid] = seg.get("turn")
                except (TypeError, ValueError):
                    pass
            ent_ids.setdefault(key, nid)
            local.append((nid, name, ent))
            edge(anchor, nid, "mentions")

        # 工具段跳过关系抽取（共现关系对命令行没有意义，且最慢）
        is_tool = seg.get("role") == "tool"
        if is_tool or len(local) < 2:
            continue
        rel_extractor = _get_rel(lang)
        if rel_extractor is None:
            continue
        raw_rels = []
        try:
            _t = time.time()
            # entities= 必须收到 Entity 对象本身：抽取器内部会取 .text，
            # 传名字字符串会静默失败（'str' object has no attribute 'text'），
            # 结果就是关系数直接归零。
            raw_rels = rel_extractor.extract_relations(
                text[:MAX_REL_CHARS], entities=[e for _, _, e in local[:MAX_REL_ENTS]]
            )
            timing["relation"] += time.time() - _t
        except Exception:
            raw_rels = []

        for rel in raw_rels or []:
            parsed = _relation_fields(rel)
            if not parsed:
                continue
            s_name, pred, o_name, conf = parsed
            a = ent_ids.get(_norm_key(s_name))
            b = ent_ids.get(_norm_key(o_name))
            if not a or not b:
                continue
            if edge(a, b, pred, weight=conf, props={"kind": "relation"}):
                relations += 1

    # 段落都扫完了，实体的提及跨度才是最终值 —— 现在才写回节点。
    # 放在循环里写会写成「当前已知的最早/最晚」，多段实体会来回改很多次。
    # 证据收齐了，现在统一纠正类型：只要**有一次**提及是写在行内代码里的，
    # 它就是代码标识符，spaCy 那几个「命名实体」类型一律不采信。
    for nid in ent_code:
        props = nodes.get(nid, {}).get("properties")
        if props and str(props.get("etype", "")).upper() in _CODE_UNTRUSTED_ETYPES:
            props["etype"] = _CODE_ETYPE

    # 标识符形状（驼峰 / 下划线 / :: / ->）也是代码证据 —— 不必等反引号
    for nid, nd in nodes.items():
        props = nd.get("properties") or {}
        if nd.get("type") != "entity":
            continue
        label = str(props.get("label") or "")
        if not _IDENTIFIER_SHAPE.search(label):
            continue
        if str(props.get("etype", "")).upper() in _CODE_UNTRUSTED_ETYPES_SHAPE:
            props["etype"] = _CODE_ETYPE

    # 含中文的标签：spaCy 那几个类型实测等于随机，改成诚实的 UNKNOWN。
    # 注意这里**只改类型、不丢节点** —— 扇出/上界/白名单 这些都是这场对话真正在谈的概念。
    for nid, nd in nodes.items():
        if nd.get("type") != "entity":
            continue
        props = nd.get("properties") or {}
        label = str(props.get("label") or "")
        if not _CJK_LABEL.search(label):
            continue
        if str(props.get("etype", "")).upper() in _CJK_UNTRUSTED_ETYPES:
            props["etype"] = _UNKNOWN_ETYPE

    for nid, (first_ms, last_ms) in ent_span.items():
        props = nodes[nid]["properties"]
        iso_from = _iso_local(first_ms)
        if iso_from:
            props["valid_from"] = iso_from
        # 结束时刻取「最后一次提及**所在那一轮的结束**」，而不是最后一次提及的那一秒。
        #
        # 原来的写法是 `if last_ms > first_ms` 才写 valid_until，理由是「只提过一次的
        # 实体是一个瞬时点，给了会出现零长度区间」—— Explorer 的时间轴按 [from, until]
        # 判定活跃，零长度等于任何时刻都不活跃，这个顾虑成立。
        # 但「干脆不写」的代价是：那些实体从被提到的那一刻起**永远活跃**，
        # 时间轴拖到最后，开头一次性的提及仍然算「正在谈」。实测 325 个实体里
        # 只有 100 个有 valid_until，另外 225 个一直是全亮的。
        # 用轮次结束做右端点两个毛病都没有：区间有长度，且它只在自己那一轮里活跃。
        end_ms = turn_end.get(ent_last_turn.get(nid))
        if not end_ms or end_ms <= first_ms:
            end_ms = session_end if session_end and session_end > first_ms else last_ms
        if end_ms > first_ms:
            iso_until = _iso_local(end_ms)
            if iso_until:
                props["valid_until"] = iso_until

    # 交给 Explorer 之前把保留字符清掉 —— 不清的话它的图谱视图会直接崩，
    # 原因见 _RESERVED_ID_CHARS 上面的注释。
    nodes, edges, renamed_ids = _sanitize_ids(nodes, edges)

    graph = ContextGraph()
    added_n = graph.add_nodes(list(nodes.values()))
    added_e = graph.add_edges(edges)
    graph.save_to_file(out_path)

    return {
        "path": out_path,
        "nodes": added_n,
        "edges": added_e,
        # 非 0 说明有 id 里带了 Explorer 的保留字符、已被改名（否则视图会崩）
        "renamedIds": renamed_ids,
        "entities": len(ent_ids),
        "relations": relations,
        "turns": len(turns),
        "messages": len(messages),
        "tools": len(tool_calls),
        "decisions": decisions_n,
        "segments": len(segments),
        "engine": {
            "semantica": SEMANTICA_VERSION,
            "python": sys.version.split()[0],
            "models": {"en": _model_for("en"), "zh": _model_for("zh")},
            # 缺 spaCy 模型时库里会静默降级成正则兜底（实体标签全变 UNKNOWN，
            # 不报错），所以把「中文模型到底装没装」和抽取异常一起报出来。
            "zhModelInstalled": _has_zh_model(),
            "extractError": _extract_error,
        },
        "timing": {k: round(v, 3) for k, v in timing.items()},
        "elapsed": round(time.time() - t0, 3),
    }


# ── 协议主循环 ──────────────────────────────────────────────────────────────

def handle(req):
    cmd = req.get("cmd")
    payload = req.get("payload") or {}
    if cmd == "ping":
        return {"ok": True, "pong": True, "semantica": SEMANTICA_VERSION, "importError": _import_error}
    if cmd == "build_context_graph":
        if _import_error is not None:
            return {"ok": False, "error": f"无法导入 semantica: {_import_error}"}
        try:
            stats = build_context_graph(payload)
            return {"ok": True, "stats": stats}
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc()[-2000:]}
    return {"ok": False, "error": f"未知命令: {cmd}"}


def main():
    _out(
        {
            "ready": True,
            "semantica": SEMANTICA_VERSION,
            "python": sys.version.split()[0],
            "importError": _import_error,
        }
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            _out({"id": None, "ok": False, "error": f"请求不是合法 JSON: {exc}"})
            continue
        rid = req.get("id")
        try:
            res = handle(req)
        except Exception as exc:
            res = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        res["id"] = rid
        _out(res)


if __name__ == "__main__":
    main()

// scripts/check-entity-rules.mjs — 校验实体噪声规则的**判定边界**
//
// 为什么需要这个检查：
//   图谱里的实体噪声只能靠规则拦，而这些规则的边界很容易在后续调整里被悄悄放宽 ——
//   放宽之后不会报错，只会让噪声慢慢回来：`cy` 重新变成全图度数第五的「实体」，
//   `第一`/`第二` 重新爬上榜首。这类退化在界面上看不出来，只有量数据才发现。
//
//   所以这里把每一条规则的**正例和反例**都钉住。尤其重要的是反例：
//   拦噪声时最容易顺手拦过头，把本来有价值的东西一起丢掉。
//
//   三个真实踩过的反例（都是改这轮规则时手工验过的数据）：
//     · `第三方`  被 zh 模型标成 ORDINAL —— 若按**类型**丢序数词，这个正常概念会被误伤
//     · `GUI`     是 PRODUCT 且合法 —— 若标识符形状规则把 PRODUCT 一刀切会误伤它
//     · `GitHub` / `TypeScript` / `PostgreSQL` 也是「小写紧跟大写」—— 判据若不收窄
//                 到「小写开头的驼峰」，这些专有名词会一起被当成代码标识符
//     · `白名单里` 里的「里」紧挨着「白名单」—— 邻接判据只能对 ASCII 用，
//                 对中文用会把正常词整片丢掉（中文没有词间空格）
//     · `目的` / `标的` 是真名词、以「的」收尾 —— 「以 的 结尾的中文修饰语」
//                 这条规则若只按后缀判，会把它们一起丢掉
//     · `The Beatles` 起首是功能词 —— 「被截断成半个句子的英文」这条规则若不收窄，
//                 会把这类真名字误伤
//
// 只需要系统 python3：这些规则都是纯字符串判断，import graph_worker 不会拉起 spaCy。

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'src')

let failures = 0
const check = (name, ok, detail) => {
	if (!ok) failures++
	console.log(`  ${ok ? '✓' : '✗'} ${name}${detail && !ok ? `  ← ${detail}` : ''}`)
}

const PY = `
import sys
sys.path.insert(0, ${JSON.stringify(src)})
import json
import graph_worker as gw

def frag(name, text):
    i = text.find(name)
    return gw._looks_like_fragment(name, text, i, i + len(name)) if i >= 0 else None

out = {
    # ── 碎片：被切在字母中间 ──
    "frag_cy": frag("cy", "cytoscape/d3/mermaid 已装"),
    "frag_mit": frag("MIT LICEN", "MIT LICENSE file"),
    "frag_ok_d3": frag("d3", "cytoscape/d3/mermaid 已装"),
    "frag_ok_graph": frag("graph", "look at the graph data"),
    "frag_cjk_ok": frag("白名单", "白名单里加一行"),
    "frag_cjk_mid": frag("张图", "这张图有问题"),
    "frag_start": frag("cy", "cytoplasm is a word"),

    # ── 序数词：整词匹配，不按类型 ──
    "ord_1": gw._is_ordinal_label("第一"),
    "ord_2": gw._is_ordinal_label("第二"),
    "ord_3": gw._is_ordinal_label("第三"),
    "ord_first": gw._is_ordinal_label("first"),
    "ord_shouci": gw._is_ordinal_label("首次"),
    "ord_third_party": gw._is_ordinal_label("第三方"),
    "ord_cookie": gw._is_ordinal_label("第三方 Cookie"),
    "ord_semantica": gw._is_ordinal_label("Semantica"),

    # ── 以「的」结尾的中文修饰语（不是实体）──
    "cjkmod_kaiyuan": gw._is_cjk_modifier("开源的"),
    "cjkmod_queding": gw._is_cjk_modifier("确定性的"),
    "cjkmod_mudi": gw._is_cjk_modifier("目的"),
    "cjkmod_biaodi": gw._is_cjk_modifier("标的"),
    "cjkmod_zhongwen_ok": gw._is_cjk_modifier("中文"),
    "cjkmod_en_ok": gw._is_cjk_modifier("Context Graph"),
    "cjkmod_mixed_ok": gw._is_cjk_modifier("开源的 Semantica"),

    # ── 被截断成半个句子的英文假实体 ──
    "frag_en_for_and": gw._looks_like_sentence_fragment("for Context and"),
    "frag_en_trailing_and": gw._looks_like_sentence_fragment("Context and"),
    "frag_en_trailing_of": gw._looks_like_sentence_fragment("the list of"),
    "frag_en_two_funcs": gw._looks_like_sentence_fragment("context of the graph"),
    "frag_en_ok_semantica": gw._looks_like_sentence_fragment("Semantica"),
    "frag_en_ok_ctxgraph": gw._looks_like_sentence_fragment("Context Graph"),
    "frag_en_ok_beatles": gw._looks_like_sentence_fragment("The Beatles"),
    "frag_en_ok_mit": gw._looks_like_sentence_fragment("MIT License"),
    "frag_en_ok_threewords": gw._looks_like_sentence_fragment("Knowledge Graph Explorer"),
    "frag_en_cjk_ok": gw._looks_like_sentence_fragment("开源的 and 免费的"),

    # ── 行内代码证据 ──
    "code_ticked": gw._in_inline_code("因 \`numpy\` ABI 冲突", "numpy"),
    "code_bare": gw._in_inline_code("因 numpy ABI 冲突", "numpy"),
    "code_second_span": gw._in_inline_code("a \`x\` b \`numpy\` c", "numpy"),
    "code_empty": gw._in_inline_code("", "numpy"),

    # ── 类型表 ──
    "noise_has_cardinal": "CARDINAL" in gw._NOISE_ETYPES,
    "noise_has_date": "DATE" in gw._NOISE_ETYPES,
    "noise_has_law": "LAW" in gw._NOISE_ETYPES,
    "noise_keeps_person": "PERSON" not in gw._NOISE_ETYPES,
    "noise_keeps_language": "LANGUAGE" not in gw._NOISE_ETYPES,
    "untrusted_has_gpe": "GPE" in gw._CODE_UNTRUSTED_ETYPES,
    "shape_has_product": "PRODUCT" in gw._CODE_UNTRUSTED_ETYPES_SHAPE,
    "plain_untrusted_no_product": "PRODUCT" not in gw._CODE_UNTRUSTED_ETYPES,

    # ── 标识符形状 ──
    "shape_camel": bool(gw._IDENTIFIER_SHAPE.search("browserAllowedLoopback")),
    "shape_snake": bool(gw._IDENTIFIER_SHAPE.search("open_details")),
    "shape_ns": bool(gw._IDENTIFIER_SHAPE.search("std::vector")),
    "shape_gui": bool(gw._IDENTIFIER_SHAPE.search("GUI")),
    "shape_semantica": bool(gw._IDENTIFIER_SHAPE.search("Semantica")),
    "shape_typescript": bool(gw._IDENTIFIER_SHAPE.search("TypeScript")),
    "shape_github": bool(gw._IDENTIFIER_SHAPE.search("GitHub")),
    "shape_postgresql": bool(gw._IDENTIFIER_SHAPE.search("PostgreSQL")),
    "shape_any_panel": bool(gw._IDENTIFIER_SHAPE.search("anyPanel")),

    # ── 中文标签 ──
    "cjk_yes": bool(gw._CJK_LABEL.search("白名单")),
    "cjk_no": bool(gw._CJK_LABEL.search("GUI")),
    "cjk_untrusted_has_gpe": "GPE" in gw._CJK_UNTRUSTED_ETYPES,
    "cjk_untrusted_keeps_language": "LANGUAGE" not in gw._CJK_UNTRUSTED_ETYPES,

    # ── tool 节点详情 ──
    "tool_content": gw._tool_content({
        "title": "Check working directory",
        "name": "bash",
        "argsSummary": "command=pwd && ls -la",
        "resultSummary": "total 6536",
    }),
    "tool_content_only_title": gw._tool_content({"title": "Read file", "name": "read"}),
    "tool_content_empty": gw._tool_content({}),
    "tool_clip": len(gw._tool_content({
        "title": "t", "argsSummary": "a" * 5000, "resultSummary": "r" * 5000,
    })),
}
print(json.dumps(out, ensure_ascii=False))
`

const proc = spawnSync('python3', ['-c', PY], { encoding: 'utf8' })
if (proc.status !== 0) {
	console.error('  规则检查脚本执行失败：')
	console.error(proc.stderr || proc.stdout)
	process.exit(1)
}

const r = JSON.parse(proc.stdout.trim())

console.log('── 碎片判据：切在字母中间的要拦，完整词不能误伤')

check('cy ⊂ cytoscape 判为碎片', r.frag_cy === true, String(r.frag_cy))
check('MIT LICEN ⊂ MIT LICENSE 判为碎片', r.frag_mit === true, String(r.frag_mit))
check('cytoplasm 开头的 cy 判为碎片', r.frag_start === true, String(r.frag_start))
check('d3 不被误伤（前后是 /）', r.frag_ok_d3 === false, String(r.frag_ok_d3))
check('graph 不被误伤', r.frag_ok_graph === false, String(r.frag_ok_graph))
check('中文词不被误伤（白名单里…）', r.frag_cjk_ok === false, String(r.frag_cjk_ok))
check('中文词不被误伤（这张图……）', r.frag_cjk_mid === false, String(r.frag_cjk_mid))

console.log('── 序数词：按整词判，不按类型')
check('第一 / 第二 / 第三 判为序数', r.ord_1 && r.ord_2 && r.ord_3)
check('first / 首次 判为序数', r.ord_first && r.ord_shouci)
check('第三方 不是序数（被 zh 模型标成 ORDINAL 的那个）', r.ord_third_party === false, String(r.ord_third_party))
check('第三方 Cookie 不是序数', r.ord_cookie === false, String(r.ord_cookie))
check('Semantica 不是序数', r.ord_semantica === false, String(r.ord_semantica))

console.log('── 以「的」结尾的中文修饰语：形容词不是实体，但真名词不能误伤')
check('开源的 判为修饰语', r.cjkmod_kaiyuan === true, String(r.cjkmod_kaiyuan))
check('确定性的 判为修饰语', r.cjkmod_queding === true, String(r.cjkmod_queding))
check('目的 不被误伤（两个字真名词）', r.cjkmod_mudi === false, String(r.cjkmod_mudi))
check('标的 不被误伤', r.cjkmod_biaodi === false, String(r.cjkmod_biaodi))
check('中文 不被误伤', r.cjkmod_zhongwen_ok === false, String(r.cjkmod_zhongwen_ok))
check('Context Graph 不被误伤', r.cjkmod_en_ok === false, String(r.cjkmod_en_ok))
check('中英混合不被误伤', r.cjkmod_mixed_ok === false, String(r.cjkmod_mixed_ok))

console.log('── 被截断成半个句子的英文假实体')
check('for Context and 判为半句话（实测被标成 PERSON 的那个）', r.frag_en_for_and === true, String(r.frag_en_for_and))
check('Context and 判为半句话（以连词收尾）', r.frag_en_trailing_and === true, String(r.frag_en_trailing_and))
check('the list of 判为半句话（以介词收尾）', r.frag_en_trailing_of === true, String(r.frag_en_trailing_of))
check('context of the graph 判为半句话（功能词 ≥ 2）', r.frag_en_two_funcs === true, String(r.frag_en_two_funcs))
check('Semantica 不被误伤', r.frag_en_ok_semantica === false, String(r.frag_en_ok_semantica))
check('Context Graph 不被误伤', r.frag_en_ok_ctxgraph === false, String(r.frag_en_ok_ctxgraph))
check('The Beatles 不被误伤（起首功能词但只有 2 个词）', r.frag_en_ok_beatles === false, String(r.frag_en_ok_beatles))
check('MIT License 不被误伤', r.frag_en_ok_mit === false, String(r.frag_en_ok_mit))
check('Knowledge Graph Explorer 不被误伤', r.frag_en_ok_threewords === false, String(r.frag_en_ok_threewords))
check('含中文的不走这套判据', r.frag_en_cjk_ok === false, String(r.frag_en_cjk_ok))

console.log('── 行内代码证据')
check('反引号里的 numpy 有证据', r.code_ticked === true)
check('裸写的 numpy 没有证据', r.code_bare === false)
check('多个代码段里能找到第二个', r.code_second_span === true)
check('空文本不炸', r.code_empty === false)

console.log('── 类型表')
check('度量/时间类是噪声类型', r.noise_has_cardinal && r.noise_has_date && r.noise_has_law)
check('PERSON / LANGUAGE 不在噪声类型里', r.noise_keeps_person && r.noise_keeps_language)
check('GPE 属于「代码判据不可信」', r.untrusted_has_gpe)
check('标识符形状额外管住 PRODUCT', r.shape_has_product)
check('仅凭反引号不管 PRODUCT（GUI 不受影响）', r.plain_untrusted_no_product)

console.log('── 标识符形状')
check('驼峰判为标识符', r.shape_camel)
check('下划线判为标识符', r.shape_snake)
check('std::vector 判为标识符', r.shape_ns)
check('GUI 不被判为标识符', r.shape_gui === false, String(r.shape_gui))
check('Semantica 不被判为标识符', r.shape_semantica === false, String(r.shape_semantica))
check('TypeScript 不被判为标识符', r.shape_typescript === false, String(r.shape_typescript))
check('GitHub 不被判为标识符', r.shape_github === false, String(r.shape_github))
check('PostgreSQL 不被判为标识符', r.shape_postgresql === false, String(r.shape_postgresql))
check('anyPanel 判为标识符（小写开头的驼峰）', r.shape_any_panel === true)

console.log('── 中文标签')
check('含中文标签能识别', r.cjk_yes)
check('纯 ASCII 标签不误判', r.cjk_no === false)
check('含中文时 GPE 不可信', r.cjk_untrusted_has_gpe)
check('含中文时 LANGUAGE 保留', r.cjk_untrusted_keeps_language)

console.log('── tool 节点详情')
check('含标题 + 参数 + 输出', r.tool_content.includes('Check working directory') && r.tool_content.includes('pwd && ls -la') && r.tool_content.includes('total 6536'), r.tool_content.slice(0, 60))
check('参数和输出都带截断', r.tool_clip < 600, `长度 ${r.tool_clip}`)
check('没有参数输出时退回标题', r.tool_content_only_title === 'Read file', r.tool_content_only_title)
check('完全空时给个兜底', r.tool_content_empty === 'tool', r.tool_content_empty)

console.log('')
if (failures > 0) {
	console.log(`✗ ${failures} 项失败`)
	process.exit(1)
}
console.log('✓ 实体噪声规则全部通过')

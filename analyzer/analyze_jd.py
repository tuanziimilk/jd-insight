# -*- coding: utf-8 -*-
"""
AI 产品经理 JD 汇总分析器
========================

用途：把从 BOSS 直聘 / 智联 / 猎聘等处**手动复制**的 JD 原文批量结构化，
输出词频覆盖率、薪资带分布、岗位分型分布，以及"我的缺口排行"。

用法：
    1. 把 JD 原文贴进 ../05-资源库/JD原始数据/jd_raw.txt
       每条 JD 之间用一行 ===== 分隔（5 个以上等号即可）
       可选：在每条开头写元信息行，如
           #公司: 滴滴金融科技
           #岗位: AI客服产品经理
           #来源: BOSS
       没写也没关系，脚本会尽力从正文里提取。
    2. python analyze_jd.py
    3. 报告输出到 ../05-资源库/JD汇总报告.md

设计原则：
    - 词频统计用 **覆盖率**（出现在多少条 JD 里），不用总出现次数——
      "10 条 JD 里 8 条都要 RAG" 比 "RAG 一共出现 23 次" 更能指导简历。
    - 只用标准库，不装依赖。
"""
import glob
import io
import json
import os
import re
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RAWDIR = os.path.join(ROOT, "data")            # 插件导出的 txt / json 都丢这里
RAW = os.path.join(RAWDIR, "jd_raw.txt")
OUTDIR = os.path.join(ROOT, "reports")
OUT = os.path.join(OUTDIR, "jd_report.md")

SITE_NAME = {"zhipin": "BOSS", "zhaopin": "智联", "liepin": "猎聘",
             "lagou": "拉勾", "51job": "前程无忧"}

# ---------------------------------------------------------------- 配置加载
def _load_config():
    """优先 config.py（你自己的），缺失则用 config.example.py 并提示。"""
    import importlib.util

    def _load(path, name):
        spec = importlib.util.spec_from_file_location(name, path)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m

    mine = os.path.join(HERE, "config.py")
    demo = os.path.join(HERE, "config.example.py")
    if os.path.exists(mine):
        return _load(mine, "jd_cfg"), False
    print("⚠️  没找到 analyzer/config.py，先用 config.example.py 跑。")
    print("    想让「缺口排行」反映你自己的情况，执行：")
    print("      cd analyzer && cp config.example.py config.py   # Windows: copy")
    return _load(demo, "jd_cfg_demo"), True


CFG, USING_EXAMPLE = _load_config()
GROUPS = CFG.GROUPS
MY_PROFILE = getattr(CFG, "MY_PROFILE", {})
JOB_TYPES = getattr(CFG, "JOB_TYPES", {})


# ---------------------------------------------------------------- 自评闸门
#
# ⚠️ 这一段修的是一个**已经产生错误输出**的问题，不是防御性编程。
#
# 原来的 USING_EXAMPLE 只判断「config.py 存不存在」。而实测（2026-09-10）：
# config.py 存在，但和 config.example.py **逐字节完全相同** —— 也就是说
# MY_PROFILE 里躺的一直是模板占位：
#     "产品基本功": "🟢 示例：主导过某后台重构，PRD + 高保真原型 + 字段级规格"
# 于是 USING_EXAMPLE 为 False、警告一次都没打过，而报告
# （reports/jd_report.md）**把这些「示例」当成真实能力印出来了**，
# 并据此排出「你最该补 RAG / 对话式产品」。这份报告还回流进了知识库。
#
# 一个 AI 写的模板占位被当成事实输出 —— 它不报错，它给你一个
# 看起来很专业的错结论。这比报错危险得多。
#
# 所以判断依据从「文件存不存在」改成「内容填了没有」。
PLACEHOLDER_MARK = "示例"


def placeholder_groups(profile):
    """返回自评值还是模板占位的能力组名。

    只认「示例」这个标记词 —— 它是 config.example.py 里每一条自评的固定前缀。
    刻意不做更聪明的启发式（比如"长度太短""没有具体项目名"）：
    那种判断会误伤真实填写的简短自评，而误伤的表现是"明明填了却被拒"，
    比漏判更让人不想用。
    """
    return [g for g, v in (profile or {}).items() if PLACEHOLDER_MARK in str(v)]


PLACEHOLDER_GROUPS = placeholder_groups(MY_PROFILE)
# 一条都没填真的 → 自评整体不可用，「缺口排行」这一章必须拒绝输出
PROFILE_UNUSABLE = bool(MY_PROFILE) and len(PLACEHOLDER_GROUPS) == len(MY_PROFILE)

# 样本量下限。报告头部本来就写着「样本少于 10 条时结论不稳，别急着改简历口径」
# —— 但那只是一句提示，下面照样输出了带 🔥🔥 优先级的排行。
# 实测两份历史报告的样本量是 4 条和 3 条。
# ⚠️ 一句写在文档里、代码却不执行的规则，等于没有规则。现在让代码执行它。
MIN_SAMPLE = 10

SPLIT = re.compile(r"^={5,}\s*$", re.M)

# BOSS 用 Unicode 私有区字符 + 自定义字体渲染薪资数字，复制出来是乱码。
# 插件已剥掉，这里再兜一道，防止旧数据或别的站点带进来。
PUA = re.compile(r"[-]")


def parse_meta(block):
    meta = {}
    for m in re.finditer(r"^#\s*([^:：]+)[:：]\s*(.+)$", block, re.M):
        meta[m.group(1).strip()] = m.group(2).strip()
    return meta


def extract_salary(text):
    """返回 (下限K, 上限K, 几薪)。支持 30-45K·15薪 / 25K-40K / 20万-35万。"""
    m = re.search(r"(\d{1,3})\s*[-–~至]\s*(\d{1,3})\s*[kK]", text)
    lo = hi = None
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
    else:
        m2 = re.search(r"(\d{2,3})\s*[-–~至]\s*(\d{2,3})\s*万", text)
        if m2:  # 年包万 → 折月薪（按 13 薪粗算）
            lo, hi = round(int(m2.group(1)) * 10 / 13), round(int(m2.group(2)) * 10 / 13)
    mm = re.search(r"[·•,，]?\s*(\d{2})\s*薪", text)
    months = int(mm.group(1)) if mm else None
    return lo, hi, months


def extract_years(text):
    m = re.search(r"(\d+)\s*[-–~]\s*(\d+)\s*年", text)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r"(\d+)\s*年以上", text)
    if m:
        return int(m.group(1)), None
    m = re.search(r"经验\s*[:：]?\s*(\d+)\s*年", text)
    if m:
        return int(m.group(1)), int(m.group(1))
    return None, None


CITIES = ["上海", "北京", "深圳", "杭州", "广州", "成都", "南京", "苏州",
          "武汉", "西安", "厦门", "远程"]
DEGREES = ["博士", "硕士", "本科", "大专"]


def json_to_block(r):
    """插件导出的 JSON 记录 → 与 TXT 同构的文本块（和 popup.js 的 toBlock 一致）。"""
    first = lambda s: (s or "").split("\n")[0].strip()
    site = r.get("site", "")
    label = next((v for k, v in SITE_NAME.items() if k in site), site or "—")
    L = []
    if r.get("company"):
        L.append("#公司: " + first(r["company"]))
    if r.get("title"):
        L.append("#岗位: " + first(r["title"]))
    L.append("#来源: " + label)
    if r.get("salary"):
        L.append("#薪资: " + first(r["salary"]))
    if r.get("tagline"):
        L.append("#标签: " + re.sub(r"\n+", " / ", r["tagline"]))
    if r.get("url"):
        L.append("#链接: " + r["url"])
    if r.get("ts"):
        L.append("#采集时间: " + r["ts"])
    L.append("")
    body = r.get("body") or ""
    if len(body) < 120:                       # 正文没抓准 → 用整页文本兜底
        body = r.get("pageText") or body
    L.append(body)
    return "\n".join(L).strip()


def load_blocks():
    """把 JD原始数据/ 目录下所有 .txt 和 .json 都读进来，按链接去重。

    设计：JSON 是无损原始数据、TXT 是可手改的工作格式，两种都支持，
    同一岗位（#链接 相同）只保留一次，JSON 优先（字段更全）。
    """
    os.makedirs(RAWDIR, exist_ok=True)
    files = sorted(glob.glob(os.path.join(RAWDIR, "*.json"))) + \
            sorted(glob.glob(os.path.join(RAWDIR, "*.txt")))
    if not files:
        io.open(RAW, "w", encoding="utf-8").write(TEMPLATE)
        print("已创建模板：", os.path.normpath(RAW))
        print("用 Chrome 插件导出 jd_raw.txt / jd_backup.json 放进这个目录，或手动贴 JD 原文，再重跑。")
        return [], []

    blocks, seen, used = [], set(), []
    for f in files:
        raw = PUA.sub("", io.open(f, encoding="utf-8", errors="replace").read())
        got = 0
        if f.lower().endswith(".json"):
            try:
                data = json.loads(raw)
            except Exception as e:
                print(f"  ⚠ {os.path.basename(f)} 解析失败，跳过：{e}")
                continue
            if isinstance(data, dict):
                data = data.get("jds") or [data]
            for r in data:
                if not isinstance(r, dict):
                    continue
                key = (r.get("key") or r.get("url") or "").split("?")[0]
                if key and key in seen:
                    continue
                if key:
                    seen.add(key)
                b = json_to_block(r)
                if len(b) > 40:
                    blocks.append(b)
                    got += 1
        else:
            txt = re.sub(r"<!--.*?-->", "", raw, flags=re.S)
            for b in SPLIT.split(txt):
                b = b.strip()
                if len(b) <= 40:
                    continue
                m = re.search(r"^#\s*链接[:：]\s*(\S+)", b, re.M)
                key = m.group(1).split("?")[0] if m else ""
                if key and key in seen:
                    continue
                if key:
                    seen.add(key)
                blocks.append(b)
                got += 1
        used.append((os.path.basename(f), got))
    return blocks, used


def analyze():
    blocks, used = load_blocks()
    if not blocks:
        return
    print("读取：" + "、".join(f"{n}({c} 条)" for n, c in used))

    rows = []
    group_hits = Counter()          # 覆盖率：命中该组的 JD 条数
    kw_hits = Counter()             # 单个关键词的覆盖条数
    group_examples = defaultdict(set)

    for b in blocks:
        meta = parse_meta(b)
        low = b.lower()
        lo, hi, months = extract_salary(b)
        y0, y1 = extract_years(b)
        row = {
            "意向": meta.get("意向", ""),
            "状态": meta.get("状态", ""),
            "公司": meta.get("公司", "—"),
            "岗位": meta.get("岗位", "—"),
            "来源": meta.get("来源", "—"),
            "城市": next((c for c in CITIES if c in b), "—"),
            "学历": next((d for d in DEGREES if d in b), "—"),
            "薪资下限": lo, "薪资上限": hi, "薪数": months,
            "年限": f"{y0}-{y1}" if y0 and y1 else (f"{y0}+" if y0 else "—"),
            "命中组": [],
        }
        for g, kws in GROUPS.items():
            hit = [k for k in kws if k.lower() in low]
            if hit:
                group_hits[g] += 1
                row["命中组"].append(g)
                for k in hit:
                    kw_hits[k] += 1
                    group_examples[g].add(k)
        rows.append(row)

    n = len(rows)
    lines = []
    A = lines.append
    A("---")
    A("tags:")
    A("  - 资源/JD汇总")
    A("---")
    A("")
    A("# AI 产品经理 JD 汇总分析报告")
    A("")
    A(f"> 样本量：**{n} 条**｜由 `99-脚本/analyze_jd.py` 自动生成，原始数据在 `05-资源库/JD原始数据/jd_raw.txt`。")
    A("> 词频用**覆盖率**（出现在多少条 JD 里），不用总次数——「10 条里 8 条都要」比「一共出现 23 次」更能指导简历。")
    if n < MIN_SAMPLE:
        A(f"> ⚠️ **样本只有 {n} 条**（低于 {MIN_SAMPLE} 条）。缺口那一章已降级为只给计数、不排优先级。")
    if USING_EXAMPLE:
        A("> ⚠️ 没找到 `analyzer/config.py`，当前用的是 `config.example.py`。")
    if PROFILE_UNUSABLE:
        A("> ⚠️ **`MY_PROFILE` 还是模板占位**（每条都带「示例」），缺口那一章不输出。修法见该章。")
    elif PLACEHOLDER_GROUPS:
        A("> ⚠️ 这几个能力组的自评还是模板占位，已按「未填」处理："
          + "、".join(PLACEHOLDER_GROUPS))
    A("")
    A("---")
    A("")

    # ---- 能力要求覆盖率
    A("## 一、能力要求覆盖率（决定简历该突出什么）")
    A("")
    A("| 能力组 | 覆盖 | 占比 | 命中的关键词 | 我的现状 |")
    A("|---|---|---|---|---|")
    for g, c in group_hits.most_common():
        pct = f"{c / n * 100:.0f}%"
        bar = "█" * round(c / n * 10)
        kws = "、".join(sorted(group_examples[g])[:6])
        # 占位的自评不许当事实印出来，显示成明确的「未填」
        mine = MY_PROFILE.get(g, "—")
        if PLACEHOLDER_MARK in str(mine):
            mine = "—（未填自评）"
        A(f"| **{g}** | {c}/{n} {bar} | {pct} | {kws} | {mine} |")
    A("")

    # ---- 缺口排行
    A("## 二、缺口排行（覆盖率高 × 我还不行 = 最该补）")
    A("")
    # ⚠️ 两道闸门。任一不过就**不输出排行**，只说清为什么 ——
    #    这一章的每一行都在说「你该先补这个」，而那是会让人真去改简历、
    #    真去分配几周学习时间的结论。依据不成立时给一张表，
    #    比给一句"算不了"糟得多。
    if PROFILE_UNUSABLE:
        A("**这一章没有输出。** `analyzer/config.py` 里的 `MY_PROFILE` 还是")
        A("`config.example.py` 的模板占位（每条都带「示例」二字），不是你的真实自评。")
        A("")
        A("缺口 = 覆盖率高 × **我还不行** —— 后半截没有真实数据，整章结论就是假的。")
        A("历史上这一章正是在这个状态下输出过带 🔥🔥 优先级的排行，")
        A("并回流进了知识库。所以现在宁可空着。")
        A("")
        A("怎么修：编辑 `analyzer/config.py` 的 `MY_PROFILE`，")
        A("按 `GROUPS` 里的组名逐个填真实情况（🟢 有真实项目支撑 / 🟡 概念懂但缺实操 / 🔴 空白）。")
        A("这个文件被 `.gitignore` 排除，不会进仓库。")
    elif n < MIN_SAMPLE:
        A(f"**这一章降级输出。** 样本只有 {n} 条（低于 {MIN_SAMPLE} 条）。")
        A("")
        A("覆盖率在小样本下抖得很厉害：4 条里有 2 条提到某个能力就是 50%，")
        A("而那说的是这 4 条的巧合，不是市场的要求。所以这里**只给原始计数、不排优先级**")
        A("—— 🔥 那个符号会让人以为它是结论。")
        A("")
        gaps = [(g, c) for g, c in group_hits.most_common()
                if str(MY_PROFILE.get(g, "")).startswith(("🔴", "🟡"))]
        if gaps:
            A("| 能力组 | 命中 | 我的现状 |")
            A("|---|---|---|")
            for g, c in gaps:
                A(f"| {g} | {c}/{n} | {MY_PROFILE.get(g)} |")
        else:
            A("（当前自评里没有标 🔴 / 🟡 的能力组。）")
    else:
        gaps = [(g, c) for g, c in group_hits.most_common()
                if str(MY_PROFILE.get(g, "")).startswith(("🔴", "🟡"))]
        if gaps:
            A("| 优先级 | 能力组 | 覆盖率 | 我的现状 |")
            A("|---|---|---|---|")
            for i, (g, c) in enumerate(gaps, 1):
                flag = "🔥🔥" if c / n >= 0.5 else ("🔥" if c / n >= 0.3 else "·")
                A(f"| {flag} {i} | {g} | {c}/{n}（{c / n * 100:.0f}%） | {MY_PROFILE.get(g)} |")
        else:
            A("（自评里没有标 🔴 / 🟡 的能力组 —— 要么真的没缺口，要么自评填得太乐观。）")
    A("")

    # ---- 薪资带
    A("## 三、薪资带分布（校准报价）")
    A("")
    los = [r["薪资下限"] for r in rows if r["薪资下限"]]
    his = [r["薪资上限"] for r in rows if r["薪资上限"]]
    if los:
        los_s, his_s = sorted(los), sorted(his)
        med_lo = los_s[len(los_s) // 2]
        med_hi = his_s[len(his_s) // 2] if his_s else None
        A(f"- 有薪资信息的样本：**{len(los)}/{n}**")
        A(f"- 下限：最低 {min(los)}K ｜ **中位 {med_lo}K** ｜ 最高 {max(los)}K")
        if his_s:
            A(f"- 上限：最低 {min(his)}K ｜ **中位 {med_hi}K** ｜ 最高 {max(his)}K")
        A(f"- 带 N 薪的岗位：{sum(1 for r in rows if r['薪数'])} 条"
          f"（{'、'.join(str(r['薪数']) + '薪' for r in rows if r['薪数'])}）")
        A("")
        A(f"> 🎯 **报价参考**：按中位数，主报价区间可定在 **{med_lo}~{med_hi or med_lo + 10}K**；"
          f"低于 {min(los)}K 的岗位可以直接不看。")
    else:
        A("（样本里没有解析到薪资，检查 JD 原文是否包含 `30-45K` 这类格式。）")
    A("")

    # ---- 岗位分型
    A("## 四、岗位分型（决定做哪个 demo）")
    A("")
    TYPES = JOB_TYPES or {}
    A("| 分型 | 命中 JD 数 | 占比 |")
    A("|---|---|---|")
    for t, g in sorted(TYPES.items(), key=lambda kv: -group_hits[kv[1]]):
        c = group_hits[g]
        A(f"| {t} | {c}/{n} | {c / n * 100:.0f}% |")
    A("")
    A("> 🎯 **哪个分型占比最高，就先做那个 demo。** 占比接近时，选你已有素材最多的那个。")
    A("")

    # ---- 明细
    A("## 五、样本明细")
    A("")
    A("| # | 意向 | 状态 | 公司 | 岗位 | 城市 | 薪资 | 年限 | 主要要求 |")
    A("|---|---|---|---|---|---|---|---|---|")
    for i, r in enumerate(rows, 1):
        sal = (f"{r['薪资下限']}-{r['薪资上限']}K"
               + (f"·{r['薪数']}薪" if r["薪数"] else "")) if r["薪资下限"] else "—"
        A(f"| {i} | {r['意向'] or '—'} | {r['状态'] or '—'} | {r['公司']} | {r['岗位']} | "
          f"{r['城市']} | {sal} | {r['年限']} | {'、'.join(r['命中组'][:4])} |")
    A("")
    A("---")
    A("")
    A("## 六、高频单词 Top 25（写简历时逐个对照）")
    A("")
    A("| 关键词 | 覆盖条数 |")
    A("|---|---|")
    for k, c in kw_hits.most_common(25):
        A(f"| `{k}` | {c}/{n} |")
    A("")
    A("> 用法：**覆盖率 ≥ 50% 的词，简历里必须出现且有项目支撑**；")
    A("> 30~50% 的词，能挂上就挂；< 30% 的不必强求。")

    os.makedirs(OUTDIR, exist_ok=True)
    io.open(OUT, "w", encoding="utf-8", newline="").write("\n".join(lines))
    print(f"已分析 {n} 条 JD → {os.path.normpath(OUT)}")
    print("覆盖率 Top 5：", "、".join(f"{g}({c}/{n})" for g, c in group_hits.most_common(5)))


TEMPLATE = """<!--
把 JD 原文贴到下面，每条之间用一行 ===== 分隔（5 个以上等号）。
可选元信息（写在每条开头，不写也行）：
    #公司: 滴滴金融科技
    #岗位: AI客服产品经理
    #来源: BOSS
薪资、年限、城市、学历脚本会自己从正文里找，直接整段粘贴就行。
贴完运行：python analyze_jd.py
-->

#公司: 滴滴金融科技（北京嘀嘀无限）
#岗位: AI客服产品经理
#来源: BOSS

AI客服产品经理 30-45K·15薪 上海·普陀区·曹杨 3-5年 本科
滴滴金融科技正在搭建面向巴西、墨西哥市场的 AI 智能客服体系，覆盖葡萄牙语/西班牙语双语场景，
涉及现金贷、BNPL、信用卡、储蓄账户等多条金融业务线。寻找一位对 AI 产品有深度理解、
能独立主导 AI 客服从 0 到 1 落地的资深产品经理。
岗位职责：主导 AI 客服核心产品设计（意图识别、多轮对话管理、FAQ/RAG 知识问答、大模型对话能力）；
定义 AI 与人工的协作边界，设计转人工触发策略、上下文透传协议；推动 LLM 在金融客服场景落地，
设计合规内容过滤机制，规避金融幻觉风险；建立 AI 客服效果评估体系：ISR、FCR、幻觉率、误识别率等
指标的定义与监控；基于用户对话数据定期分析 Top 问题分布，驱动知识库和话术迭代；设计 AB 测试方案。
岗位要求：有智能客服、对话机器人、NLP 产品或大模型应用产品的完整落地经验；深度理解意图识别、
多轮对话、RAG、Prompt Engineering 等 AI 产品技术原理；具备扎实的产品设计能力，PRD 逻辑严密，
能覆盖边界情况和异常链路；英语工作能力。
加分项：有金融科技、支付、信贷等强合规场景的 AI 产品经验；有海外业务经验，熟悉葡萄牙语/西班牙语
市场用户特征；了解 LLM 微调（SFT）、RLHF、向量检索等技术原理；有 IM 产品或客服中台产品经验。

=====
"""

if __name__ == "__main__":
    analyze()

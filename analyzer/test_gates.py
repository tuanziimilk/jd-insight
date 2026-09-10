# -*- coding: utf-8 -*-
"""两道闸门的行为测试。

    python jd-insight/analyzer/test_gates.py

⚠️ 为什么需要它：这两道闸门的作用是**拒绝输出**，而"拒绝"这个行为最容易
出两种相反的错 ——
  · 漏拦：占位自评被当成事实印出去（这就是它要修的那个已发生的问题）
  · 误伤：真填了却被判成占位，表现是"明明填了却拒绝出报告"

误伤比漏拦更让人不想用这个工具，所以两个方向都要测。

不测报告全文（那要造一份 JD 语料），只测判定函数本身 —— 它是两道闸门
唯一的决策依据。
"""
import os
import sys

# Windows 控制台默认 GBK，print 到 emoji 直接 UnicodeEncodeError ——
# 而这个测试的用例里必须带 🟢🟡🔴（那是自评的真实格式）。
# 强制 stdout 走 utf-8，否则测试会因为"打印失败"而不是"断言失败"而挂掉，
# 那种失败最容易被误读成代码有 bug。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import importlib.util

spec = importlib.util.spec_from_file_location(
    "analyze_jd", os.path.join(HERE, "analyze_jd.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

fail = 0


def check(name, cond, detail=""):
    global fail
    print(("  ok   " if cond else "  FAIL ") + name + ("  " + detail if detail else ""))
    if not cond:
        fail += 1


print("── 占位识别（漏拦方向）──")
example = {
    "产品基本功": "🟢 示例：主导过某后台重构，PRD + 高保真原型 + 字段级规格",
    "数据能力": "🟢 示例：SQL / 漏斗分析 / 指标定义",
    "RAG / 检索": "🟡 示例：做过 Embedding 检索，缺生成侧",
    "对话式产品": "🔴 示例：没做过多轮对话产品",
}
ph = mod.placeholder_groups(example)
check("config.example.py 的四条全部被识别为占位", len(ph) == 4, str(ph))

print("\n── 真自评不被误伤（误伤方向）──")
real = {
    "产品基本功": "🟢 主导过 OMS 重构，PRD + 字段级规格 + 验收标准",
    "RAG / 检索": "🟡 搭过知识库检索链路，重排这块没深入",
    "对话式产品": "🔴 空白",
}
check("真自评一条都不被判成占位", mod.placeholder_groups(real) == [],
      str(mod.placeholder_groups(real)))
# ⚠️ 极短的真自评最容易被"聪明的启发式"误伤，所以专门钉一条
check("极短的真自评也不被误伤（🔴 空白 / 🟢 做过）",
      mod.placeholder_groups({"a": "🔴 空白", "b": "🟢 做过"}) == [])

print("\n── 部分填写：只标出没填的那几个，不整章拒绝 ──")
mixed = dict(real)
mixed["工程实现"] = "🟡 示例：会看代码"
ph2 = mod.placeholder_groups(mixed)
check("只识别出那一条占位", ph2 == ["工程实现"], str(ph2))
check("部分填写不算整体不可用",
      not (bool(mixed) and len(ph2) == len(mixed)))

print("\n── 空自评不算「占位」（那是另一种情况）──")
check("空 dict 的 placeholder_groups 为空", mod.placeholder_groups({}) == [])
check("None 不炸", mod.placeholder_groups(None) == [])

print("\n── 当前仓库的真实状态 ──")
print("  config.py 的 MY_PROFILE 共 %d 组，其中占位 %d 组"
      % (len(mod.MY_PROFILE), len(mod.PLACEHOLDER_GROUPS)))
check("PROFILE_UNUSABLE 正确反映当前状态",
      mod.PROFILE_UNUSABLE == (len(mod.MY_PROFILE) > 0
                               and len(mod.PLACEHOLDER_GROUPS) == len(mod.MY_PROFILE)),
      "PROFILE_UNUSABLE=%s" % mod.PROFILE_UNUSABLE)
check("样本量下限是 10（和报告头部那句提示一致）", mod.MIN_SAMPLE == 10,
      str(mod.MIN_SAMPLE))

print("")
if fail:
    print("!! %d 条断言不过" % fail)
    sys.exit(1)
print("全部断言通过")

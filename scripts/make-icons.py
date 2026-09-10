# -*- coding: utf-8 -*-
"""从源 logo 生成扩展图标（16 / 32 / 48 / 128）。

    python jd-insight/scripts/make-icons.py [源图路径]

默认源图：jd-insight/assets/logo-source.png
依赖：Pillow（只是开发期工具，不进扩展包）

──────────────────────────────────────────────────────────────
⚠️ 为什么 16px 要单独做，不能一起缩

完整插画里有：文档、四条文本线、放大镜、放射线。缩到 16px 之后
「JD」变成一团深色斑点、放大镜变成一个污点——在 Chrome 工具栏里
根本认不出是什么。而 16px 恰恰是**用户最常看到的那个尺寸**。

实测 32px 起细节还撑得住，所以只有 16 需要分叉：
它只放「JD」字形 + 一条琥珀底线，铺在米白圆角方块上。
图标家族在小尺寸上分叉是常规做法，不是偷懒。

16px 的字形是**从源图里裁出来的**，不是重新排字——换个字体会让
大小尺寸看起来不是一套东西。

⚠️ 图标自带米白底色，不跟随主题：它会同时出现在浅色和深色工具栏上，
透明底的单色标记在其中一种上必然消失。这两种情况都实际渲染核对过。
──────────────────────────────────────────────────────────────
"""
import os
import sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "assets", "logo-source.png")
OUT = os.path.join(ROOT, "extension", "icons")

# 源图文档的纸白。刻意不用 theme.css 的 --paper：
# 图标是独立视觉物，而且它要在两种工具栏底色上都成立。
PAPER = (243, 238, 228, 255)
AMBER = (214, 158, 62, 255)


def load_square(path):
    """读图，按 alpha 裁掉透明边，补成正方形，四周留 6% 呼吸。"""
    im = Image.open(path).convert("RGBA")
    bbox = im.split()[3].getbbox()
    if bbox:
        im = im.crop(bbox)
    w, h = im.size
    side = max(w, h)
    if w != h:
        sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        sq.paste(im, ((side - w) // 2, (side - h) // 2))
        im = sq
    pad = 0.06
    inner = int(round(side * (1 - pad * 2)))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im.resize((inner, inner), Image.LANCZOS),
                 ((side - inner) // 2, (side - inner) // 2))
    return canvas


def downscale(im, size):
    """两步降采样。从 1000+ 单步直降到小尺寸会丢笔画。"""
    step = im
    if im.size[0] > size * 4:
        step = im.resize((size * 4, size * 4), Image.LANCZOS)
    return step.resize((size, size), Image.LANCZOS)


def find_monogram(path):
    """圈出「JD」字形。

    ⚠️ 不能简单地"在某个矩形窗口里找深色像素"——第一版就是那么写的，
    窗口右边界拍脑袋定在 0.74W，结果把右边放射线的一角裁了进来。
    **任何元素只露一角，看起来就是"图标被切掉了"**，用户第一眼就发现了。

    改成按结构定位，三步：
      1. 列分布：统计每一列的深色像素数，取出连续的列区间。
         真字形是宽而高的块（J 的钩 69px 宽、竖笔 132px、D 283px），
         而背后那张纸的暗边只有 12px 宽、放射线的碎点只有 2px 高——
         用"宽 >= 20 且最高列 >= 30"就能把它们全滤掉。
      2. 上边界：整个 x 范围内最靠上的深色像素。
      3. 下边界：**只在左半边量**。D 和放大镜在垂直方向是连着的
         （实测中间没有空行），但左半边只有 J，不受污染；
         字母共用一条基线，所以拿 J 的底就是整体的底。
    """
    im = Image.open(path).convert("RGBA")
    W, H = im.size
    px = im.load()

    # 只看字形所在的高度带：放大镜顶端在 0.5H 以下
    ya, yb = int(H * 0.20), int(H * 0.50)

    def dark(x, y):
        r, g, b, a = px[x, y]
        return a > 128 and (r * 299 + g * 587 + b * 114) / 1000 < 110

    cols = []
    for x in range(W):
        n = 0
        for y in range(ya, yb):
            if dark(x, y):
                n += 1
        cols.append(n)

    runs, start = [], None
    for x, n in enumerate(cols + [0]):
        if n > 0 and start is None:
            start = x
        elif n == 0 and start is not None:
            w = x - start
            if w >= 20 and max(cols[start:x]) >= 30:
                runs.append((start, x - 1))
            start = None
    if not runs:
        raise SystemExit("找不到字形。换源图后需要重新核对这里的阈值。")

    x0, x1 = runs[0][0], runs[-1][1]

    top = H
    for x in range(x0, x1 + 1):
        for y in range(int(H * 0.10), yb):
            if dark(x, y):
                top = min(top, y)
                break

    # 下边界只在左半边量（那里没有放大镜）
    xmid = x0 + int((x1 - x0) * 0.45)
    bottom = -1
    for x in range(x0, xmid + 1):
        for y in range(int(H * 0.62), top, -1):
            if dark(x, y):
                bottom = max(bottom, y)
                break

    if bottom <= top:
        raise SystemExit("字形上下边界算反了，检查阈值")
    print("  字形定位：x %d..%d  y %d..%d（%dx%d）"
          % (x0, x1, top, bottom, x1 - x0 + 1, bottom - top + 1))
    return im.crop((x0, top, x1 + 1, bottom + 1))


def make16(path):
    jd = find_monogram(path)
    S = 512  # 先在大尺寸上画，最后一次性降采样
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=PAPER)
    # 尽量填满：16px 下"大"比"留白讲究"重要得多
    box = int(S * 0.80)
    jw, jh = jd.size
    sc = min(box / jw, box / jh)
    jd2 = jd.resize((max(1, int(jw * sc)), max(1, int(jh * sc))), Image.LANCZOS)
    canvas.alpha_composite(jd2, ((S - jd2.size[0]) // 2, (S - jd2.size[1]) // 2))
    # 一条琥珀底线：保留家族里唯一的彩色元素，同时把方块锚住
    d.rounded_rectangle([int(S * 0.22), int(S * 0.80), int(S * 0.78), int(S * 0.855)],
                        radius=int(S * 0.028), fill=AMBER)
    return downscale(canvas, 16)


def main():
    if not os.path.exists(SRC):
        raise SystemExit("找不到源图：" + SRC)
    print("源图：" + SRC)
    os.makedirs(OUT, exist_ok=True)

    full = load_square(SRC)
    for size in (128, 48, 32):
        p = os.path.join(OUT, "icon%d.png" % size)
        downscale(full, size).save(p, "PNG", optimize=True)
        print("  icon%-4d %6d 字节（完整插画）" % (size, os.path.getsize(p)))

    p16 = os.path.join(OUT, "icon16.png")
    make16(SRC).save(p16, "PNG", optimize=True)
    print("  icon16   %6d 字节（简化：JD 字形 + 琥珀底线）" % os.path.getsize(p16))

    # 自查尺寸，别让一个写坏的文件混进去
    bad = []
    for size in (16, 32, 48, 128):
        im = Image.open(os.path.join(OUT, "icon%d.png" % size))
        if im.size != (size, size) or im.mode != "RGBA":
            bad.append("icon%d：%s %s" % (size, im.size, im.mode))
    if bad:
        raise SystemExit("!! 输出有问题：" + "；".join(bad))
    print("四个尺寸均为正方形 RGBA，OK")


if __name__ == "__main__":
    main()

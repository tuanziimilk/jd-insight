/* 漏斗可视化：vanilla JS 版本的 career-web FunnelChart 组件。
 *
 * pipeline.js 的 funnel()/needsFollowUp()/failBreakdown() 早就写好了——
 * 这是本次功能梳理最大的发现之一：数据模型和计算逻辑齐全，
 * 但从未在任何界面里被调用过。这个文件只负责"画出来"，不重算指标。
 *
 * 不能直接搬 career-web 的 React 组件（那边是 JSX + 构建管线），
 * 扩展这边坚持零构建，所以用 DOM API 手写等价的 SVG，
 * 绘制逻辑（条形长度、颜色语义、文字排版）和 React 版保持一致。
 */
import { funnel, needsFollowUp, failBreakdown } from "./pipeline.js";

const SVGNS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function renderFunnelSVG(rows) {
  const W = 460;
  const rowH = 40;
  const gap = 8;
  const H = rows.length * (rowH + gap) - gap + 6;
  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  const labelW = 78;
  const barMaxW = W - labelW - 66;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label":
      "投递漏斗：" + rows.map((r) => `${r.label} ${r.count} 条`).join("，"),
    style: "display:block;width:100%;height:auto;",
  });

  rows.forEach((r, i) => {
    const y = i * (rowH + gap);
    const w = maxCount ? (r.count / maxCount) * barMaxW : 0;
    const color =
      r.id === "已挂" || r.id === "已拒" || r.id === "不考虑"
        ? "var(--stop)"
        : r.optional
          ? "var(--muted)"
          : "var(--acc)";

    svg.appendChild(
      Object.assign(svgEl("text", { x: 0, y: y + rowH / 2 + 4, "font-size": "11.5", fill: "currentColor" }), {
        textContent: r.label,
      })
    );
    svg.appendChild(svgEl("rect", { x: labelW, y: y + 5, width: barMaxW, height: rowH - 10, rx: 4, fill: "var(--sunk)" }));
    svg.appendChild(
      svgEl("rect", {
        x: labelW,
        y: y + 5,
        width: Math.max(2, w),
        height: rowH - 10,
        rx: 4,
        fill: color,
        opacity: r.optional ? 0.55 : 0.9,
      })
    );
    svg.appendChild(
      Object.assign(
        svgEl("text", { x: labelW + barMaxW + 8, y: y + rowH / 2 - 2, "font-size": "12", "font-weight": "700", fill: "currentColor" }),
        { textContent: String(r.count) }
      )
    );
    svg.appendChild(
      Object.assign(
        svgEl("text", { x: labelW + barMaxW + 8, y: y + rowH / 2 + 12, "font-size": "9.5", fill: "var(--muted)" }),
        { textContent: r.optional ? "标记" : r.rate == null ? "—" : Math.round(r.rate * 100) + "%" }
      )
    );
  });

  return svg;
}

/** 挂载漏斗标签页到 container，jobs 是 JD Insight 现有的 chrome.storage.local.jds 数组 */
export function renderFunnelTab(container, jobs) {
  container.innerHTML = "";
  if (!jobs.length) {
    const p = document.createElement("p");
    p.style.cssText = "color:var(--muted);font-size:12.5px;text-align:center;padding:24px 0;";
    p.textContent = "还没有采集任何 JD。";
    container.appendChild(p);
    return;
  }

  const f = funnel(jobs);
  const fu = needsFollowUp(jobs, f.silentDays);
  const fails = failBreakdown(jobs);

  const wrap = document.createElement("div");
  wrap.style.cssText = "display:grid;gap:14px;padding:12px;";

  // 统计卡
  const stats = document.createElement("div");
  stats.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);gap:8px;";
  // 小工具：两端对齐的一行。用 textContent 而不是 innerHTML——
  // title/company/failReason 都来自抓取的网页内容，是不可信输入，
  // 拼进 innerHTML 等于给扩展页面开了个 XSS 口子。
  const kvRow = (left, right, rightColor) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;gap:8px;font-size:11.5px;padding:3px 0;";
    const l = document.createElement("span");
    l.textContent = left;
    const r = document.createElement("span");
    r.style.cssText = "font-family:var(--mono);font-weight:700;flex:none;" + (rightColor ? "color:" + rightColor + ";" : "");
    r.textContent = right;
    row.append(l, r);
    return row;
  };

  const statItems = [
    ["已采集", jobs.length, ""],
    ["已投递", f.applied, ""],
    ["沉默率", f.silentRate == null ? "—" : Math.round(f.silentRate * 100) + "%", `阈值${f.silentDays}天`],
    ["回音中位", f.replyMedianDays == null ? "—" : f.replyMedianDays + "天", ""],
  ];
  statItems.forEach(([label, val, hint]) => {
    const c = document.createElement("div");
    c.style.cssText = "background:var(--card-solid);border:1px solid var(--rule);border-radius:6px;padding:8px 10px;";
    c.innerHTML =
      `<div style="font-size:9.5px;color:var(--muted);font-family:var(--mono);">${label}</div>` +
      `<div style="font-size:18px;font-weight:700;margin-top:2px;">${val}</div>` +
      (hint ? `<div style="font-size:9.5px;color:var(--muted);">${hint}</div>` : "");
    stats.appendChild(c);
  });
  wrap.appendChild(stats);

  // 漏斗图
  const funnelBox = document.createElement("div");
  funnelBox.style.cssText = "background:var(--card-solid);border:1px solid var(--rule);border-radius:6px;padding:12px;overflow-x:auto;";
  funnelBox.appendChild(renderFunnelSVG(f.rows));
  wrap.appendChild(funnelBox);

  // 待跟进
  if (fu.length) {
    const box = document.createElement("div");
    box.style.cssText = "background:var(--card-solid);border:1px solid var(--warn);border-radius:6px;padding:10px 12px;";
    box.innerHTML = `<div style="font-size:12px;font-weight:600;color:var(--warn);margin-bottom:6px;">⚠ 待跟进（沉默 ≥ ${f.silentDays} 天）</div>`;
    fu.forEach((j) => {
      box.appendChild(kvRow(`${j.title}（${j.company}）`, `${j._silentFor}天`, "var(--warn)"));
    });
    wrap.appendChild(box);
  }

  // 挂掉归因
  if (fails.length) {
    const box = document.createElement("div");
    box.style.cssText = "background:var(--card-solid);border:1px solid var(--rule);border-radius:6px;padding:10px 12px;";
    box.innerHTML = `<div style="font-size:12px;font-weight:600;margin-bottom:6px;">挂掉归因</div>`;
    fails.forEach(([reason, count]) => {
      box.appendChild(kvRow(reason, String(count)));
    });
    wrap.appendChild(box);
  }

  container.appendChild(wrap);
}

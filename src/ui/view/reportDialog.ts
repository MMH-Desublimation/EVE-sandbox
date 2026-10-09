/**
 * 战报窗口：点击右上角「战报」后**暂停推演**，并即时统计**当前 tick** 的各方战损。
 *
 * 布局：纵行分格 —— **每个格子是一个势力**，格内按吨位从大到小逐行列出
 *   `无畏舰：39（27）`
 * 含义：该势力此时间点共**参战（已入场）** 39 条无畏舰，其中 **27 条已被击毁**。
 *
 * 统计口径（与引擎一致）：
 *   · 参战总数 = 已入场单位（含后续增援），**不含**尚未入场的预备单位；
 *   · 击毁数 = `alive === false` 的单位（被击毁的单位仍留在帧里，只是不再存活）；
 *   · 撤离（`evac`）单独统计，不计入击毁。
 */
import { el } from "../util/dom.ts";
import type { Frame, UnitFrame } from "../protocol.ts";
import { iconClassLabel, ICON_CLASS_ORDER } from "../../shared/hullclass.ts";
import { sideColor, sideName } from "../app/sides.ts";

interface ClassRow {
  cls: string;
  total: number;
  killed: number;
}

/** 当前打开的战报窗口（用于新帧到达时刷新数值）。 */
let current: { root: HTMLElement; update: (f: Frame | null) => void } | null = null;

export function openReportDialog(frame: Frame | null): void {
  // 已经开着 → 只刷新，不叠第二层
  if (current) {
    current.update(frame);
    return;
  }

  const overlay = el("div");
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", background: "rgba(0,0,0,0.55)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: "2100",
  });

  const box = el("div");
  Object.assign(box.style, {
    background: "#0c111c", border: "1px solid #2a3550", borderRadius: "10px",
    padding: "18px 20px", color: "#dce6f5", font: "14px system-ui",
    boxShadow: "0 10px 40px rgba(0,0,0,0.5)", maxWidth: "92vw", maxHeight: "88vh",
    overflow: "auto",
  });

  const title = el("div");
  Object.assign(title.style, { fontSize: "15px", fontWeight: "600", marginBottom: "4px" });
  box.appendChild(title);

  const sub = el("div");
  Object.assign(sub.style, { fontSize: "12px", color: "#7f8db0", marginBottom: "14px" });
  box.appendChild(sub);

  // 纵行分格：每个势力一格
  const grid = el("div");
  Object.assign(grid.style, {
    display: "flex", gap: "14px", alignItems: "flex-start", flexWrap: "wrap",
  });
  box.appendChild(grid);

  const btnRow = el("div");
  Object.assign(btnRow.style, { display: "flex", justifyContent: "flex-end", marginTop: "16px" });
  const closeBtn = el("button", undefined, "关闭");
  Object.assign(closeBtn.style, {
    background: "#33405e", color: "#cdd8ee", border: "none", borderRadius: "6px",
    padding: "7px 16px", cursor: "pointer", fontSize: "13px",
  });
  btnRow.appendChild(closeBtn);
  box.appendChild(btnRow);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  function close(): void {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener("keydown", onKey);
    current = null;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }

  function update(f: Frame | null): void {
    const units = f?.units ?? [];
    if (f) {
      title.textContent = "战报";
      sub.textContent = `时间点：第 ${f.tick} tick`
        + (f.finished ? "（推演已结束）" : "（已暂停）")
        + `　·　共 ${units.length} 条已入场`;
    } else {
      title.textContent = "战报";
      sub.textContent = "暂无推演数据";
    }

    grid.textContent = "";
    const sides = [...new Set(units.map((u) => u.sideId))].sort((a, b) => a - b);
    if (sides.length === 0) {
      const empty = el("div", undefined, "（当前没有单位在场）");
      Object.assign(empty.style, { color: "#7f8db0" });
      grid.appendChild(empty);
      return;
    }
    for (const sideId of sides) {
      grid.appendChild(sideCard(sideId, units));
    }
  }

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  current = { root: overlay, update };
  update(frame);
}

/** 新帧到达时刷新已打开的战报窗口（未打开则无操作）。 */
export function updateReportDialog(frame: Frame | null): void {
  if (current) current.update(frame);
}

/** 某一势力的战损格。 */
function sideCard(sideId: number, units: UnitFrame[]): HTMLElement {
  const card = el("div");
  Object.assign(card.style, {
    border: `1px solid ${sideColor(sideId)}55`,
    borderTop: `3px solid ${sideColor(sideId)}`,
    borderRadius: "8px", padding: "12px 14px", minWidth: "220px",
    background: "#111827",
  });

  const head = el("div", undefined, sideName(sideId));
  Object.assign(head.style, {
    fontSize: "14px", fontWeight: "600", color: sideColor(sideId), marginBottom: "8px",
  });
  card.appendChild(head);

  const list = units.filter((u) => u.sideId === sideId);
  const killed = list.filter((u) => !u.alive).length;
  const evacuated = list.filter((u) => u.evac).length;
  const alive = list.filter((u) => u.alive && !u.evac).length;

  const sum = el("div", undefined,
    `参战 ${list.length}　存活 ${alive}　击毁 ${killed}　撤离 ${evacuated}`);
  Object.assign(sum.style, {
    fontSize: "12px", color: "#9fb0d4", marginBottom: "10px",
    paddingBottom: "8px", borderBottom: "1px solid #22304d",
  });
  card.appendChild(sum);

  const rows = classRows(list);
  if (rows.length === 0) {
    const empty = el("div", undefined, "（无单位）");
    Object.assign(empty.style, { color: "#7f8db0", fontSize: "13px" });
    card.appendChild(empty);
    return card;
  }

  for (const r of rows) {
    const line = el("div");
    Object.assign(line.style, {
      display: "flex", justifyContent: "space-between", gap: "12px",
      padding: "3px 0", fontSize: "13px",
    });
    const label = el("span", undefined, iconClassLabel(r.cls));
    // 用户要求的格式：`无畏舰：39（27）`
    const value = el("span", undefined, `${r.total}（${r.killed}）`);
    Object.assign(value.style, {
      color: r.killed > 0 ? "#e0806f" : "#cdd8ee",
      fontWeight: r.killed > 0 ? "600" : "400",
    });
    line.append(label, value);
    card.appendChild(line);
  }

  const legend = el("div", undefined, "参战总数（其中已被击毁）");
  Object.assign(legend.style, {
    fontSize: "11px", color: "#5f6d8c", marginTop: "10px",
    paddingTop: "8px", borderTop: "1px solid #22304d",
  });
  card.appendChild(legend);
  return card;
}

/** 按吨位汇总：total = 已入场参战数，killed = 其中已被击毁数。 */
function classRows(units: UnitFrame[]): ClassRow[] {
  const map = new Map<string, ClassRow>();
  for (const u of units) {
    const cls = String(u.icon ?? "unknown");
    let r = map.get(cls);
    if (!r) map.set(cls, (r = { cls, total: 0, killed: 0 }));
    r.total++;
    if (!u.alive) r.killed++;
  }
  const order = ICON_CLASS_ORDER as readonly string[];
  return [...map.values()].sort((a, b) => {
    const ia = order.indexOf(a.cls);
    const ib = order.indexOf(b.cls);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
}

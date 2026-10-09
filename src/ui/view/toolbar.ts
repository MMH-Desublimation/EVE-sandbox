/**
 * 沙盘右上角功能工具条（用户参考截图的对应实现）。
 *
 * 功能：适应全体 / 适应星系 / 聚焦选中 / 网格 / 锁定+射程环 / 电子战连线 / 视野读数。
 * 全部是**显示层开关**，不改变任何引擎状态；环与连线也只影响绘制。
 */
import { el } from "../util/dom.ts";
import type { BattleMap } from "./map.ts";
import { formatDist } from "./map.ts";

export interface MapToolbar {
  root: HTMLElement;
  /** 每帧/低频同步视野读数。 */
  tick(): void;
  /**
   * 在工具条上闪一条提示（如引擎报错、指令被拒）。
   *
   * ★ 存在的意义：命令失败时 worker 会回一条 `{type:"error"}`，旧版界面**完全忽略**它，
   *   于是"属性组合未预热"这类失败表现为**没有任何反应/像卡死**。现在会显示出来。
   */
  notify(text: string): void;
}

export interface MapToolbarOptions {
  /** 点击「战报」：**先暂停推演**，再弹出当前时间点的各方战损窗口。 */
  onReport: () => void;
}

export function createMapToolbar(map: BattleMap, opts: MapToolbarOptions): MapToolbar {
  const root = el("div", "map-toolbar-inner");
  const ov = map.overlay;

  const mkBtn = (label: string, title: string, on: () => void): HTMLButtonElement => {
    const b = el("button", "tb-btn", label) as HTMLButtonElement;
    b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      on();
    });
    return b;
  };

  const toggle = (label: string, title: string, initial: boolean, apply: (v: boolean) => void) => {
    const b = mkBtn(label, title, () => {
      const next = !b.classList.contains("on");
      b.classList.toggle("on", next);
      apply(next);
    });
    b.classList.toggle("on", initial);
    return b;
  };

  const fitBtn = mkBtn("适应全体", "把视野收到所有存活单位", () => map.fit());
  const sysBtn = mkBtn("适应星系", "连星门一起收进画面", () => map.fitSystem());
  const focusBtn = mkBtn("聚焦选中", "把选中的单位挪到屏幕中心", () => {
    if (!map.focusSelection()) flash("未选中任何单位");
  });

  const gridBtn = toggle("网格", "显示/隐藏网格", ov.grid, (v) => map.setOverlay({ grid: v }));
  const ringBtn = toggle("锁定/射程环",
    "显示选中单位的三个环：锁定距离（橙实线）／最佳射程（绿实线）／有效射程＝最佳+失准（浅绿虚线）",
    ov.rings, (v) => map.setOverlay({ rings: v }));
  const ewBtn = toggle("电子战连线", "显示电子战/遥修等效果连线", ov.ewLines, (v) => map.setOverlay({ ewLines: v }));

  const spanLabel = el("span", "tb-span num", "");
  const notice = el("span", "tb-notice", "");

  // ★ 战报：暂停推演 + 弹出各方战损（按吨位逐行）
  const reportBtn = mkBtn("战报", "暂停推演，并查看当前时间点的各方战损（按吨位统计）",
    () => opts.onReport());

  root.append(fitBtn, sysBtn, focusBtn, el("span", "tb-sep"), gridBtn, ringBtn, ewBtn,
    el("span", "tb-sep"), reportBtn, el("span", "tb-sep"), spanLabel, notice);

  // 阻止点击穿透到 canvas（避免误触发平移/框选）
  root.addEventListener("mousedown", (e) => e.stopPropagation());
  root.addEventListener("wheel", (e) => e.stopPropagation());

  let noticeTimer = 0;
  function flash(text: string): void {
    notice.textContent = text;
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => { notice.textContent = ""; }, 1600);
  }

  /** 报错/被拒提示：停留久一点（用户需要时间去读），并用醒目样式。 */
  function notify(text: string): void {
    notice.textContent = text.length > 90 ? `${text.slice(0, 90)}…` : text;
    notice.classList.add("warn");
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      notice.textContent = "";
      notice.classList.remove("warn");
    }, 6000);
  }

  function tick(): void {
    const span = map.viewSpanM();
    const text = span >= 1_000_000_000
      ? `${(span / 149_597_870_700).toFixed(2)} AU`
      : formatDist(span);
    if (spanLabel.textContent !== text) spanLabel.textContent = text;
  }

  return { root, tick, notify };
}

/**
 * 增援对话框：右键「增援到此处」时弹出，让用户选择
 *   势力（红/蓝）、数量、配置（配置库里的某条配装）、入场方式。
 * 确认后由调用方组装 reinforce 命令（worker 会在入队前算好属性并生成单位）。
 */
import { el } from "../util/dom.ts";
import type { FitEntry } from "../app/store.ts";

export interface ReinforceChoice {
  sideId: number;
  count: number;
  fitId: string;
  mode: "gate" | "jump";
}

export interface ReinforceDialogOpts {
  fits: FitEntry[];
  mode: "gate" | "jump";
  defaultSide?: number;
  point?: { x: number; y: number };
  /**
   * 可选势力：`id` 就是**引擎用的 sideId**（0 = 蓝方，1 = 红方 …），`name` 走 `sideName()`。
   *
   * ★ 绝不能在这里自造 1/2 这样的编号 —— 引擎/配色/星门归属全按 0 基下标，
   *   错位会让增援落到一个不存在的势力（显示成「3号势力」、找不到星门、还没有配色）。
   */
  sides?: Array<{ id: number; name: string }>;
}

const overlayStyle: Partial<CSSStyleDeclaration> = {
  position: "fixed", inset: "0", background: "rgba(0,0,0,0.55)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: "2000",
};
const boxStyle: Partial<CSSStyleDeclaration> = {
  background: "#0c111c", border: "1px solid #2a3550", borderRadius: "10px",
  padding: "18px 20px", minWidth: "340px", color: "#dce6f5", font: "14px system-ui",
  boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
};

export function openReinforceDialog(opts: ReinforceDialogOpts): Promise<ReinforceChoice | null> {
  return new Promise((resolve) => {
    const overlay = el("div");
    Object.assign(overlay.style, overlayStyle);
    const box = el("div");
    Object.assign(box.style, boxStyle);

    const title = el("div");
    title.textContent = opts.mode === "gate"
      ? "增援：星门派遣到此处"
      : "增援：旗舰跳直达此处";
    Object.assign(title.style, { fontSize: "15px", fontWeight: "600", marginBottom: "4px" });
    box.appendChild(title);

    const sub = el("div");
    const p = opts.point;
    sub.textContent = p ? `坐标 (${Math.round(p.x)}, ${Math.round(p.y)})` : "";
    Object.assign(sub.style, { fontSize: "12px", color: "#7f8db0", marginBottom: "12px" });
    box.appendChild(sub);

    // 势力
    const sideRow = el("div");
    Object.assign(sideRow.style, { display: "flex", gap: "8px", marginBottom: "10px", alignItems: "center" });
    sideRow.appendChild(label("势力"));
    const sideSel = el("select") as HTMLSelectElement;
    const sides = opts.sides && opts.sides.length > 0
      ? opts.sides
      : [{ id: 0, name: "蓝方" }, { id: 1, name: "红方" }];
    for (const s of sides) sideSel.appendChild(option(String(s.id), s.name));
    // 默认选「指定势力」；不在列表里则退回第一项
    const wantDefault = String(opts.defaultSide ?? sides[0].id);
    sideSel.value = sides.some((s) => String(s.id) === wantDefault) ? wantDefault : String(sides[0].id);
    sideRow.appendChild(sideSel);
    box.appendChild(sideRow);

    // 数量
    const countRow = el("div");
    Object.assign(countRow.style, { display: "flex", gap: "8px", marginBottom: "10px", alignItems: "center" });
    countRow.appendChild(label("数量"));
    const countInput = el("input") as HTMLInputElement;
    countInput.type = "number";
    countInput.min = "1";
    countInput.max = "256";
    countInput.value = "1";
    Object.assign(countInput.style, { width: "80px" });
    countRow.appendChild(countInput);
    box.appendChild(countRow);

    // 配置
    const fitRow = el("div");
    Object.assign(fitRow.style, { display: "flex", gap: "8px", marginBottom: "16px", alignItems: "center" });
    fitRow.appendChild(label("配置"));
    const fitSel = el("select") as HTMLSelectElement;
    if (opts.fits.length === 0) {
      const o = option("", "（配置库为空）");
      o.disabled = true;
      fitSel.appendChild(o);
    } else {
      for (const f of opts.fits) {
        fitSel.appendChild(option(f.id, `${f.name}（${f.shipName}）`));
      }
    }
    fitSel.value = opts.fits[0]?.id ?? "";
    Object.assign(fitSel.style, { flex: "1" });
    fitRow.appendChild(fitSel);
    box.appendChild(fitRow);

    // 按钮
    const btnRow = el("div");
    Object.assign(btnRow.style, { display: "flex", gap: "10px", justifyContent: "flex-end" });
    const cancelBtn = el("button", undefined, "取消");
    const okBtn = el("button", undefined, "确认增援") as HTMLButtonElement;
    Object.assign(cancelBtn.style, btnStyle("#33405e", "#cdd8ee"));
    Object.assign(okBtn.style, btnStyle("#2b6df0", "#ffffff"));
    okBtn.disabled = opts.fits.length === 0;
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(btnRow);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close(v: ReinforceChoice | null): void {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
      resolve(v);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") close(null);
      if (e.key === "Enter" && !okBtn.disabled) confirm();
    }
    function confirm(): void {
      const fitId = fitSel.value;
      if (!fitId) return close(null);
      close({
        sideId: Number(sideSel.value),
        // 单次增援上限 256 个单位（引擎侧同样强制截断）
        count: Math.min(256, Math.max(1, Number(countInput.value) || 1)),
        fitId,
        mode: opts.mode,
      });
    }

    cancelBtn.addEventListener("click", () => close(null));
    okBtn.addEventListener("click", confirm);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onKey);
    setTimeout(() => fitSel.focus(), 0);
  });
}

function label(text: string): HTMLElement {
  const l = el("div");
  l.textContent = text;
  Object.assign(l.style, { width: "48px", color: "#9fb0d4", fontSize: "13px" });
  return l;
}
function option(value: string, text: string): HTMLOptionElement {
  const o = el("option") as HTMLOptionElement;
  o.value = value;
  o.textContent = text;
  return o;
}
function btnStyle(bg: string, fg: string): Partial<CSSStyleDeclaration> {
  return {
    background: bg, color: fg, border: "none", borderRadius: "6px",
    padding: "7px 14px", cursor: "pointer", fontSize: "13px",
  };
}

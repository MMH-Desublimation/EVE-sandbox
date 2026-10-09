/**
 * 装备 / 武器按钮的**显示标签**（中文简写）。
 *
 * ★ 为什么不放进 viewModel：
 *   `moduleLayout` / `weaponLayout` 是在 **Worker** 里执行的（sim.worker 用它组帧），
 *   而 `sde.ts` 的数据路径是 `new URL("./data/*.json", import.meta.url)`，
 *   在 Worker 里会解析到 `/src/ui/worker/data/…` 而取不到数据 ——
 *   于是 `zhName()` 返回 null，标签退化成英文名截断（"Multispectrum…" → "Multis"）。
 *   标签纯属展示层关切，因此统一在**主线程**按 typeId 现算。
 *
 * 只影响按钮上写什么字，不参与任何引擎语义与数值计算。
 */
import { groupOf, zhName } from "../sde.ts";
import { moduleAbbr, weaponAbbr } from "./abbr.ts";

/** 装备按钮文字：中文简写，如 `多谱式护盾增强器 II` → `盾全抗`。 */
export function moduleLabelOf(typeId: number, fallback = ""): string {
  const zh = zhName(typeId) ?? "";
  const group = groupOf(typeId)?.name ?? "";
  const abbr = moduleAbbr(zh || fallback, group);
  return abbr && abbr !== "?" ? abbr : (zh || fallback || `#${typeId}`);
}

/** 武器按钮文字：去掉科技等级后缀，如 `1400mm榴弹炮 II` → `1400mm榴弹炮`。 */
export function weaponLabelOf(typeId: number, fallback = ""): string {
  const zh = zhName(typeId) ?? "";
  const abbr = weaponAbbr(zh || fallback);
  return abbr || (zh || fallback || `#${typeId}`);
}

/** 弹药名也走中文（帧里来自 oracle，可能是英文名）。 */
export function chargeLabelOf(typeId: number | undefined | null, fallback = ""): string {
  if (typeId === undefined || typeId === null) return fallback;
  return zhName(typeId) ?? fallback;
}

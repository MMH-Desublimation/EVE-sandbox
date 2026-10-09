/**
 * 势力元数据注册表（名称 + 颜色）。
 *
 * 引擎侧只认数字 sideId；名称/颜色属于**展示层**，由「战场编成」页决定。
 * 生成推演前由 main.ts 写入，左侧舰队列表、沙盘染色、战报等处统一来此取。
 */
import { SIDE_PALETTE } from "./store.ts";

export interface SideMeta {
  name: string;
  color: string;
}

const DEFAULT_META: SideMeta[] = [
  { name: "蓝方", color: SIDE_PALETTE[0] },
  { name: "红方", color: SIDE_PALETTE[1] },
];

const registry = new Map<number, SideMeta>();

/** 写入势力元数据（sideId 按数组下标）。 */
export function setSideMeta(list: SideMeta[]): void {
  registry.clear();
  list.forEach((m, i) => registry.set(i, m));
}

export function sideMeta(sideId: number): SideMeta {
  return registry.get(sideId) ?? DEFAULT_META[sideId] ?? { name: `${sideId + 1}号势力`, color: "#cccccc" };
}

export function sideName(sideId: number): string {
  return sideMeta(sideId).name;
}

export function sideColor(sideId: number): string {
  return sideMeta(sideId).color;
}

/** 当前已注册的势力 id（升序）。 */
export function knownSideIds(): number[] {
  const ids = registry.size > 0 ? [...registry.keys()] : [0, 1];
  return ids.sort((a, b) => a - b);
}

/** 全部势力色（按 id 顺序；用于沙盘 setSideColors）。 */
export function allSideColors(): string[] {
  const ids = knownSideIds();
  const max = ids.length > 0 ? Math.max(...ids) : 1;
  const out: string[] = [];
  for (let i = 0; i <= max; i++) out.push(sideColor(i));
  return out;
}

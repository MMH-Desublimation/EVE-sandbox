/**
 * 确定性基础设施（交接文档 §6.4）。
 *
 * 铁律：
 *  - 单位 id **确定性派生**，重放后不变（禁止全局自增 —— 上一版击毁记录错乱的根因）。
 *  - 随机数**不保存状态**，一律由 (unitId, 事件类型, tickIndex) 派生。
 *    因此"某单位多掷一次骰子"不会错位其他单位的随机序列。
 *  - 状态本身是**纯数据**（可 structuredClone），不含函数/句柄 —— 这让快照与重放变得平凡。
 */

import { fnv1a32, mix32, mulberry32 } from "../shared/hash.ts";

export { fnv1a32, mix32, mulberry32 };

/**
 * 确定性单位 id。
 *
 * 文档写作 `hash(sideId, fleetId, wingId, squadId, index)`；此处采用**可读且单射**的
 * 派生形式（便于调试），仍是完全确定的派生，重放后不变。
 * 末位附 6 位十六进制哈希，用于防御性地避免人工拼装 id 时的意外重复。
 */
export function makeUnitId(
  sideId: number,
  fleetId: number,
  wingId: number,
  squadId: number,
  index: number,
): string {
  const tail = mix32(sideId, fleetId, wingId, squadId, index).toString(16).padStart(8, "0").slice(0, 6);
  return `S${sideId}F${fleetId}W${wingId}Q${squadId}U${index}-${tail}`;
}

/** 事件类型（用于派生互不干扰的随机子流）。 */
export type RngEvent =
  | "turretHit" | "missileHit" | "droneHit" | "ecm" | "ewar"
  | "logiDelay" | "wreck" | "misc";

/**
 * 每单位、每事件类型、每 tick 独立的随机子流。
 * 无内部可变状态 —— 同 (unitId, event, tick) 必然得到同一序列。
 */
export class Rng {
  #next: () => number;

  constructor(unitId: string, event: RngEvent, tick: number, salt = 0) {
    const seed = mix32(fnv1a32(unitId), fnv1a32(event), tick, salt);
    this.#next = mulberry32(seed);
  }

  /** [0, 1) */
  next(): number {
    return this.#next();
  }

  /** 以概率 p 返回 true。 */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.#next() < p;
  }

  /** [min, max) */
  range(min: number, max: number): number {
    return min + (max - min) * this.#next();
  }
}

/** 对确定性的可读性断言：同一输入必须得到同一 id。 */
export function assertDeterministicUnitIds(): void {
  const a = makeUnitId(0, 1, 2, 3, 4);
  const b = makeUnitId(0, 1, 2, 3, 4);
  if (a !== b) throw new Error("makeUnitId 非确定性");
}

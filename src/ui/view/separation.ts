/**
 * 图标碰撞体积：沙盘上的舰船图标**可以短暂重叠**，但重叠持续一段时间后
 * 应当**自动移动到最近的非重叠位置**。
 *
 * 实现要点（务必守住 §3.1 单向依赖铁律）：
 *  · 这是**纯显示层**的偏移量（offset），**绝不修改引擎坐标**；
 *    引擎位置仍然是唯一真源，显示位置 = 引擎位置 + 分离偏移；
 *  · **允许短暂重叠**：重叠要持续 `DELAY_MS` 才开始推挤（1~3 秒窗内）；
 *  · 分离是**移动**而非瞬移：偏移量的变化速度有上限；
 *  · 不再重叠后偏移按指数衰减回 0，图标回到真实位置（避免长期漂移）；
 *  · 全程无随机数、遍历顺序固定 → 同一局面逐帧可复现。
 */
import type { UnitFrame } from "../protocol.ts";

/** 允许短暂重叠的时长（ms）。1~3 秒窗内取中值。 */
const DELAY_MS = 1500;
/** 分离移动的速度上限（屏幕 px/s）。 */
const MAX_SPEED_PX_PER_S = 90;
/** 偏移上限 = 该倍数 × 该单位的图标半径（防止被推得离谱）。 */
const MAX_OFFSET_FACTOR = 3.5;
/** 不再重叠后归位的指数时间常数（ms）。 */
const DECAY_TAU_MS = 420;
/** 相对推力：重叠深度 × 该系数作为推挤强度。 */
const PUSH_GAIN = 1.35;

interface Entry {
  /** 当前显示偏移（米）。 */
  ox: number;
  oy: number;
  /** 重叠已持续的毫秒数。 */
  overlapMs: number;
  /** 是否已进入"推挤"状态（锁存，避免边界抖动）。 */
  pushing: boolean;
}

export interface Offset {
  ox: number;
  oy: number;
}

const ZERO: Offset = { ox: 0, oy: 0 };

export class IconSeparation {
  #entries = new Map<string, Entry>();
  /** 上一帧已算好的偏移，供渲染与拾取读取。 */
  #out = new Map<string, Offset>();

  reset(): void {
    this.#entries.clear();
    this.#out.clear();
  }

  /** 当前是否存在非零偏移（用于"非最大缩放时归零"的快速判断）。 */
  get active(): boolean {
    return this.#out.size > 0;
  }

  /** 本帧的显示偏移（米）。未知单位返回零偏移。 */
  offsetOf(id: string): Offset {
    return this.#out.get(id) ?? ZERO;
  }

  /**
   * 推进一步。
   *
   * @param units  本帧单位（用**引擎真实坐标**）
   * @param scale  像素/米
   * @param dtMs   距上一帧的毫秒数
   * @param halfPx 取某单位的图标半宽（屏幕 px）
   */
  update(
    units: readonly UnitFrame[],
    scale: number,
    dtMs: number,
    halfPx: (u: UnitFrame) => number,
  ): void {
    const dt = Math.min(120, Math.max(1, dtMs));
    const alive = units.filter((u) => u.alive && !u.evac);
    if (alive.length === 0) {
      this.reset();
      return;
    }

    // 半径（米）：图标半宽 ÷ 缩放。scale 极小（拉远）时半径会变得巨大，
    // 那时图标本就挤在一起、分离没有意义 → 设上限以免数值爆掉。
    const radius = new Map<string, number>();
    const display = new Map<string, { x: number; y: number }>();
    for (const u of alive) {
      const rPx = Math.max(4, halfPx(u));
      const rM = Math.min(60_000, rPx / Math.max(1e-12, scale));
      radius.set(u.id, rM);
      const e = this.#entries.get(u.id);
      display.set(u.id, { x: u.x + (e?.ox ?? 0), y: u.y + (e?.oy ?? 0) });
    }

    // 只对"显示位置可能互相影响"的单位做重叠检测：用均匀网格做邻域筛选。
    let maxR = 0;
    for (const r of radius.values()) maxR = Math.max(maxR, r);
    const cell = Math.max(1, maxR * 2);
    const grid = new Map<string, string[]>();
    const keyOf = (x: number, y: number, cellSize: number) =>
      `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;

    const push = new Map<string, { x: number; y: number; overlapping: boolean }>();
    for (const u of alive) push.set(u.id, { x: 0, y: 0, overlapping: false });

    // 用较粗的网格（按最大半径）保证任意重叠对都落在 3×3 邻域内
    for (const u of alive) {
      const p = display.get(u.id)!;
      const k = keyOf(p.x, p.y, cell);
      const arr = grid.get(k);
      if (arr) arr.push(u.id);
      else grid.set(k, [u.id]);
    }

    // ★ V0.8：**每帧配对预算**。网格按"最大半径"定格 —— 单位一多、或视野一拉远，
    //   半径/格都会变大，几百个单位会全挤进同一格 → 配对退化成 O(n²)，
    //   每帧几十万次 hypot 直接把界面拖死（用户实测："点启用开火就卡死"）。
    //   分离只是显示层的锦上添花：超预算就本帧不再推挤，下一帧继续，绝不让它拖死 UI。
    const PAIR_BUDGET = 20_000;
    let budget = PAIR_BUDGET;

    outer:
    for (const u of alive) {
      const pu = display.get(u.id)!;
      const ru = radius.get(u.id)!;
      const gx = Math.floor(pu.x / cell);
      const gy = Math.floor(pu.y / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(`${gx + dx}:${gy + dy}`);
          if (!bucket) continue;
          for (const otherId of bucket) {
            if (budget-- <= 0) break outer;
            if (otherId <= u.id) continue; // 每对只处理一次
            const ov = display.get(otherId)!;
            const ro = radius.get(otherId)!;
            const need = ru + ro;
            let vx = ov.x - pu.x;
            let vy = ov.y - pu.y;
            let d = Math.hypot(vx, vy);
            if (d >= need) continue;
            if (d < 1e-6) {
              // 完全重合：按 id 顺序给一个确定性的错开方向（不用随机数）
              const a = (u.id.length % 7) * 0.9;
              vx = Math.cos(a);
              vy = Math.sin(a);
              d = 1;
            }
            const nx = vx / d;
            const ny = vy / d;
            const depth = need - Math.max(0, Math.hypot(ov.x - pu.x, ov.y - pu.y));
            const f = depth * PUSH_GAIN * 0.5;
            const a1 = push.get(u.id)!;
            a1.overlapping = true;
            a1.x -= nx * f;
            a1.y -= ny * f;
            const a2 = push.get(otherId)!;
            a2.overlapping = true;
            a2.x += nx * f;
            a2.y += ny * f;
          }
        }
      }
    }

    // 逐单位推进偏移
    const speed = (MAX_SPEED_PX_PER_S / Math.max(1e-12, scale)) * (dt / 1000);
    const decay = Math.exp(-dt / DECAY_TAU_MS);
    this.#out.clear();

    for (const u of alive) {
      let e = this.#entries.get(u.id);
      if (!e) {
        e = { ox: 0, oy: 0, overlapMs: 0, pushing: false };
        this.#entries.set(u.id, e);
      }
      const info = push.get(u.id)!;
      const r = radius.get(u.id)!;

      if (info.overlapping) e.overlapMs += dt;
      else {
        e.overlapMs = 0;
        e.pushing = false;
      }
      // 允许短暂重叠：持续超过 DELAY_MS 才开始推挤
      if (e.overlapMs >= DELAY_MS) e.pushing = true;

      if (e.pushing && info.overlapping) {
        // 朝"解除重叠"的方向移动，速度受限
        const mag = Math.hypot(info.x, info.y);
        if (mag > 1e-9) {
          const step = Math.min(mag, speed);
          e.ox += (info.x / mag) * step;
          e.oy += (info.y / mag) * step;
        }
      } else if (!info.overlapping) {
        // 已不重叠 → 平滑归位到真实位置
        e.ox *= decay;
        e.oy *= decay;
        if (Math.abs(e.ox) < 1) e.ox = 0;
        if (Math.abs(e.oy) < 1) e.oy = 0;
      }

      // 偏移上限（相对自身图标尺寸）
      const maxOff = r * MAX_OFFSET_FACTOR;
      const offMag = Math.hypot(e.ox, e.oy);
      if (offMag > maxOff && offMag > 1e-9) {
        e.ox = (e.ox / offMag) * maxOff;
        e.oy = (e.oy / offMag) * maxOff;
      }

      this.#out.set(u.id, { ox: e.ox, oy: e.oy });
    }

    // 清理已消失的单位
    if (this.#entries.size > alive.length * 2 + 16) {
      const live = new Set(alive.map((u) => u.id));
      for (const id of [...this.#entries.keys()]) if (!live.has(id)) this.#entries.delete(id);
    }
  }
}

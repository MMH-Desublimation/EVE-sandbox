/**
 * 入场编队：**密集圆形（球面投影）阵列**。
 *
 * 需求：任何入场——推演开始、跃迁落地、旗舰跳落地、星门增援抵达——
 * 都应当形成一个密集的圆形阵列，而**不是方阵**。
 *
 * 采用 Vogel 向日葵模型（r = R·√(i/n)，θ = i·黄金角）：
 * 点在圆内密度均匀，视觉上最接近"密集圆球"；且是 O(n) 纯函数，
 * 给定同样的输入必然得到同样的坐标 → 满足确定性要求（D-11）。
 */
import type { Vec2 } from "./state.ts";

/** 黄金角：让相邻点既不过近也不过远（向日葵排布）。 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** 编队名义间距（m）：决定入场圆阵的大小与密度。全项目共用同一个值。 */
export const FORMATION_SPACING = 6_000;

/**
 * 密集圆阵的半径。
 *
 * 圆盘内均匀分布时每点占 π R²/n 面积；令其 ≈ 0.85·spacing²（略密于方阵的
 * spacing²，体现"密集"），得 R ≈ 0.52·spacing·√n。
 */
export function blobRadius(count: number, spacing: number): number {
  if (count <= 1) return 0;
  return spacing * 0.52 * Math.sqrt(count);
}

/**
 * 生成以 `center` 为中心的密集圆形编队坐标。
 *
 * @param count   单位数
 * @param spacing 名义间距（m）：同时决定圆的大小（越小越密）
 * @param center  阵列中心
 * @param phase   相位偏移（弧度）：让不同波次/来源的编队错开，避免完全重叠
 */
export function blobFormation(count: number, spacing: number, center: Vec2, phase = 0): Vec2[] {
  if (count <= 0) return [];
  if (count === 1) return [{ x: center.x, y: center.y }];
  const R = blobRadius(count, spacing);
  const out: Vec2[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const r = R * Math.sqrt((i + 0.5) / count);
    const a = i * GOLDEN_ANGLE + phase;
    out[i] = { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
  }
  return out;
}

/**
 * 编队圆内两点间的**最小间距**（用于自检与调参）。
 * 密集圆阵不应出现"点重合"，且最小间距应随 spacing 线性缩放。
 */
export function minPairDistance(points: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      const d = Math.hypot(dx, dy);
      if (d < best) best = d;
    }
  }
  return best;
}

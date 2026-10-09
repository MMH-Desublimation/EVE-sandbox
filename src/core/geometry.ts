/**
 * 几何与机动（交接文档 §6.6、§8、§9）。
 *
 * 边界：**几何自己写，叠加交给 PYFA**。
 * 本文件只做「距离 / 角速度 / 移动 / 起跳对齐 / 跃迁推进」——
 * 全部是纯几何，公开、稳定、可测。
 */
import type { Unit, Vec2 } from "./state.ts";
import { isTargetable } from "./state.ts";

/** 1 天文单位（米）。 */
export const AU_METERS = 149_597_870_000;

export const vec = {
  add: (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k }),
  len: (a: Vec2): number => Math.hypot(a.x, a.y),
  dist: (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y),
  norm: (a: Vec2): Vec2 => {
    const l = Math.hypot(a.x, a.y);
    return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
  },
  /** 逆时针 90°。 */
  perp: (a: Vec2): Vec2 => ({ x: -a.y, y: a.x }),
};

export interface UnitLookup {
  get(id: string | null | undefined): Unit | undefined;
}

export function rangeTo(a: Unit, b: Unit): number {
  return vec.dist(a.pos, b.pos);
}

/**
 * 角速度（rad/s）：目标相对观察者的**横向速度**除以距离。
 * 与 EVE 的 tracking 判定口径一致（transversal / distance）。
 */
export function angularVelocity(observer: Unit, target: Unit): number {
  const rel = vec.sub(target.vel, observer.vel);
  const r = vec.sub(target.pos, observer.pos);
  const d = vec.len(r);
  if (d < 1) return 0;
  const rHat = vec.scale(r, 1 / d);
  const along = rel.x * rHat.x + rel.y * rHat.y;
  const transverse = { x: rel.x - along * rHat.x, y: rel.y - along * rHat.y };
  return vec.len(transverse) / d;
}

/* -------------------------------------------------------------------------- */
/* 投影效果（网 / 标记 / 扰断）—— 依赖他单位，无法进 stateBitmap，故由引擎施加     */
/* -------------------------------------------------------------------------- */

/** 速度倍率（网）。multiple webs 乘算。 */
export function speedMultiplier(u: Unit): number {
  let m = 1;
  for (const e of u.effects) {
    if (e.kind === "web") m *= Math.max(0.01, 1 - e.amount / 100);
  }
  return m;
}

/** 信号半径倍率（标记）。 */
export function sigMultiplier(u: Unit): number {
  let m = 1;
  for (const e of u.effects) {
    if (e.kind === "painter") m *= 1 + e.amount / 100;
  }
  return m;
}

/** 追踪倍率（追踪干扰）。 */
export function trackingMultiplier(u: Unit): number {
  let m = 1;
  for (const e of u.effects) {
    if (e.kind === "trackDisrupt") m *= Math.max(0.01, 1 + e.amount / 100);
  }
  return m;
}

/** 锁定距离倍率（感应阻扰）。 */
export function lockRangeMultiplier(u: Unit): number {
  let m = 1;
  for (const e of u.effects) {
    if (e.kind === "damp") m *= Math.max(0.01, 1 + e.amount / 100);
  }
  return m;
}

export function effectiveMaxVelocity(u: Unit): number {
  return Math.max(0, u.maxVelocity * speedMultiplier(u));
}

export function effectiveSignatureRadius(u: Unit): number {
  return Math.max(1, u.stats.attrs.nav.signatureRadius * sigMultiplier(u));
}

/* -------------------------------------------------------------------------- */
/* 移动                                                                        */
/* -------------------------------------------------------------------------- */

function resolveOrderTarget(u: Unit, lookup: UnitLookup): Unit | null {
  const t = lookup.get(u.order.targetId ?? null);
  return t && isTargetable(t) ? t : null;
}

/** 由机动指令得出期望速度向量；null 表示"不动"。 */
export function desiredVelocity(u: Unit, lookup: UnitLookup): Vec2 | null {
  const vmax = effectiveMaxVelocity(u);
  if (vmax <= 0) return null;

  const target = resolveOrderTarget(u, lookup);
  switch (u.order.type) {
    case "hold":
    case "stop":
      return { x: 0, y: 0 };
    case "align":
      // 对齐：仅朝向，不位移（起跳准备）
      return { x: 0, y: 0 };
    case "approach": {
      const dest = target ? target.pos : u.order.to;
      if (!dest) return { x: 0, y: 0 };
      return vec.scale(vec.norm(vec.sub(dest, u.pos)), vmax);
    }
    case "orbit": {
      if (!target) return { x: 0, y: 0 };
      const r = Math.max(1, u.order.range ?? Math.min(5000, vmax));
      const radial = vec.sub(target.pos, u.pos);
      const d = Math.max(1, vec.len(radial));
      const rHat = vec.scale(radial, 1 / d);
      const tangential = vec.perp(rHat);
      // 径向修正：距离偏差越大，越倾向径向
      const err = Math.max(-1, Math.min(1, (d - r) / r));
      const dir = vec.norm(vec.add(tangential, vec.scale(rHat, err * 1.5)));
      return vec.scale(dir, vmax);
    }
    case "keepAtRange": {
      if (!target) return { x: 0, y: 0 };
      const r = Math.max(1, u.order.range ?? 10_000);
      const radial = vec.sub(target.pos, u.pos);
      const d = Math.max(1, vec.len(radial));
      if (Math.abs(d - r) < Math.max(50, r * 0.02)) {
        // 已在容差内：跟随目标速度（保持相对静止）
        return target.vel;
      }
      const dir = vec.scale(radial, (d > r ? 1 : -1) / d);
      return vec.scale(dir, vmax);
    }
    case "mjd":
    case "warpOut":
      return { x: 0, y: 0 };
    default:
      return { x: 0, y: 0 };
  }
}

/**
 * 单 tick 移动结算。
 *
 * 简化模型：以 `maxVel / alignTime` 作为加速度上限，速度向量逐步逼近期望速度。
 * 与 EVE 的"加速度受限 + 对齐时间"行为定性一致，且完全确定。
 */
export function stepMovement(u: Unit, lookup: UnitLookup, dtSeconds: number): void {
  const desired = desiredVelocity(u, lookup);
  if (!desired) return;
  const vmax = effectiveMaxVelocity(u);
  const align = u.alignTime > 0 ? u.alignTime : 1;
  const accel = 10 * (vmax / align); // 加速裕度：10 倍，避免长舰过慢收敛
  const dv = vec.sub(desired, u.vel);
  const dvLen = vec.len(dv);
  if (dvLen <= accel * dtSeconds) {
    u.vel = desired;
  } else {
    u.vel = vec.add(u.vel, vec.scale(dv, (accel * dtSeconds) / dvLen));
  }
  u.pos = vec.add(u.pos, vec.scale(u.vel, dtSeconds));
}

/**
 * 起跳对齐时间（秒）：-ln(0.25)·mass·agility/1e6。
 * 与 StatOracle 的 alignTime 字段一致（此处保留本地公式，便于 mass 变化时重算）。
 */
export function alignSeconds(mass: number, agility: number): number {
  return (Math.log(4) * mass * agility) / 1e6;
}

/**
 * 跃迁旅行时间（秒）。
 * 简化：对齐时间 + 距离 / 跃迁速度。EVE 真实曲线非线性，但本软件只关心"何时到达"。
 */
export function warpTravelSeconds(distanceM: number, warpSpeedMultiplier: number): number {
  const auPerSec = Math.max(0.1, warpSpeedMultiplier);
  return distanceM / (auPerSec * AU_METERS);
}

/** 微跃迁（MJD）：朝当前朝向瞬移 100km。 */
export const MJD_DISTANCE = 100_000;

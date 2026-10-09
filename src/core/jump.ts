/**
 * 旗舰跳（交接文档 §9.1「旗舰跳能力」、D-31「区分旗舰跳能力」）。
 *
 * 关键语义，务必区分两件事：
 *   · **具备旗舰跳**（capability）—— 船本身有跳跃引擎，来自 SDE 的 `jumpDriveRange`；
 *   · **允许旗舰跳**（permission）—— 在"具备"的前提下，还要过反跳/冷却/场景开关的判定。
 * 用户要的"判定允许进行旗舰跳情况下"就是后者。
 *
 * 允许条件（按 EVE 行为简化）：
 *   1. 船有跳跃引擎；
 *   2. 存活、未撤离、未在跃迁中；
 *   3. 冷却已过；
 *   4. **未被反跳**（warp scramble / 拦截泡）—— E11 里最关键的战术杠杆：
 *      想拦住旗舰撤场，就必须先把它点住；
 *   5. 场景未关闭旗舰跳。
 */
import type { ActiveEffect, BattleState, Unit, Vec2 } from "./state.ts";

/** 是否具备旗舰跳能力。 */
export function hasJumpDrive(u: Unit): boolean {
  return u.jump !== null;
}

/** 是否被反跳（敌方 web 之外的硬控：warp scramble / 拦截泡）。 */
export function isScrambled(state: BattleState, u: Unit): boolean {
  for (const e of u.effects) {
    if (e.untilTick < state.tick) continue;
    if (e.kind === "warpScramble" || e.kind === "bubble") return true;
  }
  return false;
}

/**
 * **跃迁稳定系数**（基值，≥ 1）。
 *
 * 来自 SDE 的 `warpCoreStability`（PYFA 已含舰船技能加成，例如夜神级超级航母
 * 1 + 5×技能等级 = 26）。属性缺失/为 0 时按 **1** 处理 —— 这样"一个扰频或扰断
 * 就能拦住普通舰船"，与 EVE 一致。
 */
export function warpCoreStabilityOf(u: Unit): number {
  const raw = u.stats?.attrs?.nav?.warpCoreStability;
  const v = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  return Math.max(1, v);
}

export interface WarpVerdict {
  ok: boolean;
  reason: string;
  /** 有效跃迁稳定系数（基值 − 干扰点数），供 UI 展示。 */
  effective: number;
}

/**
 * 是否**允许跃迁**（普通跃迁「跃迁至」，与旗舰跳许可同源判定）。
 *
 * 规则（按 EVE 简化，用户明确要求）：
 *   1. 拦截力场 / 反跳探针（`bubble`）→ **直接禁止**（稳定系数再高也没用）；
 *   2. 跃迁扰频（warpScramble，-2）/ 跃迁扰断（warpDisrupt，-1）→ **扣**稳定系数；
 *   3. 有效稳定系数 **≥ 1** 才允许。
 * 例：夜神级基值 26，被一个扰频（-2）后为 24 ≥ 1 → 仍可跃迁。
 */
export function warpAllowed(state: BattleState, u: Unit): WarpVerdict {
  const base = warpCoreStabilityOf(u);
  if (!u.alive) return { ok: false, reason: "已阵亡", effective: base };
  if (u.evacuated) return { ok: false, reason: "已撤离战场", effective: base };
  if (u.arrivalDelayMs > 0) return { ok: false, reason: "尚未进场（过门延迟中）", effective: base };
  if (u.warpingOut) return { ok: false, reason: "正在跃迁中", effective: base };

  let stab = base;
  for (const e of u.effects) {
    if (e.untilTick < state.tick) continue;
    if (e.kind === "bubble") {
      return { ok: false, reason: "处于拦截力场 / 反跳探针内，禁止跃迁", effective: stab };
    }
    if (e.kind === "warpScramble") stab -= swayPoints(e, 2);
    else if (e.kind === "warpDisrupt") stab -= swayPoints(e, 1);
  }
  if (stab < 1) {
    return { ok: false, reason: `跃迁稳定系数 ${stab} < 1（被跃迁干扰）`, effective: stab };
  }
  return { ok: true, reason: "", effective: stab };
}

/** 干扰点数：优先用效果强度（扰频 2 / 扰断 1），异常时按 kind 的默认值。 */
function swayPoints(e: ActiveEffect, fallback: number): number {
  const v = typeof e.amount === "number" && Number.isFinite(e.amount) && e.amount > 0
    ? Math.round(e.amount)
    : fallback;
  return v;
}

export interface JumpVerdict {
  ok: boolean;
  /** 不允许时的原因（供 UI 悬停/日志展示，避免"点了没反应"）。 */
  reason: string;
}

/** 是否**允许**旗舰跳（能力 + 反跳 + 冷却 + 场景开关）。 */
export function jumpAllowed(state: BattleState, u: Unit): JumpVerdict {
  if (!u.jump) return { ok: false, reason: "该舰不具备旗舰跳能力" };
  if (!u.alive) return { ok: false, reason: "已阵亡" };
  if (u.evacuated) return { ok: false, reason: "已撤离战场" };
  if (u.warpingOut) return { ok: false, reason: "正在跃迁，无法旗舰跳" };
  if (u.jump.remainingMs > 0) {
    return { ok: false, reason: `旗舰跳冷却中（${Math.ceil(u.jump.remainingMs / 1000)}s）` };
  }
  if (state.settings.jumpBlockedWhenScrambled && isScrambled(state, u)) {
    return { ok: false, reason: "被反跳（warp scramble / 拦截泡），禁止旗舰跳" };
  }
  if (!u.jump.allowed) return { ok: false, reason: "场景未允许旗舰跳" };
  return { ok: true, reason: "" };
}

/** 目标点是否在跳跃距离内。 */
export function jumpInRange(u: Unit, to: Vec2): boolean {
  if (!u.jump) return false;
  return Math.hypot(to.x - u.pos.x, to.y - u.pos.y) <= u.jump.rangeM + 1e-6;
}

/**
 * 执行一次旗舰跳：瞬移到目标点（EVE 的旗舰跳是"跳跃"而非"飞行"），
 * 并进入冷却、累加疲劳。
 */
export function performJump(state: BattleState, u: Unit, to: Vec2): JumpVerdict {
  const verdict = jumpAllowed(state, u);
  if (!verdict.ok) return verdict;
  if (!jumpInRange(u, to)) {
    // 跳跃引擎的射程以光年计（SDE jumpDriveRange），战场网格内几乎总在射程内 ——
    // 真正拦住旗舰跳的是反跳、冷却与疲劳，不是距离。
    return { ok: false, reason: `超出旗舰跳距离（上限 ${u.jump!.rangeLy} 光年）` };
  }
  const s = state.settings;
  u.pos = { x: to.x, y: to.y };
  u.vel = { x: 0, y: 0 };
  u.jump!.cooldownMs = Math.min(
    s.jumpFatigueMaxMs,
    u.jump!.cooldownMs + s.jumpCooldownMs + s.jumpFatigueIncrementMs,
  );
  u.jump!.remainingMs = u.jump!.cooldownMs;
  // 跳跃后重新起跳对齐（跃迁/机动都需要重新对齐）
  u.order = { type: "hold" };
  u.targetId = null;
  u.locked = false;
  return { ok: true, reason: "" };
}

/** 每 tick 递减旗舰跳冷却。 */
export function tickJumpCooldown(u: Unit, dtMs: number): void {
  if (u.jump && u.jump.remainingMs > 0) {
    u.jump.remainingMs = Math.max(0, u.jump.remainingMs - dtMs);
  }
}

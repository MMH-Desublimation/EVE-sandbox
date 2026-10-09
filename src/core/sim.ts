/**
 * 引擎主循环（交接文档 §6.1 ~ §6.3）。
 *
 * ★ tick 内阶段顺序**集中定义在本文件顶部**，是全沙盒的"物理法则"。
 *   文档 §6.3 给出的是待验证草案；本实现做了两处**显式标注的补充**：
 *     - 新增 `targeting`（锁定推进）。文档把"锁定时间影响开火时刻"列为必须建模（§9.1），
 *       但草案阶段表没有它的位置，故单列一阶段。
 *     - 新增 `ewar`（投影电子战：网/标记/扰断/阻扰）。文档 §6.3 的草案只列了"毁电/吸电"。
 *   改动只在这一处，日后发现与 EVE 对不上，**只改这里**。
 *
 * 时间模型：固定 1 秒 tick；tickIndex 为整数；状态变化只在 tick 边界发生。
 */
import {
  applyDamageToGroup, applyDamageToUnit, droneChance, droneVolleyOf, fighterShotAt,
  rangeFactor, resolveMissileShot, resolveTurretShot, scaleDmg, totalDmg,
} from "./combat.ts";
import { findGroup, groupAlive, groupKindLabel, groupProxy, resolveTarget } from "./targeting.ts";
import type { GroupKind, GroupLike } from "./targeting.ts";
import type { DamageTypes } from "./combat.ts";
import { stepMovement, warpTravelSeconds, vec, effectiveMaxVelocity } from "./geometry.ts";
import type { UnitLookup } from "./geometry.ts";
import { performJump, tickJumpCooldown, warpAllowed } from "./jump.ts";
import type {
  ActiveEffect, BattleEvent, BattleState, FighterSquadron, TargetKind, Unit, Vec2,
} from "./state.ts";
import { isTargetable } from "./state.ts";

/** ★ 沙盒的"物理法则"。 */
export const DEFAULT_PHASE_ORDER: readonly string[] = [
  "commands",
  "targeting",
  "capRecharge",
  "moduleCycles",
  // ★ 跳刀：必须在 moduleCycles 之后（等它把运转计时递减到 0），
  //   且在 movement / groupMovement 之前（位移后再按新位置走位，组也能跟着走）。
  "microJump",
  "capTransfer",
  "energyWarfare",
  "remoteRepair",
  "ewar",
  "weaponFire",
  "projectiles",
  // ★ 第三处显式补充：立体炸弹。
  //   必须排在 `weaponFire` **之后** —— 该阶段开头会 `pendingHits.length = 0`，
  //   排在它前面的话炸弹伤害会被清掉。
  "smartbombs",
  "damageApplication",
  "movement",
  // ★ 第四处显式补充：组（铁骑/无人机）的机动。
  //   排在 movement 之后 —— 组要追逐**这一 tick 已更新**的母舰/目标位置。
  "groupMovement",
];

export const TICK_MS = 1000;

export interface SimContext extends UnitLookup {
  /** 本 tick 生效的指令（由驱动器提供；属性重算已在其中完成）。 */
  applyCommands?: (state: BattleState) => void;
  /**
   * 环境更新（指挥脉冲按位置生效）。
   *
   * 单位进出脉冲范围时，它生效的脉冲集合会变 → 需要切换属性表。
   * 放在 `commands` 阶段（本 tick 的第一阶段）执行，
   * 使后面的所有阶段都看到**本 tick 生效的**属性。
   */
  applyEnv?: (state: BattleState) => void;
  /** 调试/诊断输出。 */
  log?: (msg: string) => void;
  /**
   * 主动装备"本轮循环走完 → 正式停用"的落地回调。
   *
   * UI 点击停用时，若该实例正在运转，引擎**不立刻**移除增益（否则与"停用中"语义不符），
   * 而是标 `pendingOff`；等本轮循环计时归零后由本回调把 `moduleStates` 改回 online
   * 并重算属性。这样"停用中"期间增益/效果持续，直到本轮结束才真正消失。
   */
  stopModuleCycle?: (state: BattleState, unit: Unit, activeIndex: number) => void;
}

/* -------------------------------------------------------------------------- */
/* 事件                                                                        */
/* -------------------------------------------------------------------------- */

export function pushEvent(state: BattleState, ev: BattleEvent): void {
  state.events.push(ev);
  if (state.events.length > state.maxEvents) state.events.splice(0, 1500);
}

/* -------------------------------------------------------------------------- */
/* 阶段 1：指令（由驱动器注入）                                                 */
/* -------------------------------------------------------------------------- */

function phaseCommands(state: BattleState, ctx: SimContext): void {
  // 先落指令，再更新环境（脉冲范围会随指令引起的移动而变）
  ctx.applyCommands?.(state);
  ctx.applyEnv?.(state);
}

/* -------------------------------------------------------------------------- */
/* 阶段 2：锁定与目标选择                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 锁定时间（**毫秒**）。
 * EVE 公式 `40000 / (扫描分辨率 × asinh(目标信号))` 给出的是**秒**，此处换算为毫秒，
 * 以便与按 tick 累积的 `lockProgressMs` 比较（曾因单位不一致导致 tick 0 即锁定）。
 */
export function lockTimeMs(scanResolution: number, targetSig: number): number {
  const res = Math.max(1, scanResolution);
  const sig = Math.max(1, targetSig);
  return (40_000 / (res * Math.asinh(sig))) * 1000;
}

function aliveEnemies(state: BattleState, u: Unit): Unit[] {
  return state.units.filter((t) => t.sideId !== u.sideId && isTargetable(t));
}

function nearestEnemy(state: BattleState, u: Unit): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const t of aliveEnemies(state, u)) {
    const d = vec.dist(u.pos, t.pos);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** 主武器射程（取已装武器的最远 optimal），用于自动接敌的 80% 判定。 */
function primaryRange(u: Unit): number {
  let best = 0;
  for (const w of u.weapons) best = Math.max(best, w.optimal);
  for (const g of u.drones) best = Math.max(best, g.optimal);
  // 铁骑：取最远能力的 optimal + falloff（航母靠铁骑接敌，射程必须算进去）
  for (const f of u.fighters) {
    for (const a of f.abilities) best = Math.max(best, a.optimal + a.falloff);
  }
  return best;
}

/** 敌方"铁骑纵队"候选（含其母舰）。 */
interface GroupCandidate {
  host: Unit;
  group: FighterSquadron;
  distance: number;
}

/**
 * 射程内的敌方**铁骑纵队**。
 *
 * ★ 规则：**无人机永不被主动选择**，所以这里只扫铁骑。
 * 另外：母舰已被击毁但其铁骑仍在空中的，**仍然可打** ——
 * 这正是"（母舰）目标被击毁后随后才攻击舰载机"的字面含义。
 */
function fighterCandidates(state: BattleState, u: Unit, maxRange: number): GroupCandidate[] {
  const out: GroupCandidate[] = [];
  for (const host of state.units) {
    if (host.sideId === u.sideId) continue;
    if (host.evacuated || host.arrivalDelayMs > 0) continue;
    for (const g of host.fighters) {
      if (!groupAlive(g)) continue;
      // ★ 按**组自己的位置**判断在不在射程内：组出仓后会飞出去环绕，
      //   离母舰可能相当远，用母舰位置判断会漏掉或误判。
      const d = vec.dist(u.pos, g.pos);
      if (d > maxRange) continue;
      out.push({ host, group: g, distance: d });
    }
  }
  return out;
}

/**
 * 选择交火目标（用户补充规则）。
 *
 * 优先级：
 *   1. **「集火舰载机」模式**：优先打**射程内**的敌方铁骑纵队；
 *   2. 普通模式（含集火舰载机的回退）：**只打单位**（舰船/建筑）——
 *      铁骑必须被显式选中、或走集火舰载机才会被攻击；
 *   3. 没有任何单位可打时，才转向敌方铁骑（例如场上只剩铁骑）；
 *   4. **无人机永不主动选择**（只被立体炸弹这类范围伤害波及）。
 */
function pickTarget(
  state: BattleState, u: Unit,
): { id: string; kind: TargetKind; groupId: string | null } | null {
  const range = primaryRange(u) || Infinity;

  if (u.doctrine === "antiFighter") {
    const f = fighterCandidates(state, u, range).sort((a, b) => a.distance - b.distance)[0];
    if (f) return { id: f.host.id, kind: "fighter", groupId: f.group.id };
  }

  let best: Unit | null = null;
  let bestD = Infinity;
  for (const t of state.units) {
    if (t.sideId === u.sideId || !isTargetable(t)) continue;
    const d = vec.dist(u.pos, t.pos);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  if (best) return { id: best.id, kind: "unit", groupId: null };

  // 场上没有可打的单位了 → 才转打铁骑
  const f2 = fighterCandidates(state, u, range).sort((a, b) => a.distance - b.distance)[0];
  if (f2) return { id: f2.host.id, kind: "fighter", groupId: f2.group.id };
  return null;
}

function phaseTargeting(state: BattleState, ctx: SimContext): void {
  const tick = state.tick;
  for (const u of state.units) {
    // 时效效果过期
    if (u.effects.length > 0) u.effects = u.effects.filter((e) => e.untilTick > tick);

    if (!u.alive || u.evacuated) {
      u.locked = false;
      u.lockProgressMs = 0;
      continue;
    }
    // ★ 跃迁中：不选目标、不锁定（跃迁期间无法交战；到达后按交火模式重新选目标）
    if (u.warpingOut) {
      u.locked = false;
      u.lockProgressMs = 0;
      continue;
    }

    // 目标有效性（可能是单位，也可能是挂载的组）
    const handle = resolveTarget((id) => ctx.get(id), u);
    const changed = () => {
      u.locked = false;
      u.lockProgressMs = 0;
    };

    // 交火方式：自由开火每次重选；其余教义仅当「用户尚未指定目标」时才自动选
    // （保持主目标，失焦才重选）。passive 教义连这也跳过 —— 完全等用户操作。
    if (u.doctrine === "free" || (u.doctrine !== "passive" && !handle)) {
      const next = pickTarget(state, u);
      const same = next && next.id === u.targetId && next.kind === u.targetKind
        && next.groupId === u.targetGroupId;
      if (next && !same) {
        u.targetId = next.id;
        u.targetKind = next.kind;
        u.targetGroupId = next.groupId;
        changed();
      } else if (!next) {
        u.targetId = null;
        u.targetKind = "unit";
        u.targetGroupId = null;
        u.locked = false;
        u.lockProgressMs = 0;
        continue;
      }
    }
    const target = ctx.get(u.targetId);
    if (!target) {
      u.locked = false;
      u.lockProgressMs = 0;
      continue;
    }
    // 目标是「组」（铁骑/无人机）时，锁定距离与信号半径都用**组自己的** ——
    // 组出仓后会飞出去环绕，它的位置往往离母舰很远。
    const groupRef = u.targetKind !== "unit" && u.targetGroupId
      ? findGroup(target, u.targetKind, u.targetGroupId)
      : undefined;

    // ★ V0.8：**走位与交火模式解耦** —— 交火模式只决定"打谁"，不再决定"走不走位"。
    //   原因：用户既要求「默认交火模式 = 自动攻击」（否则"启用开火"什么都不发生），
    //   又明确要求「舰船不要默认朝着敌人移动」。两者只能靠解耦同时满足：
    //     · 交火模式（focus/free/auto/antiFighter）→ 自动选目标、锁定、开火；
    //     · 走位 → **只由机动指令**（接近/环绕/保持距离/旗舰跳…）决定，hold 就是原地不动。

    // 锁定判定（受锁定距离与阻扰影响）
    const lockRange = u.stats.attrs.scan.maxRange * lockRangeMul(u);
    const distance = vec.dist(u.pos, groupRef ? groupRef.pos : target.pos);
    if (distance > lockRange) {
      u.locked = false;
      u.lockProgressMs = 0;
      continue;
    }
    if (u.locked) continue;
    u.lockProgressMs += TICK_MS;
    // ★ 锁的是"组"时，锁定时长按**组自己的信号半径**算 —— 铁骑/无人机又小又快，
    //   锁它们本来就比锁母舰更慢（这也是"实体"含义的一部分）。
    const need = lockTimeMs(
      u.stats.attrs.scan.resolution,
      groupRef?.signatureRadius ?? target.stats.attrs.nav.signatureRadius,
    );
    if (u.lockProgressMs >= need) {
      u.locked = true;
      pushEvent(state, { tick, type: "lock", unitId: u.id, unitName: u.name, targetId: target.id, targetName: target.name });
    }
  }
}

function lockRangeMul(u: Unit): number {
  let m = 1;
  for (const e of u.effects) if (e.kind === "damp") m *= Math.max(0.01, 1 + e.amount / 100);
  return m;
}

/* -------------------------------------------------------------------------- */
/* 阶段 3：电容回充（连续公式，tick 边界结算一次）                                */
/* -------------------------------------------------------------------------- */

/** EVE 回充公式：dC/dt = (2.5·Cmax/T)·(√f − f)，f = C/Cmax，T = 回充时间（秒）。 */
export function rechargeDelta(current: number, max: number, rechargeMs: number, dtSeconds: number): number {
  if (max <= 0 || rechargeMs <= 0) return 0;
  const f = Math.max(0, Math.min(1, current / max));
  const T = rechargeMs / 1000;
  return ((2.5 * max) / T) * (Math.sqrt(f) - f) * dtSeconds;
}

function phaseCapRecharge(state: BattleState): void {
  const dt = TICK_MS / 1000;
  for (const u of state.units) {
    if (!u.alive || u.evacuated) continue;
    if (state.settings.passiveCapRecharge) {
      u.cap = Math.max(0, Math.min(u.capMax, u.cap + rechargeDelta(u.cap, u.capMax, u.capRechargeMs, dt)));
    }
    if (state.settings.passiveShieldRegen && u.hp.shield > 0) {
      const rate = u.stats.attrs.shieldRechargeRate ?? 0;
      if (rate > 0) {
        u.hp.shield = Math.max(
          0,
          Math.min(u.maxHp.shield, u.hp.shield + rechargeDelta(u.hp.shield, u.maxHp.shield, rate, dt)),
        );
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 阶段 4：模块循环推进（计时、循环检查、待停用落地）                            */
/* -------------------------------------------------------------------------- */

/**
 * ★ 由各自阶段施加效果、自行计时的主动装备种类。
 *
 * 这些模块的 `cycleRemainingMs` 由对应 phase（传电 / 毁电 / 遥修 / 电子战 / 立体炸弹）
 * 在**施加效果的那一刻**重置，因此它们的"循环推进"不能在下面统一处理 ——
 * 若在计时归零后立刻重置，效果阶段就永远等不到 `cycleRemainingMs <= 0`，永远不生效。
 *
 * 其余主动装备（抗性硬化 / 微曲 / 指挥脉冲 / 装甲维修 / 护盾增效…）没有周期事件，
 * 由本阶段驱动循环，纯粹用于"运转状态检查"的展示。
 */
const PHASE_DRIVEN_KINDS: ReadonlySet<string> = new Set([
  "capTransfer", "neut", "nos",
  "remoteArmor", "remoteShield", "remoteHull",
  "web", "painter", "trackDisrupt", "damp", "ecm", "warpScramble", "warpDisrupt",
  "smartbomb",
  // ★ 跳刀**不是**持续型装备：跑完本轮循环 = 起跳（一次性），随后停机 + 进冷却。
  //   若留在本集合之外，phaseModuleCycles 会立刻把 cycleRemainingMs 重置回 cycleMs，
  //   表现为"永远空转却从不起跳"（用户实测报障的原现象）。
  "microJump",
]);

function phaseModuleCycles(state: BattleState, ctx: SimContext): void {
  for (const u of state.units) {
    if (!u.alive || u.evacuated) continue;
    for (const w of u.weapons) {
      if (w.cycleRemainingMs > 0) w.cycleRemainingMs -= TICK_MS;
    }
    // 本 tick 因"本轮走完"而正式停用的实例（统一处理：回调会重算属性，避免遍历中重建数组）
    const toStop: number[] = [];
    for (let ai = 0; ai < u.actives.length; ai++) {
      const a = u.actives[ai];
      if (a.reactDelayMs > 0) a.reactDelayMs -= TICK_MS;
      // 跳刀的再启动冷却：逐 tick 递减；>0 时 commands 会拒绝再次启用
      if (a.cooldownRemainingMs > 0) a.cooldownRemainingMs -= TICK_MS;
      if (!a.on) {
        a.cycleRemainingMs = 0;
        a.pendingOff = false;
        continue;
      }
      if (a.cycleRemainingMs > 0) a.cycleRemainingMs -= TICK_MS;
      if (a.cycleRemainingMs > 0) continue;
      // 本轮循环到此走完
      if (a.pendingOff) { toStop.push(ai); continue; }
      // 持续型装备：立即开始下一轮（进度条循环填充）
      if (!PHASE_DRIVEN_KINDS.has(a.kind)) a.cycleRemainingMs = a.cycleMs;
    }
    for (const ai of toStop) ctx.stopModuleCycle?.(state, u, ai);
    for (const g of u.drones) if (g.cycleRemainingMs > 0) g.cycleRemainingMs -= TICK_MS;
    for (const f of u.fighters) if (f.cycleRemainingMs > 0) f.cycleRemainingMs -= TICK_MS;
  }
}

/* -------------------------------------------------------------------------- */
/* 跳刀（微型跳跃引擎）                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 跃迁方向：**优先当前移动方向**（用户要求"朝移动方向"）。
 *
 * 本沙盘不建模舰艏朝向，因此静止时按此顺序退化：
 *   速度 → 机动指令的坐标目的地 → 当前目标 → null（本 tick 不起跳）。
 */
function microJumpDirection(state: BattleState, u: Unit): Vec2 | null {
  const speed = Math.hypot(u.vel.x, u.vel.y);
  if (speed > 1) return { x: u.vel.x / speed, y: u.vel.y / speed };
  const to = u.order.to;
  if (to) {
    const d = vec.dist(u.pos, to);
    if (d > 1) return { x: (to.x - u.pos.x) / d, y: (to.y - u.pos.y) / d };
  }
  const t = u.targetId ? state.units.find((x) => x.id === u.targetId) : undefined;
  if (t) {
    const d = vec.dist(u.pos, t.pos);
    if (d > 1) return { x: (t.pos.x - u.pos.x) / d, y: (t.pos.y - u.pos.y) / d };
  }
  return null;
}

/**
 * 跳刀：**先运转一个周期，跑完本轮才起跳**（不是传导！不是立即位移！）。
 *
 * · 运转：`duration`（大小型均为 12000 ms）走完才触发；
 * · 起跳：沿移动方向**瞬移**一段距离（普通型 100 km，旗舰型 250 km）；
 * · 收尾：立即**停机**（单次装备，不自动续接循环）并进入**再启动冷却**
 *         （`moduleReactivationDelay`，大小型 180 s）；冷却结束前不得再次启用。
 */
function phaseMicroJump(state: BattleState, ctx: SimContext): void {
  for (const u of state.units) {
    if (!u.alive || u.evacuated) continue;
    for (let ai = 0; ai < u.actives.length; ai++) {
      const a = u.actives[ai];
      if (a.kind !== "microJump" || !a.on || a.pendingOff) continue;
      // 还在运转本轮 → 等计时走完
      if (a.cycleRemainingMs > 0) continue;

      const dist = a.microJump?.distanceM ?? 100_000;
      const cooldown = Math.max(0, a.microJump?.cooldownMs ?? 0);
      const dir = microJumpDirection(state, u);
      let detail: string;
      if (dir) {
        const dx = dir.x * dist;
        const dy = dir.y * dist;
        u.pos = { x: u.pos.x + dx, y: u.pos.y + dy };
        // 组跟随母舰位移（否则要飞 100 km 才追上，视觉上像被甩掉）
        for (const g of [...u.drones, ...u.fighters]) {
          g.pos = { x: g.pos.x + dx, y: g.pos.y + dy };
        }
        detail = `跳刀跃迁 ${Math.round(dist / 1000)} km`;
      } else {
        detail = "跳刀已运转完毕，但无法判定跃迁方向（静止且无航路点/目标）";
      }

      // 冷却先写；stopModuleCycle 内部会重算属性（重建 actives 数组），
      // 而 assemble.applyStats 已保证冷却**无条件**跨重算保留，因此不会丢。
      a.cooldownRemainingMs = cooldown;
      ctx.stopModuleCycle?.(state, u, ai);
      const now = u.actives[ai];
      if (now) {
        // 单次装备：绝不残留 on=true（否则下一 tick 会再跳一次）
        now.on = false;
        now.pendingOff = false;
        now.cycleRemainingMs = 0;
        now.cooldownRemainingMs = cooldown;
      }
      if (cooldown > 0) detail += `，冷却 ${Math.round(cooldown / 1000)} s`;
      pushEvent(state, {
        tick: state.tick, type: "microJump", sideId: u.sideId,
        unitId: u.id, unitName: u.name, shipName: u.shipName, detail,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 后勤 / 传电 / 电子战                                                        */
/* -------------------------------------------------------------------------- */

function alliesOf(state: BattleState, u: Unit): Unit[] {
  return state.units.filter((t) => t.sideId === u.sideId && isTargetable(t));
}

function inRangeOf(a: Unit, b: Unit, optimal: number, falloff: number): boolean {
  return rangeFactor(vec.dist(a.pos, b.pos), optimal, falloff) > 0;
}

/** 按模块类型选择后勤/传电目标（交接文档 §9；每实例各自持有目标，B4 根因）。 */
function pickLogiTarget(
  state: BattleState, u: Unit, mod: Unit["actives"][number],
): Unit | undefined {
  if (mod.targetId) {
    const cur = state.units.find((x) => x.id === mod.targetId);
    if (cur && isTargetable(cur) && cur.id !== u.id) {
      const needNow = layerNeed(cur, mod.kind);
      if (needNow > 0.01 && inRangeOf(u, cur, mod.optimal, mod.falloff)) return cur;
    }
  }
  let best: Unit | undefined;
  let bestNeed = 0.01;
  for (const a of alliesOf(state, u)) {
    if (a.id === u.id) continue;
    if (!inRangeOf(u, a, mod.optimal, mod.falloff)) continue;
    const need = layerNeed(a, mod.kind);
    if (need > bestNeed) {
      bestNeed = need;
      best = a;
    }
  }
  return best;
}

function layerNeed(t: Unit, kind: string): number {
  const f = (cur: number, max: number) => max <= 0 ? 0 : Math.max(0, 1 - cur / max);
  switch (kind) {
    case "remoteArmor": return f(t.hp.armor, t.maxHp.armor);
    case "remoteShield": return f(t.hp.shield, t.maxHp.shield);
    case "remoteHull": return f(t.hp.hull, t.maxHp.hull);
    case "capTransfer": return f(t.cap, t.capMax);
    default: return 0;
  }
}

function phaseCapTransfer(state: BattleState): void {
  for (const u of state.units) {
    if (!u.alive || u.evacuated) continue;
    for (const a of u.actives) {
      if (a.kind !== "capTransfer" || !a.on || a.cycleRemainingMs > 0) continue;
      const amount = a.effectAmounts.powerTransferAmount ?? 0;
      if (amount <= 0) continue;
      const target = pickLogiTarget(state, u, a);
      if (!target) continue;
      if (u.cap < a.capNeed) continue;
      // ★ 来源只扣 capacitorNeed，目标获得 powerTransferAmount（不双重扣电，A10）
      u.cap -= a.capNeed;
      target.cap = Math.min(target.capMax, target.cap + amount);
      a.cycleRemainingMs = a.cycleMs;
      a.targetId = target.id;
      pushEvent(state, {
        tick: state.tick, type: "capTransfer", unitId: u.id, unitName: u.name,
        targetId: target.id, targetName: target.name, amount,
      });
    }
  }
}

function phaseEnergyWarfare(state: BattleState): void {
  for (const u of state.units) {
    if (!u.alive || u.evacuated) continue;
    for (const a of u.actives) {
      if ((a.kind !== "neut" && a.kind !== "nos") || !a.on || a.cycleRemainingMs > 0) continue;
      const target = ctxTarget(state, u, a);
      if (!target) continue;
      if (u.cap < a.capNeed) continue;
      const amount = a.effectAmounts.energyNeutralizerAmount ?? 0;
      if (amount <= 0) continue;
      u.cap -= a.capNeed;
      const drained = Math.min(target.cap, amount);
      target.cap -= drained;
      if (a.kind === "nos") u.cap = Math.min(u.capMax, u.cap + drained);
      a.cycleRemainingMs = a.cycleMs;
      a.targetId = target.id;
      pushEvent(state, {
        tick: state.tick, type: a.kind, unitId: u.id, unitName: u.name,
        targetId: target.id, targetName: target.name, amount: drained,
      });
    }
  }
}

function ctxTarget(state: BattleState, u: Unit, a: Unit["actives"][number]): Unit | undefined {
  const explicit = state.units.find((x) => x.id === a.targetId);
  if (explicit && isTargetable(explicit) && explicit.sideId !== u.sideId) return explicit;
  const t = state.units.find((x) => x.id === u.targetId);
  if (t && isTargetable(t) && inRangeOf(u, t, a.optimal, a.falloff)) return t;
  let best: Unit | undefined;
  let bestD = Infinity;
  for (const e of state.units) {
    if (e.sideId === u.sideId || !isTargetable(e)) continue;
    if (!inRangeOf(u, e, a.optimal, a.falloff)) continue;
    const d = vec.dist(u.pos, e.pos);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function phaseRemoteRepair(state: BattleState): void {
  for (const u of state.units) {
    if (!u.alive || u.evacuated) continue;
    for (const a of u.actives) {
      if (!a.on || a.cycleRemainingMs > 0) continue;
      if (a.kind !== "remoteArmor" && a.kind !== "remoteShield" && a.kind !== "remoteHull") continue;
      const target = pickLogiTarget(state, u, a);
      if (!target) continue;
      if (u.cap < a.capNeed) continue;

      let amount = 0;
      if (a.kind === "remoteArmor") amount = a.effectAmounts.armorDamageAmount ?? 0;
      else if (a.kind === "remoteShield") amount = a.effectAmounts.shieldBonus ?? 0;
      else amount = a.effectAmounts.structureDamageAmount ?? 0;
      if (amount <= 0) continue;

      u.cap -= a.capNeed;
      if (a.kind === "remoteArmor") target.hp.armor = Math.min(target.maxHp.armor, target.hp.armor + amount);
      else if (a.kind === "remoteShield") target.hp.shield = Math.min(target.maxHp.shield, target.hp.shield + amount);
      else target.hp.hull = Math.min(target.maxHp.hull, target.hp.hull + amount);

      a.cycleRemainingMs = a.cycleMs;
      a.targetId = target.id;
      pushEvent(state, {
        tick: state.tick, type: "logi", unitId: u.id, unitName: u.name,
        targetId: target.id, targetName: target.name, amount, detail: a.kind,
      });
    }
  }
}

/** 投影电子战：网 / 标记 / 追踪干扰 / 感应阻扰 / ECM。 */
function phaseEwar(state: BattleState): void {
  const tick = state.tick;
  for (const u of state.units) {
    if (!u.alive || u.evacuated) continue;
    for (const a of u.actives) {
      if (!a.on || a.cycleRemainingMs > 0) continue;
      const kindMap: Record<string, { eff: string; layer?: ActiveEffect["layer"] }> = {
        web: { eff: "web" },
        painter: { eff: "painter" },
        trackDisrupt: { eff: "trackDisrupt" },
        damp: { eff: "damp" },
        ecm: { eff: "ecm" },
        // 反跳：warpScramble（ scram，2 点）挡住**旗舰跳**；warpDisrupt 只挡普通跃迁。
        // 这是"旗舰跳撤场"能否成立的唯一战术杠杆 —— 想留住旗舰，就必须把它点住。
        warpScramble: { eff: "warpScramble" },
        warpDisrupt: { eff: "warpDisrupt" },
      };
      const spec = kindMap[a.kind];
      if (!spec) continue;
      const target = ctxTarget(state, u, a);
      if (!target) continue;
      if (u.cap < a.capNeed) continue;

      let amount = 0;
      if (spec.eff === "web") amount = Math.abs(a.effectAmounts.speedFactor ?? 0);
      else if (spec.eff === "painter") amount = Math.abs(a.effectAmounts.signatureRadiusBonus ?? 0);
      else if (spec.eff === "trackDisrupt") amount = Math.abs(a.effectAmounts.trackingSpeedBonus ?? 0);
      else if (spec.eff === "damp") amount = Math.abs(a.effectAmounts.scanResolutionBonus ?? 0);
      // ★ 跃迁干扰的"点数"：优先用装备的 warpScrambleStrength（扰频 2 / 扰断 1），
      //   缺值时按 kind 兜底 —— 跃迁许可判定要用它扣"跃迁稳定系数"。
      else if (spec.eff === "warpScramble" || spec.eff === "warpDisrupt") {
        const s = Math.abs(
          a.effectAmounts.warpScrambleStrength
          ?? a.effectAmounts.warpScrambling
          ?? a.effectAmounts.warpDisruptionStrength
          ?? 0,
        );
        amount = s > 0 ? s : (spec.eff === "warpScramble" ? 2 : 1);
      } else amount = 1;
      if (amount <= 0) continue;

      u.cap -= a.capNeed;
      // 持续时间：无 duration 的投影装备按循环时间 ×2 计
      const durMs = a.cycleMs * 2;
      target.effects = target.effects.filter((e) => !(e.kind === spec.eff && e.sourceId === u.id));
      target.effects.push({
        kind: spec.eff,
        sourceId: u.id,
        untilTick: tick + Math.ceil(durMs / TICK_MS),
        amount,
        ...(spec.layer ? { layer: spec.layer } : {}),
      });
      if (spec.eff === "ecm") {
        target.locked = false;
        target.lockProgressMs = 0;
      }
      a.cycleRemainingMs = a.cycleMs;
      a.targetId = target.id;
      pushEvent(state, {
        tick, type: "ewar", unitId: u.id, unitName: u.name,
        targetId: target.id, targetName: target.name, amount, detail: spec.eff,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 阶段：武器开火                                                              */
/* -------------------------------------------------------------------------- */

interface PendingHit {
  /** 开火方。 */
  attacker: Unit;
  /** 位置与归属的基准（打"组"时是母舰）。 */
  target: Unit;
  dmg: DamageTypes;
  weaponName: string;
  kind: "turret" | "missile" | "drone" | "smartbomb";
  hit: boolean;
  /** 命中"组"时：伤害落到组的血池，而不是母舰本体。 */
  groupId?: string;
  groupKind?: GroupKind;
}

function phaseWeaponFire(state: BattleState, ctx: SimContext): void {
  const tick = state.tick;
  const verbose = state.settings.verboseEvents;
  pendingHits.length = 0;
  for (const u of state.units) {
    if (!u.alive || u.evacuated || !u.locked || u.warpingOut) continue;
    // ★ 交火目标可能是"单位"，也可能是它挂载的铁骑纵队 / 无人机组。
    //   打组时用一个"替身"作为目标：位置沿用母舰，信号半径与速度换成组自己的，
    //   于是下面所有命中/应用率公式**原样可用**。
    const handle = resolveTarget((id) => ctx.get(id), u);
    if (!handle) continue;
    const target = handle.kind === "unit" ? handle.host : groupProxy(handle);
    const gid = handle.kind === "unit" ? undefined : handle.group?.id;
    const gkind: GroupKind | undefined = handle.kind === "unit" ? undefined : handle.kind;

    for (const w of u.weapons) {
      if (!w.on || w.cycleRemainingMs > 0) continue;
      if (w.capNeed > 0 && u.cap < w.capNeed) continue;
      if (w.capNeed > 0) u.cap -= w.capNeed;

      if (w.kind === "launcher") {
        const shot = resolveMissileShot(w, u, target, state.mode, tick);
        w.cycleRemainingMs = w.rofMs;
        if (verbose) {
          pushEvent(state, {
            tick, type: "fire", unitId: u.id, unitName: u.name, shipName: u.shipName,
            targetId: target.id, targetName: target.name, detail: w.name,
          });
        }
        if (!shot.inRange) continue;
        if (totalDmg(shot.dmg) <= 0) {
          if (verbose) pushEvent(state, { tick, type: "miss", unitId: u.id, targetId: target.id, detail: w.name });
          continue;
        }
        const arriveTick = tick + Math.max(1, Math.round(shot.flightSeconds));
        state.projectiles.push({
          id: `p:${w.id}:${u.id}:${tick}`,
          ownerUnitId: u.id,
          weaponId: w.id,
          targetUnitId: target.id,
          targetGroupId: gid ?? null,
          targetGroupKind: gkind ?? null,
          launchTick: tick,
          arriveTick,
          dmg: shot.dmg,
          canBeIntercepted: true,
          status: "inFlight",
        });
        continue;
      }

      const shot = resolveTurretShot(w, u, target, state.mode, tick);
      w.cycleRemainingMs = w.rofMs;
      if (verbose) {
        pushEvent(state, {
          tick, type: "fire", unitId: u.id, unitName: u.name, shipName: u.shipName,
          targetId: target.id, targetName: target.name, detail: w.name,
        });
      }
      if (totalDmg(shot.dmg) <= 0) {
        if (verbose) pushEvent(state, { tick, type: "miss", unitId: u.id, targetId: target.id, detail: w.name });
        continue;
      }
      pendingHits.push({
        attacker: u, target, dmg: shot.dmg, weaponName: w.name, kind: "turret", hit: true,
        ...(gid ? { groupId: gid, groupKind: gkind } : {}),
      });
    }

    // 组有自己的位置：射程与角速度一律用**组的坐标**（用户规则：出仓后自主环绕）。
    // 复用同一个替身对象，避免每组每 tick 分配一次。
    const at = { ...u } as Unit;

    // 无人机（按组结算）
    for (const g of u.drones) {
      if (!g.launched || g.cycleRemainingMs > 0 || g.hpPool <= 0) continue;
      at.pos = g.pos;
      at.vel = g.vel;
      const chance = droneChance(g, at, target);
      if (chance <= 0) continue;
      g.cycleRemainingMs = g.rofMs;
      g.targetId = target.id;
      const dmg = droneVolleyOf(g, g.totalCount);
      pendingHits.push({
        attacker: u, target, dmg, weaponName: g.name, kind: "drone",
        hit: state.mode === "expected" ? true : chance >= 1,
      });
    }

    // 铁骑（一个发射管 = 一个纵队，D-27；按组结算，D-24/25/26）
    for (const f of u.fighters) {
      if (!f.launched || f.cycleRemainingMs > 0 || f.hpPool <= 0) continue;
      at.pos = f.pos;
      at.vel = f.vel;
      const shot = fighterShotAt(f, at, target);
      if (!shot) continue;                 // 两个能力都够不着 → 本轮不打
      f.activeAbility = shot.index;
      f.cycleRemainingMs = shot.ability.cycleMs;
      f.targetId = target.id;
      if (totalDmg(shot.dmg) <= 0) continue;
      // D-25：输出按"组剩余血量比例"线性折算；tubes = 装备的纵队数
      const dmg = scaleDmg(shot.dmg, f.tubes * f.outputRatio);
      pendingHits.push({
        attacker: u, target, dmg, weaponName: `${f.name}（铁骑）`, kind: "drone",
        hit: state.mode === "expected" ? true : shot.chance >= 1,
      });
    }
  }
}

const pendingHits: PendingHit[] = [];

/* -------------------------------------------------------------------------- */
/* 阶段：在途投射物                                                            */
/* -------------------------------------------------------------------------- */

function phaseProjectiles(state: BattleState, ctx: SimContext): void {
  const tick = state.tick;
  for (const p of state.projectiles) {
    if (p.status !== "inFlight") continue;
    if (p.arriveTick > tick) continue;
    const target = ctx.get(p.targetUnitId);
    if (!target || !isTargetable(target)) {
      // ★ 目标已死 → 失效消耗，不产生伤害（D-23，复现"导弹浪费"）
      p.status = "expired";
      continue;
    }
    // 打到"组"的导弹：目标组已灭则按 D-23 失效消耗（复现"导弹浪费"）
    if (p.targetGroupId && p.targetGroupKind) {
      const g = findGroup(target, p.targetGroupKind, p.targetGroupId);
      if (!g || !groupAlive(g)) {
        p.status = "expired";
        continue;
      }
    }
    p.status = "hit";
    pendingHits.push({
      attacker: ctx.get(p.ownerUnitId) ?? target,
      target,
      dmg: p.dmg,
      weaponName: "missile",
      kind: "missile",
      hit: true,
      ...(p.targetGroupId && p.targetGroupKind
        ? { groupId: p.targetGroupId, groupKind: p.targetGroupKind }
        : {}),
    });
  }
  if (state.projectiles.length > 0) {
    state.projectiles = state.projectiles.filter((p) => p.status === "inFlight");
  }
}

/* -------------------------------------------------------------------------- */
/* 阶段：伤害应用与死亡判定                                                     */
/* -------------------------------------------------------------------------- */

function phaseDamageApplication(state: BattleState): void {
  const tick = state.tick;
  for (const hit of pendingHits) {
    if (totalDmg(hit.dmg) <= 0) continue;
    if (!isTargetable(hit.target)) continue;

    // ★ 打「组」（铁骑 / 无人机）：伤害落到组的血池，而不是母舰本体。
    //   组是实体（用户要求）：有自己的血量，被打光就整组消失。
    if (hit.groupId && hit.groupKind) {
      const g = findGroup(hit.target, hit.groupKind, hit.groupId);
      if (!g || !groupAlive(g)) continue; // 组已被打掉 → 本次落空
      const res = applyDamageToGroup(g, hit.dmg);
      hit.target.damageTaken += res.loss;
      if (hit.attacker.id !== hit.target.id) hit.attacker.damageDealt += res.loss;
      if (res.loss > 0 && state.settings.verboseEvents) {
        pushEvent(state, {
          tick, type: "hit", unitId: hit.attacker.id, unitName: hit.attacker.name,
          targetId: hit.target.id,
          targetName: `${g.name}（${groupKindLabel(hit.groupKind)}）`,
          amount: res.loss, detail: hit.weaponName,
        });
      }
      if (res.died) {
        const label = groupKindLabel(hit.groupKind);
        // 记入战报：复盘时要能看到铁骑/无人机的损失
        state.kills.push({
          tick, sideId: hit.target.sideId, unitId: g.id,
          unitName: `${g.name}（${label}）`, shipName: hit.target.shipName,
          killerId: hit.attacker.id,
        });
        pushEvent(state, {
          tick, type: "kill", sideId: hit.target.sideId, unitId: g.id,
          unitName: g.name, shipName: hit.target.shipName,
          targetId: hit.attacker.id, targetName: hit.attacker.name,
          detail: `${label}被消灭`,
        });
      }
      continue;
    }

    const apply = applyDamageToUnit(hit.target, hit.dmg);
    hit.target.damageTaken += apply.loss;
    if (hit.attacker.id !== hit.target.id) hit.attacker.damageDealt += apply.loss;
    if (apply.loss > 0 && state.settings.verboseEvents) {
      pushEvent(state, {
        tick, type: "hit", unitId: hit.attacker.id, unitName: hit.attacker.name,
        targetId: hit.target.id, targetName: hit.target.name,
        amount: apply.loss, detail: hit.weaponName,
      });
    }
    if (apply.died) {
      hit.target.alive = false;
      hit.target.effects = [];
      state.kills.push({
        tick, sideId: hit.target.sideId, unitId: hit.target.id,
        unitName: hit.target.name, shipName: hit.target.shipName, killerId: hit.attacker.id,
      });
      pushEvent(state, {
        tick, type: "kill", sideId: hit.target.sideId, unitId: hit.target.id,
        unitName: hit.target.name, shipName: hit.target.shipName,
        targetId: hit.attacker.id, targetName: hit.attacker.name,
      });
    }
  }
  pendingHits.length = 0;
}

/* -------------------------------------------------------------------------- */
/* 阶段：移动                                                                  */
/* -------------------------------------------------------------------------- */

function phaseMovement(state: BattleState, ctx: SimContext): void {
  const dt = TICK_MS / 1000;
  for (const u of state.units) {
    if (!u.alive || u.evacuated) continue;

    // 旗舰跳冷却随时间递减（与普通跃迁分开计时）
    tickJumpCooldown(u, TICK_MS);

    // 增援入场的"过门/落地"延迟：这段时间内不机动，延迟结束才执行机动指令
    if (u.arrivalDelayMs > 0) {
      u.arrivalDelayMs -= TICK_MS;
      if (u.arrivalDelayMs <= 0) {
        u.arrivalDelayMs = 0;
        if (u.pendingOrder) {
          u.order = u.pendingOrder;
          u.pendingOrder = null;
        }
        pushEvent(state, {
          tick: state.tick, type: "reinforce", sideId: u.sideId,
          unitId: u.id, unitName: u.name, shipName: u.shipName, detail: "增援进场完毕",
        });
      }
      continue;
    }

    // 旗舰跳：与普通跃迁**区分**——瞬时到位 + 进入冷却（不是飞过去）
    if (u.order.type === "jump") {
      const to = u.order.to ?? null;
      if (to) {
        const verdict = performJump(state, u, to);
        if (verdict.ok) {
          pushEvent(state, {
            tick: state.tick, type: "jump", sideId: u.sideId,
            unitId: u.id, unitName: u.name, shipName: u.shipName, detail: "旗舰跳",
          });
        } else {
          pushEvent(state, {
            tick: state.tick, type: "command", sideId: u.sideId,
            unitId: u.id, unitName: u.name, detail: `旗舰跳被拒：${verdict.reason}`,
          });
        }
      }
      u.order = { type: "hold" };
      continue;
    }

    // ★ 跃迁至：**先对齐（起跳时间）→ 按跃迁速度（AU/s）飞抵落点**，
    //   而不是"平速跑过实际 AU 距离"（用户明确要求）。
    if (u.order.type === "warp") {
      if (u.warpRemainingMs <= 0) {
        const verdict = warpAllowed(state, u);
        if (!verdict.ok) {
          u.order = { type: "hold" };
          pushEvent(state, {
            tick: state.tick, type: "command", sideId: u.sideId,
            unitId: u.id, unitName: u.name, detail: `跃迁被拒：${verdict.reason}`,
          });
          continue;
        }
        const dest = warpLanding(state, u);
        if (!dest) {
          u.order = { type: "hold" };
          continue;
        }
        const dist = vec.dist(u.pos, dest);
        const warpSpeed = u.stats.attrs.nav.warpSpeedMultiplier
          ?? u.stats.attrs.nav.baseWarpSpeed ?? 3;
        u.warpDest = dest;
        // 起跳时间（对齐）+ 跃迁旅行时间；两者都以"秒"计，再换算 ms
        u.warpRemainingMs = (u.alignTime + warpTravelSeconds(dist, warpSpeed)) * 1000;
        u.warpingOut = true;
        u.vel = { x: 0, y: 0 };
        u.locked = false;
        u.targetId = null;
        pushEvent(state, {
          tick: state.tick, type: "warp", sideId: u.sideId,
          unitId: u.id, unitName: u.name, shipName: u.shipName,
          detail: `跃迁起跳（${(dist / 1000).toFixed(0)} km，起跳 ${u.alignTime.toFixed(1)}s）`,
        });
      } else {
        u.warpRemainingMs -= TICK_MS;
        if (u.warpRemainingMs <= 0) {
          if (u.warpDest) u.pos = { ...u.warpDest };
          u.vel = { x: 0, y: 0 };
          u.warpingOut = false;
          u.warpRemainingMs = 0;
          u.warpDest = null;
          u.order = { type: "hold" };
          pushEvent(state, {
            tick: state.tick, type: "warp", sideId: u.sideId,
            unitId: u.id, unitName: u.name, shipName: u.shipName, detail: "跃迁到达",
          });
        }
      }
      continue;
    }

    // 撤离：先对齐，再离场
    if (u.order.type === "warpOut") {
      if (u.warpRemainingMs <= 0) {
        const distance = 5 * 1e6; // 简化：以 5000km 为离场距离
        u.warpRemainingMs = (u.alignTime + warpTravelSeconds(distance, u.stats.attrs.nav.warpSpeedMultiplier ?? 1)) * 1000;
        u.warpingOut = true;
        pushEvent(state, { tick: state.tick, type: "warp", unitId: u.id, unitName: u.name });
      } else {
        u.warpRemainingMs -= TICK_MS;
        if (u.warpRemainingMs <= 0) {
          u.evacuated = true;
          u.locked = false;
          pushEvent(state, { tick: state.tick, type: "evacuate", unitId: u.id, unitName: u.name, shipName: u.shipName });
        }
      }
      continue;
    }

    stepMovement(u, ctx, dt);
  }
}

/**
 * 「跃迁至」的落点：目标（`targetId` 指向的单位，或 `to` 坐标）**偏移 `range` 米**处。
 * 目标还活着就按它**当前**位置算（跟随移动目标）；否则退回指令下达时的坐标。
 */
function warpLanding(state: BattleState, u: Unit): Vec2 | null {
  const o = u.order;
  const t = o.targetId ? state.units.find((x) => x.id === o.targetId) : undefined;
  const anchor: Vec2 | null = t && t.alive && !t.evacuated ? t.pos : (o.to ?? null);
  if (!anchor) return null;
  const range = Math.max(0, o.range ?? 0);
  if (range <= 0) return { x: anchor.x, y: anchor.y };
  const d = vec.dist(u.pos, anchor);
  if (d <= range || d < 1) return { x: anchor.x, y: anchor.y };
  const k = (d - range) / d;
  return { x: u.pos.x + (anchor.x - u.pos.x) * k, y: u.pos.y + (anchor.y - u.pos.y) * k };
}

/* -------------------------------------------------------------------------- */
/* 主循环                                                                      */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* 阶段：立体炸弹                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 立体炸弹：对**作用半径内的所有实体**造成伤害。
 *
 * ★ 忠实复现 EVE 行为：**六亲不认** —— 友军的舰船、友军的铁骑与无人机照样被炸。
 * ★ 铁骑/无人机也是实体：它们同样在范围内、同样吃伤害（用户明确要求）。
 * 不需要锁定，也不需要目标 —— 这是它与武器的根本区别。
 */
function phaseSmartbombs(state: BattleState, ctx: SimContext): void {
  const tick = state.tick;
  for (const u of state.units) {
    if (!u.alive || u.evacuated || u.arrivalDelayMs > 0) continue;
    for (const a of u.actives) {
      if (a.kind !== "smartbomb" || !a.smartbomb) continue;
      if (!a.on || a.cycleRemainingMs > 0) continue;
      if (a.capNeed > 0 && u.cap < a.capNeed) continue;
      if (a.capNeed > 0) u.cap -= a.capNeed;

      const rangeM = a.smartbomb.rangeM;
      const dmg: DamageTypes = { ...a.smartbomb.dmg };
      if (rangeM <= 0 || totalDmg(dmg) <= 0) {
        a.cycleRemainingMs = a.cycleMs;
        continue;
      }
      a.cycleRemainingMs = a.cycleMs;

      for (const t of state.units) {
        if (t.arrivalDelayMs > 0 || t.evacuated) continue;
        if (vec.dist(u.pos, t.pos) > rangeM) continue;

        // 1) 舰船/建筑本体。
        //    注意：**发起引爆的舰本身不受自己炸弹的伤**（EVE 行为），但友军照炸。
        if (t.alive && t.id !== u.id) {
          pendingHits.push({
            attacker: u, target: t, dmg: { ...dmg },
            weaponName: a.name, kind: "smartbomb", hit: true,
          });
        }
        // 2) 挂在该单位上的铁骑与无人机（组也是实体）
        const groups: Array<[GroupKind, GroupLike]> = [
          ...t.fighters.filter(groupAlive).map((g) => ["fighter", g] as [GroupKind, GroupLike]),
          ...t.drones.filter(groupAlive).map((g) => ["drone", g] as [GroupKind, GroupLike]),
        ];
        for (const [gk, g] of groups) {
          // 组有自己的位置：按**组的位置**判定是否在爆炸范围内
          // （铁骑/无人机飞出去环绕后，母舰在范围内并不代表它们也在）
          if (vec.dist(u.pos, g.pos) > rangeM) continue;
          pendingHits.push({
            attacker: u, target: t, dmg: { ...dmg },
            weaponName: a.name, kind: "smartbomb", hit: true,
            groupId: g.id, groupKind: gk,
          });
        }
      }
      pushEvent(state, {
        tick, type: "fire", unitId: u.id, unitName: u.name,
        detail: `${a.name}（立体炸弹 ${Math.round(rangeM)}m）`,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 阶段：组的机动（出仓 → 飞向目标 → 按最佳射程平速环绕）                      */
/* -------------------------------------------------------------------------- */

/**
 * 环绕时每 tick 允许转过的最大角度（弧度）。
 *
 * ★ 无人机的最佳射程（数百米~数千米）与其最大速度（数千 m/s）相比很小，
 *   若让"弧长 = 速度 × dt"一步走完，一 tick 就能绕目标好几圈，图标在圈上乱跳
 *   （用户反馈的"频繁闪烁"）。这里给**转速**封顶，使环绕成为肉眼可跟随的平滑圆周运动。
 *   注意：速度矢量大小恒为 `maxVelocity`，"平速环绕"的语义不变。
 */
const ORBIT_MAX_TURN_RAD = 0.4;

/**
 * 朝 `to` 推进一步（限速；接近时只走剩余距离）。
 *
 * `maxStep` 用于**在到达环绕半径前收住** —— 否则一步会跨过环绕半径，
 * 铁骑就会贴在目标身上转（实测偏差 1.1km）。
 */
function stepToward(
  p: Vec2, to: Vec2, speed: number, dt: number, maxStep = Infinity,
): Vec2 {
  const dx = to.x - p.x;
  const dy = to.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d <= 1e-6) return { x: 0, y: 0 };
  const step = Math.min(d, speed * dt, Math.max(0, maxStep));
  return { x: (dx / d) * step, y: (dy / d) * step };
}

/**
 * 无人机组 / 铁骑纵队的机动（用户规则）。
 *
 * 出仓后：**自主飞向目标** → 抵达**最佳射程**（铁骑用 `orbitRange`、无人机用 `optimal`）
 * → **平速环绕**：速度大小恒为 `maxVelocity`、方向取切向，因此环绕半径保持不变。
 * 没有有效目标时返回母舰身边待命。
 *
 * ★ 组有自己的位置，所以射程/命中判定在别处也一律用 `g.pos`（见 phaseWeaponFire 的替身）。
 */
function phaseGroupMovement(state: BattleState, ctx: SimContext): void {
  const dt = TICK_MS / 1000;
  for (const u of state.units) {
    if (!u.alive || u.evacuated) continue;
    // 母舰还没到场时组也不动（避免增援尚未落地，铁骑先飞出去）
    if (u.arrivalDelayMs > 0) continue;

    const groups: Array<{ g: GroupLike; orbit: number }> = [
      ...u.fighters.map((f) => ({ g: f as GroupLike, orbit: f.orbitRange })),
      ...u.drones.map((d) => ({ g: d as GroupLike, orbit: d.optimal })),
    ];

    for (const { g, orbit } of groups) {
      if (!g.launched || g.hpPool <= 0 || g.maxVelocity <= 0) continue;
      const r = Math.max(500, orbit);

      // 目标：优先用组自己的攻击目标；没有就继承母舰的交火目标（出仓后自动接敌）
      let target = ctx.get(g.targetId);
      if (!target || !isTargetable(target)) {
        const inherited = ctx.get(u.targetId);
        if (inherited && isTargetable(inherited)) {
          target = inherited;
          g.targetId = inherited.id;
        } else {
          target = undefined;
        }
      }

      if (!target) {
        // 无目标 → 回到母舰身边待命
        if (vec.dist(g.pos, u.pos) > Math.max(500, r)) {
          const v = stepToward(g.pos, u.pos, g.maxVelocity, dt);
          g.pos = { x: g.pos.x + v.x, y: g.pos.y + v.y };
          g.vel = { x: v.x / dt, y: v.y / dt };
        } else {
          g.vel = { x: 0, y: 0 };
        }
        continue;
      }

      const dist = vec.dist(g.pos, target.pos);
      // ★ 1 m 容差：没有它，"收在半径上"会让 dist−r 停在 1e-9 量级，
      //   每 tick 只走纳米级、永远进不了环绕分支
      //   （表现是组贴在半径上一动不动、速度为 0）。
      if (dist > r + 1) {
        // 赶路：朝目标全速飞，但**收在环绕半径上**（不能冲过头）
        const v = stepToward(g.pos, target.pos, g.maxVelocity, dt, dist - r);
        g.pos = { x: g.pos.x + v.x, y: g.pos.y + v.y };
        g.vel = { x: v.x / dt, y: v.y / dt };
      } else {
        // 已到位：**平速环绕**（半径严格不变，方向固定以保证确定性）
        //
        // ★ 必须走**圆弧**而不能沿切线直走：沿切线直走一步后，半径会变成
        //   `√(d² + step²)`（1 tick = 1 秒、组速数千 m/s 时半径一步就涨几百米），
        //   下一 tick 又被上面"赶路"分支按 `dist − r` 拉回半径——
        //   于是组在半径内**每个 tick 反复内外跳动、聚散闪烁**（用户反馈的现象）。
        //   按弧长 `step` 旋转 θ = step / d 则半径恒等于 d。
        const dx = g.pos.x - target.pos.x;
        const dy = g.pos.y - target.pos.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        // 转速上限：无人机最佳射程很小，若不封顶，一 tick 就能绕一整圈（表现为乱跳）
        const theta = Math.min((g.maxVelocity * dt) / d, ORBIT_MAX_TURN_RAD);
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const nx = dx * cos - dy * sin;
        const ny = dx * sin + dy * cos;
        g.pos = { x: target.pos.x + nx, y: target.pos.y + ny };
        // 速度仍是切向、大小恒为 maxVelocity（"平速环绕"语义不变）
        g.vel = { x: (-ny / d) * g.maxVelocity, y: (nx / d) * g.maxVelocity };
      }
    }
  }
}

const PHASE_FUNCS: Record<string, (state: BattleState, ctx: SimContext) => void> = {
  commands: phaseCommands,
  targeting: phaseTargeting,
  capRecharge: phaseCapRecharge,
  moduleCycles: phaseModuleCycles,
  microJump: phaseMicroJump,
  capTransfer: phaseCapTransfer,
  energyWarfare: phaseEnergyWarfare,
  remoteRepair: phaseRemoteRepair,
  ewar: phaseEwar,
  weaponFire: phaseWeaponFire,
  projectiles: phaseProjectiles,
  smartbombs: phaseSmartbombs,
  damageApplication: phaseDamageApplication,
  movement: phaseMovement,
  groupMovement: phaseGroupMovement,
};

/** 推进一个 tick（严格按 state.phaseOrder）。 */
export function step(state: BattleState, ctx: SimContext): void {
  if (state.finished) return;
  for (const name of state.phaseOrder) {
    const fn = PHASE_FUNCS[name];
    if (!fn) {
      ctx.log?.(`未知阶段：${name}`);
      continue;
    }
    fn(state, ctx);
  }
  state.tick += 1;
  checkFinished(state);
}

/**
 * 只剩（至多）一个势力仍有单位在场 → 结束。
 *
 * ★ 泛化到任意数量势力：场上残余势力集合 size ≤ 1 即判定结束；
 *   size = 1 时该势力获胜，size = 0 时同归于尽。
 */
function checkFinished(state: BattleState): void {
  const alive = new Set<number>();
  for (const u of state.units) {
    if (!u.evacuated) alive.add(u.sideId);
  }
  if (alive.size <= 1) {
    state.finished = true;
    state.winnerSideId = alive.size === 1 ? [...alive][0] : null;
  }
}

/** 连续推进 n 个 tick。 */
export function runTicks(state: BattleState, ctx: SimContext, n: number): void {
  for (let i = 0; i < n && !state.finished; i++) step(state, ctx);
}

/* -------------------------------------------------------------------------- */
/* 汇总（战报）                                                                */
/* -------------------------------------------------------------------------- */

export interface SideReport {
  sideId: number;
  start: number;
  alive: number;
  killed: number;
  evacuated: number;
  damageDealt: number;
  damageTaken: number;
}

export function report(state: BattleState): { sides: SideReport[]; ticks: number; finished: boolean; winnerSideId: number | null } {
  // 泛化到任意数量势力：按实际出现的 sideId 升序列出
  const sideIds = [...new Set(state.units.map((u) => u.sideId))].sort((a, b) => a - b);
  const sides: SideReport[] = sideIds.map((sideId) => {
    const list = state.units.filter((u) => u.sideId === sideId);
    return {
      sideId,
      start: list.length,
      alive: list.filter((u) => u.alive && !u.evacuated).length,
      killed: list.filter((u) => !u.alive).length,
      evacuated: list.filter((u) => u.evacuated).length,
      damageDealt: Math.round(list.reduce((s, u) => s + u.damageDealt, 0)),
      damageTaken: Math.round(list.reduce((s, u) => s + u.damageTaken, 0)),
    };
  });
  return { sides, ticks: state.tick, finished: state.finished, winnerSideId: state.winnerSideId };
}

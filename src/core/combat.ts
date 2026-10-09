/**
 * 命中 / 应用率 / 伤害结算（交接文档 §6.6、§6.7）。
 *
 * ★ 本文件的公式**逐条对照 PYFA 自身实现取得**（反汇编 `graphs.data.fitApplicationProfile.calc.*`
 *   与 `graphs.data.fitDamageStats.calc.application`），不是自行推导：
 *
 *   炮台射程系数   `eos.calc.calculateRangeFactor`  → 0.5^((max(0,d-optimal)/falloff)^2)
 *   炮台追踪系数   `turret.calcTrackingFactor`      → 0.5^( (ω·炮台分辨率/(追踪·目标信号)) ^2 )
 *   炮台命中       chance = 射程系数 × 追踪系数（两者同为 0.5^(x²)，乘积即指数相加）
 *   炮台伤害系数   `turret.calcTurretDamageMult`    → 期望值含 1% 陨星打击 ×3
 *   导弹应用率     `launcher.calcMissileFactor`     → min(1, 目标信号/eR, ((eV·目标信号)/(eR·目标速度))^DRF)
 *   其中 DRF = 弹药的 `aoeDamageReductionFactor`（导弹），炮台分辨率 = 武器的 `signatureRadius`。
 *
 * ⚠ 交接文档 §6.6 把 trackTerm 的比例写反了（原文为 角速度×目标信号 /(追踪×炮台分辨率)）。
 *   正确形式以 PYFA 为准：**角速度 × 炮台分辨率 / (追踪 × 目标信号)**，即目标信号越大越容易命中。
 */
import type { DamageType, Res4 } from "../shared/contract.ts";
import { Rng } from "./deterministic.ts";
import { angularVelocity, effectiveSignatureRadius, rangeTo, trackingMultiplier } from "./geometry.ts";
import type { DroneGroup, FighterSquadron, Unit, WeaponInstance } from "./state.ts";

export type DamageTypes = Record<DamageType, number>;

export const ZERO_DMG: Readonly<DamageTypes> = { em: 0, thermal: 0, kinetic: 0, explosive: 0 };

export function addDmg(a: DamageTypes, b: DamageTypes): DamageTypes {
  return {
    em: a.em + b.em,
    thermal: a.thermal + b.thermal,
    kinetic: a.kinetic + b.kinetic,
    explosive: a.explosive + b.explosive,
  };
}

export function scaleDmg(a: DamageTypes, k: number): DamageTypes {
  return { em: a.em * k, thermal: a.thermal * k, kinetic: a.kinetic * k, explosive: a.explosive * k };
}

export function totalDmg(a: DamageTypes): number {
  return a.em + a.thermal + a.kinetic + a.explosive;
}

/** 武器单发齐射伤害 = 弹药四类伤害 × 炮台 damageMultiplier。 */
export function volleyOf(w: WeaponInstance): DamageTypes {
  return scaleDmg(w.dmgTypes, w.damageMultiplier);
}

export function droneVolleyOf(g: DroneGroup, groupCount: number): DamageTypes {
  // 组的输出按 outputRatio 线性折算（D-25）
  return scaleDmg(g.dmgTypes, g.damageMultiplier * groupCount * g.outputRatio);
}

/**
 * 单舰**理论秒伤**（PYFA 口径的"DPS"：射程内、100% 命中、不含目标抗性）。
 *
 * = Σ 每门炮 `单发齐射 ÷ 循环` + Σ 无人机组 `单发 × 组数 × 输出比 ÷ 循环`。
 *
 * ★ 与 PYFA 面板/伤害曲线图上的"秒伤"一一对应（PYFA 自身的 volley÷rof×门数）。
 *   实际命中率衰减（超最佳射程、追踪不足）在 `resolveTurretShot` 里另行折算，
 *   因此这里的数值是"最好情况下的上限"，与 PYFA 图上近距离平台段一致。
 */
export function unitDpsOf(u: Unit): number {
  let dps = 0;
  for (const w of u.weapons) {
    const rof = w.rofMs / 1000;
    if (rof > 0) dps += totalDmg(volleyOf(w)) / rof;
  }
  for (const g of u.drones) {
    const rof = g.rofMs / 1000;
    if (rof > 0) dps += totalDmg(droneVolleyOf(g, g.totalCount)) / rof;
  }
  return dps;
}

/* -------------------------------------------------------------------------- */
/* 炮台                                                                        */
/* -------------------------------------------------------------------------- */

/** 射程系数：0.5^((max(0, d-optimal)/falloff)^2)。falloff 为 0 时是硬边界。 */
export function rangeFactor(distance: number, optimal: number, falloff: number): number {
  if (falloff <= 0) return distance <= optimal ? 1 : 0;
  const over = Math.max(0, distance - optimal) / falloff;
  return 0.5 ** (over * over);
}

/** 追踪系数：0.5^( (ω·炮台分辨率/(追踪·目标信号)) ^2 )。 */
export function trackingFactor(
  tracking: number, turretSig: number, angularSpeed: number, targetSig: number,
): number {
  if (tracking <= 0 || targetSig <= 0) return 0;
  if (angularSpeed <= 0) return 1;
  const exponent = (angularSpeed * turretSig) / (tracking * targetSig);
  return 0.5 ** (exponent * exponent);
}

export function turretChance(
  w: WeaponInstance, attacker: Unit, target: Unit, distance: number, angular: number,
): number {
  const rf = rangeFactor(distance, w.optimal, w.falloff);
  if (rf <= 0) return 0;
  const tf = trackingFactor(
    w.tracking * trackingMultiplier(attacker),
    w.sigResolution,
    angular,
    effectiveSignatureRadius(target),
  );
  return rf * tf;
}

/** 炮台期望伤害系数（PYFA `calcTurretDamageMult`，含 1% 陨星打击 ×3）。 */
export function turretDamageMult(chanceToHit: number): number {
  const wreckingChance = Math.min(chanceToHit, 0.01);
  const wreckingPart = wreckingChance * 3;
  const normalChance = chanceToHit - wreckingChance;
  const normalPart = normalChance > 0 ? normalChance * ((0.01 + chanceToHit) / 2 + 0.49) : 0;
  return normalPart + wreckingPart;
}

/* -------------------------------------------------------------------------- */
/* 导弹 / 无人机                                                               */
/* -------------------------------------------------------------------------- */

/** 导弹应用率（PYFA `calcMissileFactor`）。 */
export function missileApplication(
  eR: number, eV: number, drf: number, targetSig: number, targetSpeed: number,
): number {
  const factors: number[] = [1];
  if (eR > 0) factors.push(targetSig / eR);
  if (targetSpeed > 0 && eR > 0) {
    factors.push(((eV * targetSig) / (eR * targetSpeed)) ** drf);
  }
  return Math.max(0, Math.min(...factors));
}

/** 导弹可命中距离（速度 × 飞行时间）。 */
export function missileRange(w: WeaponInstance): number {
  return w.missileVelocity * (w.missileFlightMs / 1000);
}

/** 导弹飞行时间（秒），按当前距离。 */
export function missileFlightSeconds(w: WeaponInstance, distance: number): number {
  if (w.missileVelocity <= 0) return w.missileFlightMs / 1000;
  return distance / w.missileVelocity;
}

/* -------------------------------------------------------------------------- */
/* 伤害结算                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 对「组」（铁骑纵队 / 无人机组）施加伤害。
 *
 * ★ 用户要求：铁骑与无人机都是**实体**，会被导弹/炮火/立体炸弹打到。
 * 组只有一个血池（不细分盾/甲/构，也不做抗性下渗 —— 这是显式简化，已记入 README），
 * 扣完后按 D-25 线性折算输出比例；归零即整组被消灭、从场上消失。
 */
export function applyDamageToGroup(
  g: DroneGroup | FighterSquadron, dmg: DamageTypes,
): { loss: number; died: boolean } {
  const amount = Math.max(0, totalDmg(dmg));
  const loss = Math.min(g.hpPool, amount);
  g.hpPool -= loss;
  g.outputRatio = g.hpPoolMax > 0 ? Math.max(0, g.hpPool / g.hpPoolMax) : 0;
  if (g.hpPool <= 0) {
    g.hpPool = 0;
    g.outputRatio = 0;
    g.launched = false; // 整组被消灭：不再出现在场上
    return { loss, died: true };
  }
  return { loss, died: false };
}

const LAYERS = ["shield", "armor", "hull"] as const;

/**
 * 把伤害应用到单位的三层 HP（护盾 → 装甲 → 结构）。
 * 每层按其共振值吸收血条，打空后**原始伤害**按比例继续下渗。
 * 返回实际造成的血条损失与是否阵亡。
 */
export function applyDamageToUnit(u: Unit, dmg: DamageTypes): { loss: number; died: boolean } {
  let remaining: DamageTypes = { ...dmg };
  let loss = 0;
  const res = u.stats.attrs.res;

  for (const layer of LAYERS) {
    const layerRes: Res4 = res[layer];
    const hp = u.hp[layer];
    if (hp <= 0) continue;

    const lossFull =
      remaining.em * layerRes[0] +
      remaining.thermal * layerRes[1] +
      remaining.kinetic * layerRes[2] +
      remaining.explosive * layerRes[3];
    if (lossFull <= 1e-9) break;

    if (lossFull <= hp) {
      u.hp[layer] = hp - lossFull;
      loss += lossFull;
      remaining = { ...ZERO_DMG };
      break;
    }

    // 该层被打空：按"被吸收比例"反推剩余原始伤害，继续下渗
    const absorbed = hp / lossFull;
    u.hp[layer] = 0;
    loss += hp;
    remaining = scaleDmg(remaining, 1 - absorbed);
  }

  const died = u.hp.shield <= 0 && u.hp.armor <= 0 && u.hp.hull <= 0;
  if (died) u.alive = false;
  return { loss, died };
}

/** EHP：Σ_层 Σ_i (层HP/4)/resonance —— 用于战报与验收。 */
export function ehp(u: Unit): number {
  const res = u.stats.attrs.res;
  let total = 0;
  for (const layer of LAYERS) {
    const hp = u.maxHp[layer];
    const r = res[layer];
    for (let i = 0; i < 4; i++) total += hp / 4 / Math.max(1e-6, r[i]);
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/* 单次开火的期望/随机结算                                                      */
/* -------------------------------------------------------------------------- */

export interface ShotResult {
  /** 造成的伤害（已含命中/应用折算，未含抗性）。 */
  dmg: DamageTypes;
  chance: number;
  inRange: boolean;
}

/**
 * 一次炮台开火。expected 模式取 PYFA 的期望系数；stochastic 模式真掷骰
 * （共用同一套公式，仅"命中判定"一处不同 —— 为蒙特卡洛预留，D-13）。
 */
export function resolveTurretShot(
  w: WeaponInstance, attacker: Unit, target: Unit, mode: "expected" | "stochastic", tick: number,
): ShotResult {
  const distance = rangeTo(attacker, target);
  const angular = angularVelocity(attacker, target);
  const chance = turretChance(w, attacker, target, distance, angular);
  const inRange = rangeFactor(distance, w.optimal, w.falloff) > 0;
  const volley = volleyOf(w);

  if (chance <= 0) return { dmg: { ...ZERO_DMG }, chance, inRange };

  if (mode === "expected") {
    return { dmg: scaleDmg(volley, turretDamageMult(chance)), chance, inRange };
  }

  const rng = new Rng(w.id + attacker.id, "turretHit", tick, target.id.length);
  const wrecking = rng.chance(Math.min(chance, 0.01));
  if (wrecking) return { dmg: scaleDmg(volley, 3), chance, inRange };
  if (!rng.chance(chance)) return { dmg: { ...ZERO_DMG }, chance, inRange };
  const grade = chance * (0.5 + rng.next());
  return { dmg: scaleDmg(volley, grade), chance, inRange };
}

/** 一次导弹/无人机开火（导弹返回"在途"所需的飞行时间）。 */
export function resolveMissileShot(
  w: WeaponInstance, attacker: Unit, target: Unit, mode: "expected" | "stochastic", tick: number,
): ShotResult & { flightSeconds: number } {
  const distance = rangeTo(attacker, target);
  const range = missileRange(w);
  const inRange = range <= 0 || distance <= range;
  const app = missileApplication(
    w.aoeCloudSize, w.aoeVelocity, w.aoeDamageReduction,
    effectiveSignatureRadius(target), Math.hypot(target.vel.x, target.vel.y),
  );
  const volley = volleyOf(w);
  const flightSeconds = Math.min(w.missileFlightMs / 1000, missileFlightSeconds(w, distance));

  if (!inRange) return { dmg: { ...ZERO_DMG }, chance: app, inRange, flightSeconds };
  if (mode === "expected") {
    return { dmg: scaleDmg(volley, app), chance: app, inRange, flightSeconds };
  }
  const rng = new Rng(w.id + attacker.id, "missileHit", tick, target.id.length);
  return {
    dmg: rng.chance(app) ? { ...volley } : { ...ZERO_DMG },
    chance: app,
    inRange,
    flightSeconds,
  };
}

/** 铁骑纵队的一次开火解算结果。 */
export interface FighterShot {
  /** 选用的能力下标（写回 `FighterSquadron.activeAbility`）。 */
  index: number;
  ability: FighterSquadron["abilities"][number];
  /** 应用率（导弹公式）。 */
  chance: number;
  /** 期望伤害（已含应用率）。 */
  dmg: DamageTypes;
}

/**
 * 按距离为铁骑纵队挑选能力，并算出应用率与期望伤害。
 *
 * ★ 铁骑**不是炮台**：伤害按导弹公式应用（爆炸半径/速度 + DRF/DRS），
 *   这与 PYFA 的铁骑建模一致（`fighterAbilityAttackMissileExplosionRadius` 等）。
 * 一个纵队通常带两个攻击能力（贴身攻击 5s 周期 / 远程导弹 14s 周期），
 * 这里按"期望 DPS 最高"挑一个 —— 贴身时会自然选出攻击能力。
 */
export function fighterShotAt(
  f: FighterSquadron, attacker: Unit, target: Unit,
): FighterShot | null {
  const distance = rangeTo(attacker, target);
  const targetSig = effectiveSignatureRadius(target);
  const targetSpeed = Math.hypot(target.vel.x, target.vel.y);
  let best: FighterShot | null = null;
  let bestDps = -1;
  for (let i = 0; i < f.abilities.length; i++) {
    const a = f.abilities[i];
    if (rangeFactor(distance, a.optimal, a.falloff) <= 0) continue;
    const chance = missileApplication(
      a.explosionRadius, a.explosionVelocity, a.drf, targetSig, targetSpeed,
    );
    const dps = (totalDmg(a.volley) * chance) / (a.cycleMs / 1000);
    if (dps > bestDps) {
      bestDps = dps;
      best = { index: i, ability: a, chance, dmg: scaleDmg(a.volley, chance) };
    }
  }
  return best;
}

/** 无人机开火（用 optimalSigRadius 作炮台分辨率，其余同炮台）。 */
export function droneChance(g: DroneGroup, attacker: Unit, target: Unit): number {
  const distance = rangeTo(attacker, target);
  const angular = angularVelocity(attacker, target);
  const rf = rangeFactor(distance, g.optimal, g.falloff);
  if (rf <= 0) return 0;
  const tf = trackingFactor(
    g.tracking, g.optimalSigRadius, angular, effectiveSignatureRadius(target),
  );
  return rf * tf;
}

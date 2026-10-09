/**
 * 属性装配：UnitBlueprint + FitStats → Unit（交接文档 §7.2、§7.3）。
 *
 * 铁律（§7.2）：配装按**单位**定义；任何属性重算必须按每条船自己的 fit，
 * 绝不能用舰队级 fit 套用到全队（上一版 B3 的根因）。
 */
import type { ActiveRow, FighterRow, FitStats, WeaponRow } from "../shared/contract.ts";
import { iconClassOf } from "../shared/hullclass.ts";
import { alignSeconds } from "./geometry.ts";
import type {
  ActiveInstance, DroneGroup, FighterSquadron, JumpCapability, Unit, UnitBlueprint, WeaponInstance,
} from "./state.ts";

export type { UnitBlueprint };

function num(v: number | null | undefined, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 光年 → 米。 */
export const LY_TO_M = 9.4607e15;

/**
 * 旗舰跳能力：**只有装了跳跃引擎的船才有**（SDE 的 jumpDriveRange > 0）。
 *
 * ★ 单位坑：`jumpDriveRange` 的单位是**光年**（实测：凤凰/启示/执政官 3.5，泰坦 3.0，
 *   跳跃货舰 5.0；普通战列舰为 None），必须换算成米，否则跳跃距离会变成 3.5 m。
 *
 * 能力 ≠ 允许：能否跳还要看反跳 / 冷却 / 场景开关（见 core/jump.ts 的 jumpAllowed）。
 */
export function jumpCapability(stats: FitStats): JumpCapability | null {
  const ly = num(stats.attrs.jump?.range, 0);
  if (!(ly > 0)) return null;
  return { rangeM: ly * LY_TO_M, rangeLy: ly, cooldownMs: 0, remainingMs: 0, allowed: true };
}

/** 把一行武器（同型号 count 门）展开为独立实例：每门各自冷却（§6.3 阶段 7）。 */
export function weaponInstances(row: WeaponRow): WeaponInstance[] {
  const out: WeaponInstance[] = [];
  const kind: WeaponInstance["kind"] =
    row.kind === "launcher" || row.missileVelocity ? "launcher" : "turret";
  for (let i = 0; i < Math.max(1, row.count); i++) {
    out.push({
      id: `w:${row.typeId}:${i}`,
      typeId: row.typeId,
      name: row.name,
      kind,
      damageMultiplier: num(row.damageMultiplier, 0),
      rofMs: Math.max(1, num(row.rof, 1000)),
      optimal: num(row.optimal, 0),
      falloff: num(row.falloff, 0),
      tracking: num(row.tracking, 0),
      sigResolution: num(row.sigResolution, 40),
      aoeCloudSize: num(row.aoeCloudSize, 0),
      aoeVelocity: num(row.aoeVelocity, 0),
      aoeDamageReduction: num(row.aoeDamageReduction, 1),
      missileVelocity: num(row.missileVelocity, 0),
      missileFlightMs: num(row.missileFlightMs, 0),
      capNeed: num(row.capNeed, 0),
      chargeTypeId: row.chargeTypeId ?? null,
      chargeName: row.chargeName ?? null,
      dmgTypes: {
        em: num(row.dmgTypes.em, 0),
        thermal: num(row.dmgTypes.thermal, 0),
        kinetic: num(row.dmgTypes.kinetic, 0),
        explosive: num(row.dmgTypes.explosive, 0),
      },
      on: row.state === "active",
      cycleRemainingMs: 0,
    });
  }
  return out;
}

/** 主动模块：oracle 每实例一行。 */
export function activeInstance(row: ActiveRow, index: number): ActiveInstance {
  return {
    id: `a:${row.typeId}:${index}`,
    typeId: row.typeId,
    name: row.name,
    // 指挥脉冲波靠弹药区分：按钮上要显示"装甲激能"这类名字
    chargeName: row.chargeName ?? null,
    kind: row.kind,
    cycleMs: Math.max(1, num(row.duration, 1000)),
    capNeed: num(row.capNeed, 0),
    optimal: num(row.optimal, 0),
    falloff: num(row.falloff, 0),
    effectAmounts: { ...row.effectAmounts },
    // 立体炸弹：作用半径与四类伤害（对范围内**所有实体**生效，含铁骑/无人机）
    smartbomb: row.smartbomb
      ? {
        rangeM: num(row.smartbomb.range, 0),
        dmg: {
          em: num(row.smartbomb.dmg?.em, 0),
          thermal: num(row.smartbomb.dmg?.thermal, 0),
          kinetic: num(row.smartbomb.dmg?.kinetic, 0),
          explosive: num(row.smartbomb.dmg?.explosive, 0),
        },
      }
      : null,
    // 跳刀（微型跳跃引擎）：跃迁距离与再启动冷却。
    // 距离 oracle 已兜底：普通型无 mjdJumpRange → 100 km；旗舰型 250 km。
    microJump: row.microJump
      ? {
        distanceM: num(row.microJump.distanceM, 100_000),
        cooldownMs: num(row.microJump.cooldownMs, 0),
      }
      : null,
    on: row.state === "active",
    pendingOff: false,
    cycleRemainingMs: 0,
    targetId: null,
    reactDelayMs: 0,
    cooldownRemainingMs: 0,
  };
}

export function droneGroup(row: FitStats["drones"][number], index: number): DroneGroup {
  const each =
    num(row.hpEach.shield, 0) + num(row.hpEach.armor, 0) + num(row.hpEach.hull, 0);
  const hpPoolMax = Math.max(1, each * Math.max(1, row.count));
  return {
    id: `d:${row.typeId}:${index}`,
    typeId: row.typeId,
    name: row.name,
    totalCount: Math.max(1, row.count),
    hpPoolMax,
    hpPool: hpPoolMax,
    outputRatio: 1,
    damageMultiplier: num(row.damageMultiplier, 0),
    rofMs: Math.max(1, num(row.rof, 1000)),
    optimal: num(row.optimal, 0),
    falloff: num(row.falloff, 0),
    tracking: num(row.tracking, 0),
    optimalSigRadius: num(row.optimalSigRadius, 40),
    signatureRadius: num(row.signatureRadius, 40),
    dmgTypes: {
      em: num(row.dmgTypes.em, 0),
      thermal: num(row.dmgTypes.thermal, 0),
      kinetic: num(row.dmgTypes.kinetic, 0),
      explosive: num(row.dmgTypes.explosive, 0),
    },
    maxVelocity: num(row.maxVelocity, 0),
    cycleRemainingMs: 0,
    targetId: null,
    launched: true,
  };
}

/**
 * 铁骑纵队（一个发射管 = 一个纵队，D-27）。
 *
 * 属性全部来自 PYFA：齐射是**整个纵队**的值（含纵队规模与技能），
 * HP 用单架值 × 纵队规模得到血池；输出按 D-25 线性折算。
 */
export function fighterSquadron(row: FighterRow, index: number): FighterSquadron {
  const each =
    num(row.hpEach.shield, 0) + num(row.hpEach.armor, 0) + num(row.hpEach.hull, 0);
  const size = Math.max(1, row.squadronSize || 1);
  const hpPoolMax = Math.max(1, each * size);
  return {
    id: `f:${row.typeId}:${index}`,
    typeId: row.typeId,
    name: row.name,
    squadronSize: size,
    isLight: row.isLight,
    tubes: Math.max(1, row.count || 1),
    hpPoolMax,
    hpPool: hpPoolMax,
    outputRatio: 1,
    abilities: (row.abilities ?? []).map((a) => ({
      effect: a.effect,
      volley: {
        em: num(a.volley?.em, 0),
        thermal: num(a.volley?.thermal, 0),
        kinetic: num(a.volley?.kinetic, 0),
        explosive: num(a.volley?.explosive, 0),
      },
      cycleMs: Math.max(1, num(a.cycleMs, 1000)),
      optimal: num(a.optimal, 0),
      falloff: num(a.falloff, 0),
      explosionRadius: num(a.explosionRadius, 0),
      explosionVelocity: num(a.explosionVelocity, 0),
      drf: num(a.drf, 1),
      drs: num(a.drs, 5.5),
    })),
    activeAbility: 0,
    maxVelocity: num(row.maxVelocity, 0),
    signatureRadius: num(row.signatureRadius, 40),
    orbitRange: num(row.orbitRange, 5000),
    cycleRemainingMs: 0,
    targetId: null,
    launched: true,
  };
}

/** 依据配装推断角色（后勤判定：是否装了远程维修/传电）。 */
export function inferRole(stats: FitStats, declared: Unit["role"]): Unit["role"] {
  if (declared === "structure" || declared === "capital") return declared;
  const hasLogi = stats.actives.some((a) =>
    a.kind === "remoteArmor" || a.kind === "remoteShield" ||
    a.kind === "remoteHull" || a.kind === "capTransfer");
  return hasLogi ? "logi" : declared;
}

export interface ApplyStatsOptions {
  /**
   * 保留**运行期状态**：开火开关、冷却剩余、锁定目标、组的血量与输出比例。
   *
   * ★ 指挥脉冲按位置生效 —— 单位进出脉冲范围时属性表会切换，
   *   那次切换**绝不能**把它的开火/冷却/组血量清掉（否则一进范围就"重置"了）。
   * 而"玩家手动改模块状态"（`refreshStats`）走默认路径，行为保持不变。
   */
  preserveRuntime?: boolean;
}

/**
 * 应用一份属性表到单位（首次装配与运行中 state 变化都走这里）。
 * 注意：**HP 按比例保留**（重算不改变已受伤的比例关系）。
 */
export function applyStats(u: Unit, stats: FitStats, opts: ApplyStatsOptions = {}): void {
  const a = stats.attrs;
  const prevMax = u.maxHp;
  const nextMax = {
    shield: Math.max(1, num(a.hp.shield, 1)),
    armor: Math.max(1, num(a.hp.armor, 1)),
    hull: Math.max(1, num(a.hp.hull, 1)),
  };
  const ratio = {
    shield: prevMax.shield > 0 ? u.hp.shield / prevMax.shield : 1,
    armor: prevMax.armor > 0 ? u.hp.armor / prevMax.armor : 1,
    hull: prevMax.hull > 0 ? u.hp.hull / prevMax.hull : 1,
  };
  u.stats = stats;
  u.maxHp = nextMax;
  u.hp = {
    shield: Math.min(nextMax.shield, nextMax.shield * ratio.shield),
    armor: Math.min(nextMax.armor, nextMax.armor * ratio.armor),
    hull: Math.min(nextMax.hull, nextMax.hull * ratio.hull),
  };
  const capMax = Math.max(1, num(a.cap.capacity, 1));
  const capRatio = u.capMax > 0 ? u.cap / u.capMax : 1;
  u.capMax = capMax;
  u.cap = Math.min(capMax, capMax * capRatio);
  u.capRechargeMs = Math.max(1000, num(a.cap.rechargeRate, 1_000_000));
  u.maxVelocity = Math.max(0, num(a.nav.maxVelocity, 0));
  u.alignTime = num(a.alignTime, 0) || alignSeconds(num(a.nav.mass, 1), num(a.nav.agility, 0.1));
  const oldWeapons = u.weapons;
  const oldActives = u.actives;
  const oldDrones = u.drones;
  const oldFighters = u.fighters;

  u.weapons = stats.weapons.flatMap(weaponInstances);
  u.actives = stats.actives.map((row, i) => activeInstance(row, i));
  u.activeInputIndex = stats.actives.map((row) => row.inputIndex ?? -1);
  u.drones = stats.drones.map((row, i) => droneGroup(row, i));
  // 铁骑：一个发射管 = 一个纵队（D-27）
  u.fighters = (stats.fighters ?? []).map((row, i) => fighterSquadron(row, i));
  // 组出仓时从母舰所在位置出发（此后由 groupMovement 自行机动、环绕目标）
  for (const g of u.drones) {
    g.pos = { x: u.pos.x, y: u.pos.y };
    g.vel = { x: 0, y: 0 };
  }
  for (const g of u.fighters) {
    g.pos = { x: u.pos.x, y: u.pos.y };
    g.vel = { x: 0, y: 0 };
  }

  // ★ 跳刀的再启动冷却必须**无条件**跨重算保留 —— 它不属于"是否手动重置循环"的语义。
  //   若只在 preserveRuntime 时搬，那么任何一次手动 toggleModule（走非保留路径）
  //   都会把冷却清零，导致跳刀可以连续瞬移。其余 kind 该字段恒为 0，无副作用。
  for (let i = 0; i < u.actives.length; i++) {
    const o = oldActives[i];
    if (!o) continue;
    u.actives[i].cooldownRemainingMs = o.cooldownRemainingMs;
  }

  // 属性表的行序与配装一一对应，因此可以**按下标**把运行期状态搬过来
  if (opts.preserveRuntime) {
    for (let i = 0; i < u.weapons.length; i++) {
      const o = oldWeapons[i];
      if (!o) continue;
      u.weapons[i].on = o.on;
      u.weapons[i].cycleRemainingMs = o.cycleRemainingMs;
    }
    for (let i = 0; i < u.actives.length; i++) {
      const o = oldActives[i];
      if (!o) continue;
      const n = u.actives[i];
      n.on = o.on;
      n.pendingOff = o.pendingOff;
      n.cycleRemainingMs = o.cycleRemainingMs;
      n.targetId = o.targetId;
      n.reactDelayMs = o.reactDelayMs;
    }
    for (let i = 0; i < u.drones.length; i++) {
      const o = oldDrones[i];
      if (!o) continue;
      const n = u.drones[i];
      n.hpPool = o.hpPool;
      n.outputRatio = o.outputRatio;
      n.cycleRemainingMs = o.cycleRemainingMs;
      n.targetId = o.targetId;
      n.launched = o.launched;
      n.pos = { ...o.pos };
      n.vel = { ...o.vel };
    }
    for (let i = 0; i < u.fighters.length; i++) {
      const o = oldFighters[i];
      if (!o) continue;
      const n = u.fighters[i];
      n.hpPool = o.hpPool;
      n.outputRatio = o.outputRatio;
      n.cycleRemainingMs = o.cycleRemainingMs;
      n.targetId = o.targetId;
      n.launched = o.launched;
      n.activeAbility = o.activeAbility;
      n.pos = { ...o.pos };
      n.vel = { ...o.vel };
    }
  }
  // 吨位图标与帝国势力：来自 SDE 的 group / raceID（**不是**对船名做正则猜测）
  u.iconClass = iconClassOf(stats.ship?.groupName ?? null, u.shipName);
  u.empire = typeof stats.ship?.raceId === "number" && stats.ship.raceId > 0 ? stats.ship.raceId : null;
  u.jump = jumpCapability(stats);
}

/** 由蓝图 + 属性表创建单位（初始满血、满电）。 */
export function assembleUnit(bp: UnitBlueprint, stats: FitStats): Unit {
  const u: Unit = {
    id: bp.unitId,
    name: bp.name,
    shipName: bp.shipName,
    iconClass: "unknown",
    empire: null,
    sideId: bp.sideId,
    fleetId: bp.fleetId,
    wingId: bp.wingId,
    squadId: bp.squadId,
    role: bp.role,
    alive: true,

    fitFingerprint: bp.fitFingerprint,
    stateBitmap: "",
    envKey: "",
    moduleStates: bp.modules.map((m) => m.state ?? "online"),
    stats,
    maxHp: { shield: 1, armor: 1, hull: 1 },

    pos: { ...bp.pos },
    vel: { x: 0, y: 0 },
    maxVelocity: 0,
    alignTime: 1,

    hp: { shield: 1, armor: 1, hull: 1 },
    cap: 1,
    capMax: 1,
    capRechargeMs: 1_000_000,

    targetId: null,
    targetKind: "unit",
    targetGroupId: null,
    locked: false,
    lockProgressMs: 0,

    doctrine: bp.doctrine ?? "focus",
    order: bp.order ?? { type: "hold" },

    weapons: [],
    actives: [],
    activeInputIndex: [],
    drones: [] as DroneGroup[],
    fighters: [] as FighterSquadron[],
    effects: [],

    warpingOut: false,
    warpRemainingMs: 0,
    warpDest: null,
    evacuated: false,

    jump: null,
    arrivalDelayMs: 0,
    pendingOrder: null,

    damageDealt: 0,
    damageTaken: 0,
  };
  u.role = inferRole(stats, bp.role);
  applyStats(u, stats);
  // 初始状态即为满血满电（applyStats 的比例换算在此为 1:1）
  u.hp = { ...u.maxHp };
  u.cap = u.capMax;
  return u;
}

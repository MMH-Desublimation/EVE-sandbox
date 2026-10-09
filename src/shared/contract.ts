/**
 * 属性契约（对应交接文档第 5 章）。
 *
 * 边界重申：契约只包含「叠加结果」与「原始参数」，不包含「应用后 DPS」。
 * 字段名以 PYFA 实测为准（见 docs/第4章-PYFA集成协议-冻结稿.md §4.5）。
 */

/** 四类伤害顺序固定为 EM / 热能 / 动能 / 爆炸。 */
export type Res4 = readonly [number, number, number, number];

export type DamageType = "em" | "thermal" | "kinetic" | "explosive";

/** 模块状态（映射 eos.const.FittingModuleState）。 */
export type ModuleState = "offline" | "online" | "active" | "overload";

/** 主动模块的语义 kind（契约 §5.6）。 */
export type ActiveKind =
  | "shieldHardener" | "armorHardener" | "trackingComputer" | "missileGuidanceComputer" | "sensorBooster"
  | "shieldBooster" | "armorRepairer" | "hullRepairer"
  | "remoteShield" | "remoteArmor" | "remoteHull" | "capTransfer"
  | "capBooster" | "prop" | "siege" | "triage" | "commandBurst"
  | "web" | "grappler" | "painter" | "damp" | "ecm" | "ecmBurst"
  | "trackDisrupt" | "guidanceDisrupt" | "neut" | "nos"
  | "smartbomb" | "bubble" | "interdictionLauncher" | "warpDisrupt" | "warpScramble"
  /** 微型跳跃引擎（跳刀）：先运转一个周期，再沿移动方向瞬移一段距离，然后进冷却。 */
  | "microJump";

/** A. 单位静态属性。 */
export interface ShipAttrs {
  hp: { shield: number; armor: number; hull: number };
  /** 共振值（越小抗性越高），顺序 EM/TH/KIN/EXP。 */
  res: { shield: Res4; armor: Res4; hull: Res4 };
  cap: { capacity: number; rechargeRate: number };
  shieldRechargeRate: number | null;
  scan: {
    maxRange: number;
    resolution: number;
    maxLocks: number;
    /** 传感器强度，顺序 GRAV / LADAR / MAGNETO / RADAR。 */
    sensor: Res4;
  };
  nav: {
    maxVelocity: number;
    agility: number;
    mass: number;
    signatureRadius: number;
    warpSpeedMultiplier: number | null;
    baseWarpSpeed: number | null;
    /**
     * **跃迁稳定系数**（SDE `warpCoreStability`，PYFA 已含舰船技能加成）。
     * 用于判定"能否跃迁/旗舰跳"：有效系数 = 本值 − 敌方扰频/扰断点数；
     * **≥ 1 才允许**。缺席/为 0 时按 1 处理（普通舰船：一个扰频/扰断即可拦住）。
     */
    warpCoreStability?: number | null;
  };
  drone: { bay: number; bandwidth: number };
  slots: {
    hi: number; med: number; lo: number; rig: number;
    turretMax: number | null; launcherMax: number | null;
    turretLeft: number | null; launcherLeft: number | null;
  };
  resource: { cpu: number; power: number };
  /** 引擎侧派生：-ln(0.25)·mass·agility/1e6（秒）。 */
  alignTime: number | null;
  /**
   * 旗舰跳能力。普通舰船三项皆为 null（→ 引擎判定为"不具备旗舰跳"）。
   * 注意：能跳 ≠ 允许跳，后者由引擎按反跳/干扰条件判定（见 jumpAllowed）。
   */
  jump?: { range: number | null; activationCost: number | null; durationMs: number | null } | null;
}

/** B. 武器属性（按 typeId + 弹药 归组，count 表示同型门数）。 */
export interface WeaponRow {
  typeId: number;
  name: string;
  kind: "turret" | "launcher" | "drone" | "fighter";
  state: ModuleState;
  count: number;
  damageMultiplier: number | null;
  /** 循环时间（ms）。 */
  rof: number | null;
  optimal: number | null;
  falloff: number | null;
  tracking: number | null;
  sigResolution: number | null;
  aoeCloudSize: number | null;
  aoeVelocity: number | null;
  /** 爆炸伤害削减系数（DRF），导弹应用率用。 */
  aoeDamageReduction: number | null;
  missileVelocity: number | null;
  /** 导弹飞行时间（ms，弹药 explosionDelay）。 */
  missileFlightMs: number | null;
  capNeed: number | null;
  chargeTypeId: number | null;
  chargeName: string | null;
  dmgTypes: Record<DamageType, number | null>;
  /** 单轮齐射（四类伤害之和，单门）。 */
  volley: number | null;
  /** 由 volley / (rof/1000) × count 计算；非 PYFA 的 getDps()（见 §4.7 坑点 4）。 */
  dps: number | null;
  /** 该行来自请求中 modules 数组的下标（用于把 UI 的 kind+实例序号 映射回配装）。 */
  inputIndex: number | null;
}

/** C. 主动模块。 */
export interface ActiveRow {
  typeId: number;
  name: string;
  /** 弹药名（指挥脉冲波靠它区分"装甲激能 / 装甲强化…"）。 */
  chargeName?: string | null;
  kind: ActiveKind | "other";
  state: ModuleState;
  duration: number | null;
  capNeed: number | null;
  optimal: number | null;
  falloff: number | null;
  /** 效果量（修量 / 传电量 / 毁电量 / 网强度…），键名依语义而定。 */
  effectAmounts: Record<string, number>;
  /**
   * 立体炸弹：作用半径（`empFieldRange`）与四类伤害（`*Damage`），仅 smartbomb 有。
   * 例：Large EMP Smartbomb II → 范围 6000m、emDamage 300（其余三类为 0）。
   */
  smartbomb?: { range: number | null; dmg: Record<DamageType, number | null> } | null;
  /**
   * 微型跳跃引擎（跳刀），仅 microJump 有。
   *
   * · `distanceM`：跃迁距离。普通/中型 SDE 无 `mjdJumpRange`（标准 **100 km**），
   *   旗舰型给 250000；oracle 对缺值统一兜底 100 km。
   * · `cooldownMs`：再启动冷却（SDE `moduleReactivationDelay`，大小型 180 s）。
   *   起跳后必须先走完这段冷却，才能再次启用。
   *
   * 例：Large Micro Jump Drive → distanceM 100000、cooldownMs 180000，duration 12000。
   */
  microJump?: { distanceM: number | null; cooldownMs: number | null } | null;
  /** 该行来自请求中 modules 数组的下标。 */
  inputIndex: number | null;
}

/** 被动模块（无循环、无效果量的改装/加成件，如散热槽）。 */
export interface PassiveRow {
  typeId: number;
  name: string;
  state: ModuleState;
  inputIndex: number | null;
}

/** 无人机 / 铁骑（按 typeId 归组）。 */
export interface DroneRow {
  typeId: number;
  name: string;
  count: number;
  damageMultiplier: number | null;
  rof: number | null;
  optimal: number | null;
  falloff: number | null;
  tracking: number | null;
  optimalSigRadius: number | null;
  dmgTypes: Record<DamageType, number | null>;
  hpEach: { shield: number | null; armor: number | null; hull: number | null };
  signatureRadius: number | null;
  maxVelocity: number | null;
  bandwidthUsed: number | null;
}

/** 铁骑的一个能力（攻击 / 远程导弹）。一个纵队可带多个能力，按射程取用。 */
export interface FighterAbilityRow {
  /** PYFA 的效果名，如 `fighterAbilityAttackM` / `fighterAbilityMissiles`。 */
  effect: string;
  /** 该能力的齐射（四类伤害）——**已是整个纵队**的值（含纵队规模与技能）。 */
  volley: Record<DamageType, number>;
  /** 循环时间（ms）。 */
  cycleMs: number;
  optimal: number | null;
  falloff: number | null;
  /** 爆炸半径/速度与 DRF/DRS：铁骑伤害按**导弹**公式应用（见 §6.6）。 */
  explosionRadius: number | null;
  explosionVelocity: number | null;
  drf: number | null;
  drs: number | null;
}

/** 铁骑纵队（一个发射管 = 一个纵队，D-27）。 */
export interface FighterRow {
  typeId: number;
  name: string;
  /** 纵队规模（一架纵队含几架铁骑；轻/重型 6，建筑铁骑 9）。 */
  squadronSize: number;
  isLight: boolean;
  /** 单架铁骑的 HP（纵队血池 = 该值 × squadronSize）。 */
  hpEach: { shield: number; armor: number; hull: number };
  maxVelocity: number | null;
  signatureRadius: number | null;
  /** 铁骑的环绕距离。 */
  orbitRange: number | null;
  /** 真正能造成伤害的能力（微型跃迁等零伤害能力已被剔除）。 */
  abilities: FighterAbilityRow[];
  /** 请求里该型号的发射管数。 */
  count: number;
  inputIndex: number | null;
}

/** 实际生效的脑插（**没有配置就没有**，用于溯源与 UI 展示）。 */
export interface ImplantRow {
  slot: number | null;
  typeId: number;
  name: string;
  /** 套装名，如「高级极乐」；单件也是套装的一员。 */
  set: string | null;
}

/** 未能识别的条目（开发期警告 / 测试报告）。 */
export interface UnhandledRow {
  typeId?: number;
  name?: string;
  spec?: unknown;
  reason: string;
}

/** 舰船身份：来自 SDE 的 category / group / race（**不是**对船名的正则猜测）。 */
export interface ShipInfo {
  typeId: number | null;
  name: string | null;
  groupId: number | null;
  /** SDE group 名，如 `Battleship`、`Black Ops`、`Force Auxiliary`。 */
  groupName: string | null;
  /** SDE category 名，如 `Ship`、`Structure`。 */
  categoryName: string | null;
  /** SDE raceID（1=Caldari 2=Minmatar 4=Amarr 8=Gallente）；非舰船多为 0/null。 */
  raceId: number | null;
}

/** 一笔配装的完整属性表。 */
export interface FitStats {
  ship?: ShipInfo;
  attrs: ShipAttrs;
  weapons: WeaponRow[];
  actives: ActiveRow[];
  passives: PassiveRow[];
  drones: DroneRow[];
  /** 铁骑纵队（一个发射管 = 一个纵队）。 */
  fighters: FighterRow[];
  /** 实际生效的脑插（配置里没有则为空数组）。 */
  implants?: ImplantRow[];
  /** 实际生效的环境加成（指挥脉冲）。 */
  env?: { commandLinks: Array<{ linkType: string; strength: number; mindlink: boolean }> };
  unhandled: UnhandledRow[];
}

/* -------------------------------------------------------------------------- */
/* 属性缓存索引键（契约 §5.1）                                                  */
/* -------------------------------------------------------------------------- */

export interface AttrKey {
  /** 配装指纹：归一化配装内容的哈希。 */
  fitFingerprint: string;
  /** 可开关模块的开/关组合（按固定顺序编码）。 */
  stateBitmap: string;
  /** 环境加成键（指挥脉冲等）；本期恒为 ""。 */
  envKey: string;
}

export function attrKeyString(k: AttrKey): string {
  return `${k.fitFingerprint}|${k.stateBitmap}|${k.envKey}`;
}

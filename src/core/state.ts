/**
 * 引擎数据模型（交接文档 §7）。
 *
 * 设计铁律：**BattleState 是纯数据**（无函数、无类实例、无句柄），
 * 因此可以 structuredClone 快照、可以 JSON 存档、可以逐 tick 对比。
 * 随机数不落状态（见 deterministic.ts），进一步保证快照/重放等价。
 */
import type { ActiveKind, DamageType, FitStats, ModuleState } from "../shared/contract.ts";
import type { IconClass } from "../shared/hullclass.ts";
import type { DroneSpec, FighterSpec, ModuleSpec } from "../shared/protocol.ts";

export interface Vec2 {
  x: number;
  y: number;
}

/** 势力：固定红蓝双方（D-19）。0 = 蓝，1 = 红。 */
/**
 * 势力 id。
 *
 * ★ 从 `0 | 1` 放宽为 `number`：用户要求「战场编成」可**新增势力**（不止红蓝两方）。
 *   引擎的敌我判定一律是 `sideId !== sideId`（"非我即敌"），因此天然支持多势力混战；
 *   只有"结束条件/战报"过去写死了两方，已在 sim.ts 相应泛化。
 */
export type SideId = number;

/* -------------------------------------------------------------------------- */
/* 单位构成                                                                    */
/* -------------------------------------------------------------------------- */

/** 一门武器的实例（同型号装 8 门 → 8 条实例，各自独立冷却）。 */
export interface WeaponInstance {
  id: string;
  typeId: number;
  name: string;
  kind: "turret" | "launcher";
  damageMultiplier: number;
  /** 循环时间（ms）。 */
  rofMs: number;
  optimal: number;
  falloff: number;
  tracking: number;
  sigResolution: number;
  aoeCloudSize: number;
  aoeVelocity: number;
  /** 爆炸伤害削减系数 DRF。 */
  aoeDamageReduction: number;
  missileVelocity: number;
  missileFlightMs: number;
  capNeed: number;
  chargeTypeId: number | null;
  chargeName: string | null;
  dmgTypes: Record<DamageType, number>;
  on: boolean;
  /** 冷却剩余（ms）；0 表示可开火。 */
  cycleRemainingMs: number;
}

/**
 * 立体炸弹的作用参数。
 *
 * ★ 立体炸弹对**范围内的所有实体**造成伤害（含铁骑/无人机，也含友军 —— 这是 EVE 行为）。
 */
export interface SmartbombProfile {
  /** 作用半径（m），来自 SDE 的 `empFieldRange`。 */
  rangeM: number;
  /** 单次引爆的四类伤害。 */
  dmg: Record<DamageType, number>;
}

/** 一个主动模块的实例（同型号装 2 个 → 2 条实例，各自独立启停）。 */
export interface ActiveInstance {
  id: string;
  typeId: number;
  name: string;
  /** 弹药名（指挥脉冲波靠它区分"装甲激能 / 装甲强化…"）。 */
  chargeName: string | null;
  kind: ActiveKind | "other";
  cycleMs: number;
  capNeed: number;
  optimal: number;
  falloff: number;
  effectAmounts: Record<string, number>;
  /** 立体炸弹参数（仅 `kind === "smartbomb"` 有）。 */
  smartbomb: SmartbombProfile | null;
  /** 跳刀参数（仅 `kind === "microJump"` 有）：跃迁距离与再启动冷却。 */
  microJump: MicroJumpProfile | null;
  /** 当前是否激活。 */
  on: boolean;
  /** 点"停止"后：本轮循环走完才真正关闭。 */
  pendingOff: boolean;
  cycleRemainingMs: number;
  /**
   * 每个模块实例**各自持有目标**（上一版 B4 的根因：单位级共享目标）。
   */
  targetId: string | null;
  /** 后勤模块的反应延迟剩余（ms）。 */
  reactDelayMs: number;
  /**
   * 跳刀（`microJump`）的**再启动冷却剩余**（ms）。
   *
   * > 0 表示该模块刚跃迁过，尚未冷却完毕，**不允许再次启用**
   * （见 commands.ts 的 toggleModule 拦截）。其余 kind 恒为 0。
   */
  cooldownRemainingMs: number;
}

/** 跳刀（微型跳跃引擎）参数。 */
export interface MicroJumpProfile {
  /** 跃迁距离（米）。普通型标准 100 km；旗舰型 250 km。 */
  distanceM: number;
  /** 再启动冷却（毫秒）：起跳后需等这么久才能再次启用。 */
  cooldownMs: number;
}

/** 无人机组：HP 与输出按「组」结算（D-24 / D-25）。 */
export interface DroneGroup {
  id: string;
  typeId: number;
  name: string;
  totalCount: number;
  hpPoolMax: number;
  hpPool: number;
  /** 线性折算：当前输出 = 满编输出 × outputRatio。 */
  outputRatio: number;
  damageMultiplier: number;
  rofMs: number;
  optimal: number;
  falloff: number;
  tracking: number;
  optimalSigRadius: number;
  /** 组自身的信号半径（被攻击时用；来自 PYFA 的无人机 sig）。 */
  signatureRadius: number;
  dmgTypes: Record<DamageType, number>;
  maxVelocity: number;
  cycleRemainingMs: number;
  targetId: string | null;
  /** 是否已投放（出击/召回）。 */
  launched: boolean;
  /**
   * 出仓后的**自身位置**（不再等同于母舰位置）。
   *
   * ★ 用户规则：无人机/铁骑出仓后自主飞向目标，抵达后**按最佳射程平速环绕**攻击。
   *   射程判定、命中判定与沙盘显示都用这个位置，而不是母舰的位置。
   */
  pos: Vec2;
  /** 当前速度向量（环绕时为切向速度）。 */
  vel: Vec2;
}

/** 铁骑的一个能力（贴身攻击 / 远程导弹）。 */
export interface FighterAbility {
  effect: string;
  /** **整个纵队**的齐射（PYFA 已含纵队规模与技能）。 */
  volley: Record<DamageType, number>;
  cycleMs: number;
  optimal: number;
  falloff: number;
  explosionRadius: number;
  explosionVelocity: number;
  /** 爆炸伤害削减系数（DRF）与灵敏度（DRS）——铁骑伤害按导弹公式应用。 */
  drf: number;
  drs: number;
}

/**
 * 铁骑纵队：**一个发射管 = 一个纵队**（D-27），同样按「组」结算（D-24/25/26）。
 *
 * · HP 按组：血池 = 单架 HP × 纵队规模，受伤按比例线性折算输出（D-25）
 * · 不能逐架点名（D-26）：只能对整组施加火力
 * · 一个纵队可带多个能力（贴身攻击 / 远程导弹），**按距离取用**
 */
export interface FighterSquadron {
  id: string;
  typeId: number;
  name: string;
  /** 纵队规模（一架纵队含几架铁骑；轻/重型 6，建筑铁骑 9）。 */
  squadronSize: number;
  isLight: boolean;
  /** 发射管数（= 装备的纵队数）。 */
  tubes: number;
  hpPoolMax: number;
  hpPool: number;
  /** D-25：当前输出 = 满编输出 × outputRatio（= hpPool / hpPoolMax）。 */
  outputRatio: number;
  abilities: FighterAbility[];
  /** 当前选用的能力下标（按距离选）。 */
  activeAbility: number;
  maxVelocity: number;
  signatureRadius: number;
  orbitRange: number;
  cycleRemainingMs: number;
  targetId: string | null;
  launched: boolean;
  /**
   * 出仓后的**自身位置**（不再等同于母舰位置）。
   *
   * ★ 用户规则：铁骑出仓后自主飞向目标，抵达后**按最佳射程平速环绕**攻击
   *   （`orbitRange` 就是环绕半径，速度恒为 `maxVelocity`）。
   */
  pos: Vec2;
  /** 当前速度向量（环绕时为切向速度）。 */
  vel: Vec2;
}

/** 时效效果（电子战 / 增益），到期自动移除。 */
export interface ActiveEffect {
  kind: string;
  /** 来源单位 id（用于铺开/集中判定与展示）。 */
  sourceId: string;
  /** 过期 tick（含）。 */
  untilTick: number;
  /** 强度（网 = 速度倍率；标记 = 信号倍率；扰断 = 追踪倍率；毁电 = 每 tick 电量）。 */
  amount: number;
  layer?: "shield" | "armor" | "hull" | "cap" | "scan" | "tracking";
}

export type OrderType =
  | "hold" | "stop" | "approach" | "orbit" | "keepAtRange" | "align" | "mjd" | "warpOut"
  /** 旗舰跳到指定坐标（增援入场 / 撤场前的跳跃）。 */
  | "jump"
  /**
   * **跃迁至**：先对齐（起跳时间 alignTime），再按跃迁速度飞抵落点。
   * 落点 = `targetId` 指向目标（或 `to` 坐标）**偏移 `range` 米**处；
   * 与"平速跑过去"的区别是：**按 AU/s 的跃迁速度旅行**，远距离几乎瞬间到达。
   */
  | "warp";

export interface Order {
  type: OrderType;
  /** approach/orbit/keepAtRange 的目标单位 id。 */
  targetId?: string | null;
  /** orbit / keepAtRange 的距离（m）。 */
  range?: number;
  /** 目标坐标（无目标单位时的坐标指令）。 */
  to?: Vec2 | null;
}

/**
 * 交火方式（§8.4 + 用户补充规则）。
 *
 * · `focus`        集中火力：保持主目标（无则取最近）
 * · `free`         自由开火：各自打最近敌人
 * · `auto`         自动攻击：同 focus，但更主动接敌
 * · `antiFighter`  **集火舰载机**：优先打**射程内**的敌方铁骑纵队；
 *                  射程内没有敌铁骑时，才回退到普通优先级（非舰载机单位）
 * · `passive`      **被动待命**：不自动选目标、不自动移动，完全等用户下达成指令
 *                  （选中目标后才开火，下达成机动指令后才走位）
 */
export type Doctrine = "focus" | "free" | "auto" | "antiFighter" | "passive";

/**
 * 交火目标类型。
 *
 * ★ 规则（用户明确要求）：
 *   - 默认**只打"单位"**（舰船/建筑）；铁骑必须显式被选中或走「集火舰载机」才打；
 *   - **无人机永不主动选择** —— 它只被立体炸弹这类范围伤害波及。
 */
export type TargetKind = "unit" | "fighter" | "drone";

/**
 * 单位级配装蓝图（§7.2 铁律：配装按**单位**定义，绝不用舰队级 fit 套用到全队）。
 * 属于纯数据，随 BattleState 一起快照，重放时天然一致。
 */
export interface UnitBlueprint {
  unitId: string;
  name: string;
  shipName: string;
  shipTypeId: number;
  sideId: SideId;
  fleetId: number;
  wingId: number;
  squadId: number;
  role: Unit["role"];
  /** 单位级配装（含初始 state 与弹药）。 */
  modules: ModuleSpec[];
  drones: DroneSpec[];
  fighters: FighterSpec[];
  fitFingerprint: string;
  doctrine?: Doctrine;
  order?: Order;
  pos: Vec2;
}

/** 可召唤的增援单位（配装 + **已预热**的属性表）。 */
export interface ReserveEntry {
  bp: UnitBlueprint;
  stats: FitStats;
}

export interface Unit {
  id: string;
  name: string;
  /** 显示用的舰名/吨位。 */
  shipName: string;
  /** 吨位图标类别（由 SDE group 判定，见 shared/hullclass.ts）。 */
  iconClass: IconClass;
  /** 帝国势力 raceID（1=Caldari 2=Minmatar 4=Amarr 8=Gallente）；非舰船为 null。 */
  empire: number | null;
  sideId: SideId;
  fleetId: number;
  wingId: number;
  squadId: number;
  role: "line" | "logi" | "capital" | "structure";
  alive: boolean;

  /** 配装指纹（属性缓存的键之一）。 */
  fitFingerprint: string;
  /** 当前状态位图（属性缓存的键之一）。 */
  stateBitmap: string;
  /**
   * 当前生效的**环境键**（脑插 + 指挥脉冲）；属性缓存的键之一。
   *
   * ★ 指挥脉冲按位置生效，所以同一个单位在不同位置可能对应不同属性表，
   *   这个字段记录它"此刻用的是哪一套"。
   */
  envKey: string;
  /** 每个配装模块的当前 state（与 blueprint.modules 一一对应），是状态位图的真源。 */
  moduleStates: ModuleState[];
  /** 当前生效的属性表（**PYFA 在 stateBitmap 下的计算结果**）。 */
  stats: FitStats;
  /** 满血值，便于还原与显示。 */
  maxHp: { shield: number; armor: number; hull: number };

  pos: Vec2;
  vel: Vec2;
  /** 当前速度上限（m/s）。 */
  maxVelocity: number;
  /** 起跳对齐时间（秒）。 */
  alignTime: number;

  hp: { shield: number; armor: number; hull: number };
  cap: number;
  capMax: number;
  /** 电容回充时间（ms）。 */
  capRechargeMs: number;

  /** 舰船固有的锁定距离与分辨率（用于锁定判定）。 */
  targetId: string | null;
  /** 交火目标类型（unit / fighter / drone）。 */
  targetKind: TargetKind;
  /** 目标组 id（`targetKind !== "unit"` 时指向该单位挂载的铁骑/无人机组）。 */
  targetGroupId: string | null;
  locked: boolean;
  lockProgressMs: number;

  doctrine: Doctrine;
  order: Order;

  weapons: WeaponInstance[];
  actives: ActiveInstance[];
  /** actives[i] 对应 blueprint.modules 的下标（用于 kind+实例序号 → 配装模块 的映射）。 */
  activeInputIndex: number[];
  drones: DroneGroup[];
  fighters: FighterSquadron[];
  effects: ActiveEffect[];

  /** 是否正在跃迁离场（撤离）；到达后 alive 置 false 且 evacuated=true。 */
  warpingOut: boolean;
  warpRemainingMs: number;
  /** 正在进行的一次跃迁的落点（`order.type === "warp"` 时有效）；到达后瞬移到此处。 */
  warpDest: Vec2 | null;
  evacuated: boolean;

  /**
   * 旗舰跳能力（D-31 / 「增援」功能）。`null` = 不具备旗舰跳。
   * 具备 = 船本身有跳跃引擎（旗舰/跳跃货舰），且**当前允许旗舰跳**
   * （未被目标星系的质量/干扰条件否决，见 jumpAllowed 的判定）。
   */
  jump: JumpCapability | null;

  /**
   * 增援入场的延迟（ms）。星门增援要先"过门"，旗舰跳增援则是瞬到（延迟为 0）。
   * > 0 时该单位不能机动、不能开火、不参与被锁定；归零后执行 `pendingOrder`。
   */
  arrivalDelayMs: number;
  /** 入场延迟结束后要执行的机动指令。 */
  pendingOrder: Order | null;

  /** 统计：造成/承受伤害。 */
  damageDealt: number;
  damageTaken: number;
}

/** 旗舰跳能力与冷却。 */
export interface JumpCapability {
  /**
   * 跳跃距离上限（**米**）。
   * ★ 由 SDE 的 `jumpDriveRange` 换算而来 —— 它的单位是**光年**（凤凰 3.5 光年），
   *   不是米。直接当米用会把跳跃距离算成 3.5 m。
   */
  rangeM: number;
  /** 原始值（光年），供 UI 显示"跳跃距离 3.5 光年"。 */
  rangeLy: number;
  /** 跳跃冷却（ms）。 */
  cooldownMs: number;
  /** 本次跳跃后的剩余冷却（ms）；> 0 时不能再跳。 */
  remainingMs: number;
  /** 是否被外部条件允许（场景/地物声明）。 */
  allowed: boolean;
}

/* -------------------------------------------------------------------------- */
/* 在途投射物（导弹）                                                          */
/* -------------------------------------------------------------------------- */

export interface Projectile {
  id: string;
  ownerUnitId: string;
  weaponId: string;
  targetUnitId: string;
  /** 目标为"组"时（打铁骑/无人机）指向该组；否则 null。 */
  targetGroupId?: string | null;
  targetGroupKind?: "fighter" | "drone" | null;
  launchTick: number;
  arriveTick: number;
  dmg: Record<DamageType, number>;
  /** 可被立体炸弹拦截（D-22）。 */
  canBeIntercepted: boolean;
  status: "inFlight" | "hit" | "expired" | "intercepted";
}

/* -------------------------------------------------------------------------- */
/* 事件流与战报                                                                */
/* -------------------------------------------------------------------------- */

export type BattleEventType =
  | "fire" | "miss" | "hit" | "kill" | "lock" | "logi" | "capTransfer"
  | "neut" | "nos" | "ewar" | "warp" | "evacuate" | "command" | "expire"
  /** 增援入场（星门 / 旗舰跳）。 */
  | "reinforce" | "jump"
  /** 铁骑/无人机投放入场。 */
  | "launch"
  /** 指挥脉冲铺开。 */
  | "burst"
  /** 跳刀（微型跳跃引擎）完成跃迁。 */
  | "microJump";

export interface BattleEvent {
  tick: number;
  type: BattleEventType;
  sideId?: SideId;
  unitId?: string;
  unitName?: string;
  shipName?: string;
  targetId?: string;
  targetName?: string;
  /** 伤害量 / 修量 / 电量 等。 */
  amount?: number;
  detail?: string;
}

/* -------------------------------------------------------------------------- */
/* 全局状态                                                                    */
/* -------------------------------------------------------------------------- */

export type RunMode = "expected" | "stochastic";

/** 引擎参数（可修订；集中定义，避免散落各处）。 */
export interface EngineSettings {
  /** 被动护盾回充（EVE 默认开启）。关闭后便于"解析解"手算校验。 */
  passiveShieldRegen: boolean;
  /** 被动电容回充。 */
  passiveCapRecharge: boolean;
  /** 后勤模块发现需求后的反应延迟上限（ms，0 = 无延迟）。 */
  logiReactDelayMaxMs: number;
  /**
   * 是否记录"开火/未命中/命中"逐条事件。
   * 默认关闭：2000 单位 × 多门武器时这些事件量极大（每 tick 数千条），
   * 会把事件上限打爆并拖慢推演。伤害总量已由 damageDealt/damageTaken 统计。
   */
  verboseEvents: boolean;

  /** 旗舰跳：基础冷却（ms）。 */
  jumpCooldownMs: number;
  /** 旗舰跳：每次跳跃在冷却之上累加的疲劳（ms）。 */
  jumpFatigueIncrementMs: number;
  /** 旗舰跳：疲劳上限（ms）。 */
  jumpFatigueMaxMs: number;
  /** 被反跳（warpScramble / 拦截泡）时是否禁止旗舰跳（EVE 行为）。 */
  jumpBlockedWhenScrambled: boolean;
  /** 星门增援：从进场到开始向目标机动的过门延迟（ms）。 */
  gateArrivalDelayMs: number;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  passiveShieldRegen: true,
  passiveCapRecharge: true,
  logiReactDelayMaxMs: 3000,
  verboseEvents: false,
  jumpCooldownMs: 300_000,
  jumpFatigueIncrementMs: 60_000,
  jumpFatigueMaxMs: 1_800_000,
  jumpBlockedWhenScrambled: true,
  gateArrivalDelayMs: 6_000,
};

/* -------------------------------------------------------------------------- */
/* 地物（星门 / 空间站）                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 地物（§9.2）：星门、空间站等**不可装配、不可开火、不可摧毁**的坐标锚点。
 * 星门是「星门增援」的入场口：增援单位先落到星门，再跃迁/机动到目标位置。
 *
 * 注意：**玩家建筑（星城/铁壁）不是地物，而是单位**（§9.1：可装配、可开火、可被摧毁），
 * 用 `Unit.role === "structure"` 表示。
 */
export type CelestialKind = "stargate" | "station";

export interface Celestial {
  id: string;
  kind: CelestialKind;
  name: string;
  /** 归属（null = 中立）。 */
  sideId: SideId | null;
  pos: Vec2;
  /** 交互半径（m）：增援抵达判定与显示用。 */
  radiusM: number;
}

export interface BattleState {
  tick: number;
  seed: number;
  mode: RunMode;
  settings: EngineSettings;
  finished: boolean;
  winnerSideId: SideId | null;
  /** 场上次序（稳定，按 id 排序），保证逐 tick 迭代顺序确定。 */
  units: Unit[];
  /** 地物（星门 / 空间站）。 */
  celestials: Celestial[];
  /** 单位级配装蓝图（纯数据，随状态快照，重放天然一致）。 */
  blueprints: Record<string, UnitBlueprint>;
  /** id → units 数组下标。 */
  unitIndex: Record<string, number>;
  projectiles: Projectile[];
  events: BattleEvent[];
  /** 事件上限，超出后丢弃最旧的一批（避免无界增长）。 */
  maxEvents: number;
  /** 累计击杀（用于战报与验收断言）。 */
  kills: Array<{ tick: number; sideId: SideId; unitId: string; unitName: string; shipName: string; killerId?: string }>;
  /** 由引擎集中定义的 tick 内阶段顺序（交接文档 §6.3）。 */
  phaseOrder: string[];
  /** 指令生效记录（供 UI 显示"生效 tick"，D-37）。 */
  commandLog: Array<{ tick: number; action: string; target: string; note?: string }>;
}

export function emptyState(partial: Partial<BattleState> & { phaseOrder: string[] }): BattleState {
  return {
    tick: 0,
    seed: 0,
    mode: "expected",
    settings: { ...DEFAULT_ENGINE_SETTINGS },
    finished: false,
    winnerSideId: null,
    units: [],
    celestials: [],
    unitIndex: {},
    blueprints: {},
    projectiles: [],
    events: [],
    maxEvents: 8000,
    kills: [],
    commandLog: [],
    ...partial,
  };
}

/**
 * 判定单位是否可作为目标（存活、未撤离、且**已真正到场**）。
 * 增援单位在过门/落地延迟结束前仍在场外，因此不可被锁定、不参与结算。
 */
export function isTargetable(u: Unit): boolean {
  return u.alive && !u.evacuated && u.arrivalDelayMs <= 0;
}

/** 失效的模块状态（供 UI 与缓存键使用）。 */
export const MODULE_STATE_CODE: Record<ModuleState, number> = {
  offline: 0,
  online: 1,
  active: 2,
  overload: 3,
};

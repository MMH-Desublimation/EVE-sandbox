/**
 * UI ↔ Worker 协议。
 *
 * 原则（§3.1）：UI **只读状态、只发命令**，绝不直接修改引擎对象。
 * 帧数据是"展平后的只读视图"，Worker 负责把引擎状态投影成它。
 */
import type { BattleEvent } from "../core/state.ts";
import type { BattleConfig } from "../core/battle.ts";
import type { Command } from "../core/commands.ts";
import type { BranchInfo } from "../core/runner.ts";

/** 单位在沙盘上的最小视图。 */
/** 地物（星门 / 空间站）的沙盘视图。 */
export interface CelestialFrame {
  id: string;
  kind: string;
  name: string;
  sideId: number | null;
  x: number;
  y: number;
  radiusM: number;
}

/**
 * 单位挂载的「组」（铁骑纵队 / 无人机组）。
 *
 * ★ 用户要求：它们属于**实体**，在舰队交火列表里要**独立显示**
 *   （有自己的血量、信号半径、速度，可被选中作为目标或走"集火舰载机"）。
 */
export interface GroupFrame {
  id: string;
  kind: "fighter" | "drone";
  name: string;
  /** 剩余血量比例 0..1。 */
  hp: number;
  hpPool: number;
  hpPoolMax: number;
  /** 是否在场（未回收/未被消灭）。 */
  alive: boolean;
  /** 输出比例（D-25 线性折算）。 */
  outputRatio: number;
  /** 信号半径（被攻击时用）。 */
  signatureRadius: number;
  maxVelocity: number;
  /** 铁骑：环形管数 / 纵队规模；无人机：架数。 */
  tubes: number;
  size: number;
  /** 是否正被本单位锁定为目标。 */
  targeted: boolean;
  /** 组在场上的实际位置（出仓后自行机动、环绕目标）。 */
  x: number;
  y: number;
  /** 组的速度向量（m/s），同样用于渲染插值。 */
  vx: number;
  vy: number;
  /** 环绕半径（m）：铁骑用 orbitRange，无人机用最佳射程。 */
  orbitRange: number;
}

export interface UnitFrame {
  id: string;
  name: string;
  shipName: string;
  /** 吨位图标类别（由 SDE group 判定，见 shared/hullclass.ts）。 */
  icon: string;
  /** 帝国势力 raceID（1=Caldari 2=Minmatar 4=Amarr 8=Gallente）；null = 未知。 */
  empire: number | null;
  /** 是否具备旗舰跳能力（能力 ≠ 允许，见 `canJump`）。 */
  hasJump: boolean;
  /** 当前是否**被允许**旗舰跳（未被反跳、未在冷却、场景允许）。 */
  canJump: boolean;
  /** 当前是否**被允许**普通跃迁（「跃迁至」）：不在拦截力场、跃迁稳定系数 ≥ 1。 */
  canWarp: boolean;
  /** 不允许跃迁时的原因（供右键菜单悬停提示；允许时为空串）。 */
  warpReason: string;
  /** 跳/跃迁冷却剩余（ms）。 */
  jumpRemainingMs: number;
  /** 是否结构（玩家建筑）。 */
  structure: boolean;
  sideId: number;
  fleetId: number;
  wingId: number;
  squadId: number;
  alive: boolean;
  evac: boolean;
  x: number;
  y: number;
  /**
   * 速度向量（m/s）。
   *
   * ★ 渲染层用它在**相邻两个 tick 快照之间做 Hermite 插值**：引擎 1 tick = 1 秒、
   *   帧率约 20 Hz，若直接按帧坐标画，舰船就会"一节一节"地跳。
   *   两端位置 + 两端速度一起给出，才能保证跨 tick 边界没有折角（见 view/map.ts）。
   */
  vx: number;
  vy: number;
  /** 三层血量比例 0..1。 */
  shield: number;
  armor: number;
  hull: number;
  /** 电量比例 0..1。 */
  cap: number;
  locked: boolean;
  targetId: string | null;
  order: string;
  doctrine: string;
  /** 最远武器的**最佳射程**（optimal，m），用于"最佳射程环"。 */
  range: number;
  /**
   * 最远武器的**有效射程**（optimal + falloff，m），用于"有效射程环"。
   *
   * ★ 用户按 PYFA 的口径要求：`39km + 71.7km` —— 39 是最佳射程，
   *   39 + 71.7 才是有效射程（超过最佳后命中率按 0.5^((d-opt)/falloff)² 衰减），
   *   两者都要在沙盘上画出来。
   */
  rangeEff: number;
  /** 锁定距离（m，已计入感应阻扰），用于锁定环。 */
  lockRange: number;
  /** 是否正在起跳撤离。 */
  warping: boolean;
  /**
   * 正在干扰本单位的电子战来源（右上角"电子战连线"开关用）。
   * `from` 是施加者单位 id；找不到施加者时该条不出现。
   */
  ew: Array<{ from: string; kind: string }>;
  /** 挂载的组（铁骑纵队 / 无人机组）：**独立显示**在交火列表里。 */
  groups: GroupFrame[];
}

/**
 * 装备按钮行（§8.3 moduleLayout）。
 *
 * ★ 用户要求：按**装备型号**聚合显示，标签用**中文简写**。
 *   A/C 两舰各装 2 个「多谱式护盾增强器」→ 一行「盾全抗 ×2」。
 *   （引擎侧的启停身份仍严格是 (kind, instanceIndex) 二元组，C1 语义不变；
 *     一行覆盖的多个实例身份放在 `instances` 里，点击时逐条下发。）
 */
export interface ModuleRow {
  /** 分组键：模块型号 typeId。 */
  typeId: number;
  /** 中文简写标签，如「盾全抗」「甲爆抗」「传电」。 */
  label: string;
  /** 功能类别 kind（tooltip 用）。 */
  kind: string;
  /** 该型号在**单船**上的实例数（按钮上的 ×N）。 */
  perShip: number;
  /** 循环时间（ms），0 = 无循环（立即生效/常开）。 */
  cycleMs: number;
  /**
   * 当前循环进度 0..1（正在循环的实例取平均）。
   * 用于按钮上的淡绿（运转中）/ 淡红（本轮结束后停用）进度条。
   */
  cycle: number;
  /** 弹药名（指挥脉冲波靠它区分"装甲激能 / 装甲强化…"）；无弹药为 null。 */
  chargeName?: string | null;
  /** 该型号在小队里的**总实例数**。 */
  owned: number;
  /** 其中处于运行态的实例数。 */
  on: number;
  /** 其中"本轮结束后停用"的实例数。 */
  pendingOff: number;
  /** 该型号覆盖的实例身份列表（点击启停逐条下发）。 */
  instances: Array<{ kind: string; instanceIndex: number }>;
}

/** 武器行（§8.3 weaponLayout）：按型号 typeId 归类。 */
export interface WeaponRow {
  typeId: number;
  name: string;
  /** **装了该型号的船数**（用于"×N"显示）。 */
  owned: number;
  /**
   * 该型号的**炮位总数**（= 装有该型号的船 × 每船门数）。
   *
   * ★ `on` 数是"门"，`owned` 是"船" —— 两者单位不同，判断"是否全部开火"必须用
   *   `on >= total`。早期误用 `owned` 比较，导致"部分门在打"时被显示成「停火」，
   *   而进度条仍在填充（用户实测的矛盾现象）。
   */
  total: number;
  /** 其中处于开火状态的**门数**。 */
  on: number;
  /** 最佳射程（optimal，m）。 */
  range: number;
  /** 失准距离（falloff，m）：有效射程 = range + falloff。 */
  falloff: number;
  rof: number;
  /** 开火循环进度 0..1（正在持续开火时才有意义）。 */
  cycle: number;
  chargeName: string | null;
}

/** 小队视图（§8.2）。 */
export interface SquadFrame {
  key: string;
  sideId: number;
  fleetId: number;
  wingId: number;
  squadId: number;
  shipName: string;
  alive: number;
  total: number;
  /** 全队三层血量比例（按满编血量加权）。 */
  shield: number;
  armor: number;
  /** 该小队是否全部由「增援入场」的单位组成（左侧舰队树据此标注「增援舰队」）。 */
  reinforce?: boolean;
  hull: number;
  /** 单舰 DPS（取该小队样本舰）。 */
  dpsSingle: number;
  /** 全队 DPS（存活数 × 单舰）。 */
  dpsTotal: number;
  velocity: number;
  modules: ModuleRow[];
  weapons: WeaponRow[];
}

export interface SideReportFrame {
  sideId: number;
  start: number;
  alive: number;
  killed: number;
  evacuated: number;
  damageDealt: number;
  damageTaken: number;
}

export interface KillFrame {
  tick: number;
  sideId: number;
  unitName: string;
  shipName: string;
}

export interface Frame {
  tick: number;
  finished: boolean;
  winnerSideId: number | null;
  playing: boolean;
  speed: number;
  busy: boolean;
  busyNote: string;
  units: UnitFrame[];
  /** 地物（星门 / 空间站）。 */
  celestials?: CelestialFrame[];
  /** 小队视图（节流下发；未更新时为 undefined，UI 沿用旧值）。 */
  squads?: SquadFrame[];
  report?: { sides: SideReportFrame[]; ticks: number; finished: boolean; winnerSideId: number | null };
  kills?: KillFrame[];
  /** 本帧新增事件（增量）。 */
  events: BattleEvent[];
  marks: number[];
  keyframes: number[];
  branches: BranchInfo[];
  currentBranch: string;
  commandLog: Array<{ tick: number; action: string; target: string; note?: string }>;
}

/** 可装弹药（右键换弹用）。 */
export interface ChargeOption {
  typeId: number;
  name: string;
}

/**
 * 存档（交接文档 D-18）：**命令表是唯一真源**，状态由 (初始配装 + 命令 + 种子) 重放得到，
 * 并写入生成它的 PYFA 版本号，载入时版本不一致给提示。
 */
export interface SavedBattle {
  format: "eve-battle-sandbox";
  saveVersion: 1;
  pyfaVersion: string;
  scenarioId: string;
  unitsPerSide?: number;
  seed: number;
  mode: string;
  tick: number;
  commands: Command[];
  marks: number[];
  savedAt: string;
}

export type ToWorker =
  | { type: "init"; scenarioId: string; unitsPerSide?: number }
  /**
   * 用「战场编成」页自建的配置直接开局（不走内置场景表）。
   * `config` 是纯数据（可结构化克隆），Worker 直接交给 Runner。
   */
  | { type: "initConfig"; config: BattleConfig; label: string }
  | { type: "play" }
  | { type: "pause" }
  | { type: "setSpeed"; speed: number }
  | { type: "seek"; tick: number }
  | { type: "step"; ticks: number }
  | { type: "command"; cmd: Command }
  | { type: "undo" }
  | { type: "mark" }
  | { type: "fork"; atTick: number }
  | { type: "switchBranch"; id: string }
  | { type: "requestFrame" }
  | { type: "export" }
  | { type: "restore"; data: SavedBattle };

export type FromWorker =
  /**
   * 场景就绪。
   *
   * `landmarksExpected` 是该场景**配置里**的地物数量 —— 有的场景（如「指挥脉冲作用域」）
   * 本来就没有地物，自动验收据此判定「页面收到的地物数是否与场景一致」，
   * 而不是写死一个数字（否则无地物的场景会被误判为失败）。
   */
  | { type: "ready"; pyfaVersion: string; scenarioId: string; landmarksExpected: number }
  | { type: "frame"; frame: Frame }
  | { type: "busy"; busy: boolean; note: string }
  | { type: "error"; message: string }
  | { type: "statsRequest"; id: number; payload: { op: string; [k: string]: unknown } }
  | { type: "statsReady" }
  | { type: "exported"; data: SavedBattle }
  ;

/** 主线程 → Worker 的属性应答。 */
export interface StatsResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

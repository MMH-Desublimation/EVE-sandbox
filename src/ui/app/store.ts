/**
 * 「数据导入 → 配置库 → 战场编成 → 推演」四页流程的应用级状态。
 *
 * 定位：这里只保存**配装与编成**（即引擎的输入数据），并持久化到 localStorage。
 * 一旦「生成推演」，它会被 `battleBuilder` 转成 `BattleConfig` 交给 Worker；
 * 运行期的一切状态仍由引擎独占（UI 只读帧、只发命令，铁律不变）。
 */
import type { DroneSpec, FighterSpec, ModuleSpec } from "../../shared/protocol.ts";
import { normalizeInitialStates, repairFitModules, spreadSharedCharges } from "./fitRepair.ts";

/* ------------------------------------------------------------------ 配装 */

/** 配置库条目的来源。 */
export type FitSource = "pyfa-xml" | "clipboard" | "manual";

/** 配置库里的一份配装（可套用到任意数量的舰船上）。 */
export interface FitEntry {
  id: string;
  /** 配置名（用户可重命名）。 */
  name: string;
  shipTypeId: number;
  /** 舰船中文名（展示用；随 SDE 走）。 */
  shipName: string;
  modules: ModuleSpec[];
  drones: DroneSpec[];
  fighters: FighterSpec[];
  source: FitSource;
  importedAt: number;
  /** 溯源：来自哪个文件 / 剪贴板片段。 */
  origin?: string;
  /** 解析期提示（未识别的条目等）。 */
  warnings?: string[];
}

/* ------------------------------------------------------------------ 编成 */

export type SquadRole = "line" | "logi" | "capital" | "structure";
export type SquadDoctrine = "focus" | "free" | "auto" | "antiFighter" | "passive";

/** 小队编成：引用配置库里的一个条目，并给出数量与属性。 */
export interface SquadPlan {
  id: string;
  name: string;
  /** 引用配置库条目 id；null = 空编（不产生单位）。 */
  fitId: string | null;
  /** 舰船数量。 */
  count: number;
  role: SquadRole;
  doctrine: SquadDoctrine;
  /**
   * 自动后勤链：勾选后，本小队会被编成器自动并入本舰队的「后勤」小队
   * （后勤遥修/传电的目标链由引擎按需自动构建，见 core 的后勤选目标逻辑）。
   */
  autoLogi: boolean;
}

export interface WingPlan {
  id: string;
  name: string;
  squads: SquadPlan[];
}

export interface FleetPlan {
  id: string;
  name: string;
  wings: WingPlan[];
}

export interface SidePlan {
  id: string;
  name: string;
  /** 势力色（染色 + 列表/沙盘标记）。 */
  color: string;
  fleets: FleetPlan[];
}

/** 一份完整的战场编成方案。 */
export interface FormationPlan {
  /** 推演标签（存档 / 文件名用）。 */
  label: string;
  sides: SidePlan[];
  /** 星系半径（AU），默认 17.5；可调。 */
  radiusAU: number;
  /** 星门数量（随机 1..3 分布在中/外圈）。 */
  gateCount: number;
  seed: number;
}

/* ------------------------------------------------------------------ 常量 */

/** 1 天文单位（米）。 */
export const AU_METERS = 149_597_870_000;

/** 默认星系半径（AU）—— 用户指定约 17.5。 */
export const DEFAULT_RADIUS_AU = 17.5;

/** 势力调色板（新增势力时循环取色）。 */
export const SIDE_PALETTE = [
  "#3aa0ff", "#ff5a4d", "#6ee7a8", "#ffc857",
  "#c9a6ff", "#7fd6b0", "#ff9ecd", "#8fd3ff",
];

/* ------------------------------------------------------------------ 状态 */

const LS_FITS = "eve.v07.fits";
const LS_PLAN = "eve.v07.plan";
/**
 * 一次性历史修补旗标。旧导入器的两类历史坑：
 *  1) 成批弹药只装到一门炮上（DPS 只有 1/N）；2) 主动模块被写成 online（加成不生效）。
 * 只在**首次**启动跑一次，之后不再动用户手工编辑过的配装。
 */
const LS_LEGACY_FIX = "eve.v07.legacyFix.v1";
/**
 * 一次性旗标：把初始状态收敛到「在线但不运转」（后勤除外，保持自动运转）。
 * 独立于 LS_LEGACY_FIX —— 后者可能已经在用户机器上跑过，这里需要再跑一次。
 */
const LS_INITSTATE_FIX = "eve.v07.initState.v1";
/**
 * 一次性旗标：交火模式默认统一为「自动攻击」（把旧的「被动待命」抬上来）。
 * 旧默认曾把 focus 翻成 passive，这里再翻一次，保证"永远是四种模式之一"。
 */
const LS_DOCTRINE_FIX = "eve.v08.doctrineDefault.v1";

export const fits: FitEntry[] = [];
let plan: FormationPlan | null = null;

const listeners = new Set<() => void>();

/** 订阅变更（页面重绘用）。返回退订函数。 */
export function onStoreChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** 稳定 id（无外部依赖）。 */
export function newId(prefix: string): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

/* ------------------------------------------------------------------ 载入 / 保存 */

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * 从 localStorage 载入配置库与编成方案（在启动时调用一次）。
 *
 * ★ 时序：本函数**只**做纯数据装载，绝不做任何依赖 SDE 的修补 —— 它在
 *   `loadSde()` 之前调用，此时 SDE 尚未就绪。配装修补（把误入装备位的弹药/
 *   无人机归位）必须等 SDE 就绪后由 `migrateFits()` 执行，否则会把查不到的
 *   装备误判为"非装备"删掉（见 fitRepair.ts / migrateFits）。
 */
export function loadStore(): void {
  const list = safeParse<FitEntry[]>(localStorage.getItem(LS_FITS));
  if (Array.isArray(list)) {
    fits.length = 0;
    for (const f of list) {
      if (!f || typeof f !== "object" || typeof f.id !== "string") continue;
      if (!Array.isArray(f.modules)) f.modules = [];
      if (!Array.isArray(f.drones)) f.drones = [];
      if (!Array.isArray(f.fighters)) f.fighters = [];
      fits.push(f);
    }
  }
  const saved = safeParse<FormationPlan>(localStorage.getItem(LS_PLAN));
  plan = saved && Array.isArray(saved.sides) ? saved : null;
  emit();
}

/**
 * 历史数据迁移：修补旧导入器留下的坏配装（货物里的弹药/脚本/装料被当成装备
 * 写进了 `modules`，会让 PYFA 整份配装算不出来 → 生成推演时一艘船都建不出来）。
 *
 * ★ 必须在 `await loadSde()` **之后**调用：`repairFitModules` 依赖 SDE 判断某条目
 *   "是不是装备"，SDE 未就绪时会把所有查不到的装备都当成非装备删掉。
 * 就地修补后写回 localStorage，幂等 —— 之后启动不再重复改动。
 */
export function migrateFits(): void {
  let repaired = false;
  // 一次性历史修补（见 fitRepair.ts）：补满同型空弹药位 + 把主动模块的 online 抬成 active。
  const legacyFix = !safeGet(LS_LEGACY_FIX);
  // 一次性：把初始状态收敛为「在线但不运转 / 后勤例外保持自动运转」（见 normalizeInitialStates）
  const initStateFix = !safeGet(LS_INITSTATE_FIX);
  for (const f of fits) {
    if (!Array.isArray(f.modules)) continue;
    const before = f.modules.length;
    const notes = repairFitModules(f);
    if (f.modules.length !== before) repaired = true;
    if (legacyFix) {
      const filled = spreadSharedCharges(f);
      if (filled > 0) {
        repaired = true;
        notes.push(`已把弹药补满 ${filled} 个同型号空装备位（修复历史 DPS 偏差）。`);
      }

    }
    if (initStateFix) {
      const { idled, woken } = normalizeInitialStates(f);
      if (idled > 0 || woken > 0) {
        repaired = true;
        const parts: string[] = [];
        if (idled > 0) parts.push(`${idled} 个装备改为待机（不再自动运转/开火）`);
        if (woken > 0) parts.push(`${woken} 个后勤模块保持自动运转`);
        notes.push(`初始状态已重置：${parts.join("，")}。`);
      }
    }
    if (notes.length > 0) f.warnings = [...new Set([...(f.warnings ?? []), ...notes])];
  }
  // ★ V0.8：交火模式默认统一为「自动攻击」，且**永远是四种模式之一**（不再有"未载入"）。
  //   把历史数据里由旧默认产生的「被动待命(passive)」抬成「自动攻击(auto)」；
  //   用户显式选过的 focus / free / antiFighter 一律保留。
  if (!safeGet(LS_DOCTRINE_FIX) && plan) {
    let flipped = 0;
    for (const side of plan.sides) {
      for (const fleet of side.fleets) {
        for (const wing of fleet.wings) {
          for (const sq of wing.squads) {
            if (sq.doctrine === "passive") { sq.doctrine = "auto"; flipped++; }
          }
        }
      }
    }
    if (flipped > 0) {
      repaired = true;
      persistPlan();
      console.info(`[migrate] 已将 ${flipped} 个「被动待命」小队改为「自动攻击」`);
    }
    try {
      localStorage.setItem(LS_DOCTRINE_FIX, "1");
    } catch {
      /* 配额不足时下次再试 */
    }
  }
  if (legacyFix) {
    try {
      localStorage.setItem(LS_LEGACY_FIX, "1");
    } catch {
      /* 配额不足时下次再试 */
    }
  }
  if (initStateFix) {
    try {
      localStorage.setItem(LS_INITSTATE_FIX, "1");
    } catch {
      /* 同上 */
    }
  }
  if (repaired) persistFits();
  emit();
}

/** 读一个 localStorage 键；不可用时返回 null（Node/隐私模式）。 */
function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function persistFits(): void {
  try {
    localStorage.setItem(LS_FITS, JSON.stringify(fits));
  } catch {
    /* 配额不足时不阻塞使用 */
  }
}

function persistPlan(): void {
  if (!plan) return;
  try {
    localStorage.setItem(LS_PLAN, JSON.stringify(plan));
  } catch {
    /* 同上 */
  }
}

/* ------------------------------------------------------------------ 配置库 API */

export function getFit(id: string | null | undefined): FitEntry | null {
  if (!id) return null;
  return fits.find((f) => f.id === id) ?? null;
}

/** 批量入库；同名同舰船视为新增（允许重复，便于对照）。返回入库的条目。 */
export function addFits(list: FitEntry[]): FitEntry[] {
  if (list.length === 0) return [];
  fits.push(...list);
  persistFits();
  emit();
  return list;
}

export function updateFit(id: string, patch: Partial<FitEntry>): void {
  const f = getFit(id);
  if (!f) return;
  Object.assign(f, patch);
  persistFits();
  emit();
}

export function removeFit(id: string): void {
  const i = fits.findIndex((f) => f.id === id);
  if (i < 0) return;
  fits.splice(i, 1);
  // 编成里引用到它的位置一并清空，避免出现悬空引用
  if (plan) {
    for (const side of plan.sides) {
      for (const fleet of side.fleets) {
        for (const wing of fleet.wings) {
          for (const sq of wing.squads) if (sq.fitId === id) sq.fitId = null;
        }
      }
    }
    persistPlan();
  }
  persistFits();
  emit();
}

/* ------------------------------------------------------------------ 编成 API */

/** 空小队。 */
export function makeSquad(name: string, fitId: string | null = null): SquadPlan {
  // ★ V0.8：默认交火模式 = 「自动攻击」。交火模式**永远是四种之一**（集中火力/自由开火/
  //   自动攻击/集火舰载机），不存在"不载入模式"的空状态；用户可随时点击切换。
  return { id: newId("q"), name, fitId, count: 8, role: "line", doctrine: "auto", autoLogi: false };
}

export function makeWing(name: string, fitId: string | null = null): WingPlan {
  return { id: newId("w"), name, squads: [makeSquad(`${name}-1队`, fitId)] };
}

export function makeFleet(name: string, fitId: string | null = null): FleetPlan {
  return { id: newId("f"), name, wings: [makeWing(`${name}-1联队`, fitId)] };
}

export function makeSide(index: number, fitId: string | null = null): SidePlan {
  const color = SIDE_PALETTE[index % SIDE_PALETTE.length];
  const name = index === 0 ? "蓝方" : index === 1 ? "红方" : `${index + 1}号势力`;
  return { id: newId("s"), name, color, fleets: [makeFleet("本队", fitId)] };
}

/** 首次进入「战场编成」时的默认方案：两个势力，各一支舰队/联队/小队。 */
export function defaultPlan(): FormationPlan {
  const fit = fits[0]?.id ?? null;
  return {
    label: "自定义编成",
    sides: [makeSide(0, fit), makeSide(1, fit)],
    radiusAU: DEFAULT_RADIUS_AU,
    gateCount: 2,
    seed: 20261008,
  };
}

export function getPlan(): FormationPlan {
  if (!plan) plan = defaultPlan();
  return plan;
}

export function setPlan(next: FormationPlan): void {
  plan = next;
  persistPlan();
  emit();
}

/** 修改当前方案（浅拷贝后交回，便于页面直接改字段）。 */
export function mutatePlan(fn: (p: FormationPlan) => void): void {
  const p = getPlan();
  fn(p);
  persistPlan();
  emit();
}

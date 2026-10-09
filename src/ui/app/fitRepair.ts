/**
 * 配装数据修补：把「不是装备」的条目从 `modules` 里摘出来，归到相容装备的弹药位上。
 *
 * 背景（用户实测报障）：PYFA/EFT 导出的 XML 把弹药、脚本、装料统一放在 `slot="cargo"`
 * 里，并不记录「哪门炮装哪种弹」。早期导入器把货物里的这些条目也当成"装在船上的装备"，
 * 于是产出了一批**没有槽位**的模块条目（如 `最佳射程提升脚本`、`海军电容注电器装料 3200`）。
 * 这类条目送进 PYFA 后会直接抛 `ValueError: Passed item is not a Module`，
 * 整份配装的属性都算不出来 → 生成推演时一艘船都建不出来（沙盘一片空白）。
 *
 * 处理原则：
 *  - 能归到相容装备的弹药就**装上去**（按 chargeGroup + chargeSize 匹配，见 `sde.chargesFor`）；
 *  - 归不上的只记提示，**绝不**当作装备送进引擎。
 *
 * 本模块同时服务于两条路径：导入解析期（`fitIO`）与历史数据迁移（`store`）。
 */
import * as sde from "../sde.ts";
import type { ModuleSpec } from "../../shared/protocol.ts";
import type { FitEntry } from "./store.ts";

/** 一件待归属的弹药 / 脚本 / 装料。 */
export interface CargoItem {
  typeId: number;
  name: string;
  /** 携带数量：决定最多能装到几个相容装备上（弹药成批携带，脚本一器一枚）。 */
  qty: number;
}

/**
 * 「未知携带量」哨兵：历史数据（早期导入器/早期迁移）没有记录 qty，
 * 一律按"装满所有相容的空装备"处理 —— 否则成批弹药只会装到一门炮上，
 * 整船 DPS 只有 1/N（实测：8 门炮 1/8、3 门发射器 1/3）。
 */
export const CARRY_ALL = Number.MAX_SAFE_INTEGER;

/** 模块 → 可装弹药 typeId 集合（按 chargeGroup + chargeSize 匹配），带缓存。 */
const chargeCache = new Map<number, Set<number>>();

function chargeIdsFor(moduleTypeId: number): Set<number> {
  let set = chargeCache.get(moduleTypeId);
  if (!set) {
    set = new Set(sde.chargesFor(moduleTypeId).map((c) => Number(c.id)));
    chargeCache.set(moduleTypeId, set);
  }
  return set;
}

/**
 * 把货物里的弹药装到相容的、还没带弹的装备上。
 *
 * 一条弹药最多装到 `qty` 个装备上：弹药通常成批携带（3120 发电磁脉冲弹 → 6 门炮全装上），
 * 脚本通常一器一枚（2 个索敌计算机 ↔ 2 个最佳射程提升脚本）。
 * 一件都没装上的会记一条提示，绝不抛异常、也绝不产生新模块。
 */
export function attachCargo(
  modules: ModuleSpec[], cargo: CargoItem[], label: string, warnings: string[],
): void {
  const missed = new Set<string>();
  for (const item of cargo) {
    const want = Math.max(1, Math.floor(item.qty));
    let left = want;
    for (const m of modules) {
      if (left <= 0) break;
      if (m.chargeTypeId || typeof m.typeId !== "number") continue;
      if (!chargeIdsFor(m.typeId).has(Number(item.typeId))) continue;
      m.chargeTypeId = item.typeId;
      m.chargeName = item.name;
      left--;
    }
    if (left === want) missed.add(item.name);
  }
  if (missed.size > 0) {
    warnings.push(
      `「${label}」：${[...missed].join("、")} 在船上找不到相容的空装备，已忽略（该装备不会带弹）。`,
    );
  }
}

/** 该条目是否真的"装在船上的装备"：只认 SDE 里能查到的模块，弹药/脚本/装料一律不算。 */
function isFittedModule(m: ModuleSpec): boolean {
  return Boolean(sde.module_(m.typeId));
}

/**
 * 修补一份配装：把混在 `modules` 里的弹药 / 脚本 / 装料归到相容装备的弹药位上。
 *
 * 就地改写 `fit.modules`，返回提示（无问题则返回空数组）。
 * 幂等：修好的配装再跑一次不会产生任何变化。
 */
export function repairFitModules(fit: FitEntry): string[] {
  const modules = fit.modules ?? [];
  const kept: ModuleSpec[] = [];
  const cargo: CargoItem[] = [];

  for (const m of modules) {
    // 连 typeId 都没有的条目无从判断（引擎还能按名字解析），原样保留
    if (typeof m.typeId !== "number" || isFittedModule(m)) {
      kept.push(m);
      continue;
    }
    const name = m.name ?? sde.zhName(m.typeId) ?? `#${m.typeId}`;
    if (sde.drone(m.typeId) || sde.isFighter(m.typeId)) {
      // 无人机/铁骑误留在装备位：迁到机库，别丢
      const bay = sde.isFighter(m.typeId) ? fit.fighters : fit.drones;
      const exists = bay.find((d) => d.typeId === m.typeId);
      if (exists) exists.count = (exists.count ?? 0) + 1;
      else bay.push({ typeId: m.typeId, name, count: 1 });
      continue;
    }
    // ★ 历史数据不记录携带量：按"装满所有相容空装备"处理（CARRY_ALL）。
    //   曾经这里写死 qty:1，导致 8 门炮只有 1 门装上弹药，整船 DPS 恰好只有 1/8。
    cargo.push({ typeId: m.typeId, name, qty: CARRY_ALL });
  }

  if (cargo.length === 0) return [];
  const warnings: string[] = [];
  attachCargo(kept, cargo, fit.name, warnings);
  fit.modules = kept;
  return warnings;
}

/**
 * 历史修补（一次性）：早期迁移把成批弹药只装到一门炮上，其余同型炮位空着，
 * 于是整船 DPS 只有 1/N（实测 8 门炮 1/8、3 门发射器 1/3）。
 *
 * 规则：对**同一型号**的一组装备 —— 若其中至少一个已装弹、其余为空且能接受同一种弹药，
 * 就把该弹药补满其余空位。只处理"同型号"，避免把不同口径炮的弹药互相串味。
 *
 * 幂等：补满后再跑一遍没有任何变化。返回被补上的空位数。
 *
 * 定位：只在 `store.migrateFits()` 的**历史数据一次性迁移**里调用（带版本旗标），
 * 不在每次装配时跑 —— 以免覆盖用户"故意只装一门"的手工编辑。
 */
export function spreadSharedCharges(fit: FitEntry): number {
  const byType = new Map<number, ModuleSpec[]>();
  for (const m of fit.modules ?? []) {
    if (typeof m.typeId !== "number") continue;
    const arr = byType.get(m.typeId);
    if (arr) arr.push(m);
    else byType.set(m.typeId, [m]);
  }
  let filled = 0;
  for (const [typeId, group] of byType) {
    if (group.length < 2) continue;
    const src = group.find(
      (m) => m.chargeTypeId && chargeIdsFor(typeId).has(Number(m.chargeTypeId)),
    );
    if (!src) continue;
    for (const m of group) {
      if (m.chargeTypeId) continue;
      m.chargeTypeId = src.chargeTypeId;
      m.chargeName = src.chargeName;
      filled++;
    }
  }
  return filled;
}

/**
 * 后勤类模块判定：**远程维修 / 远程电容传输**。
 *
 * 用户的显式要求：「装备初始全部关闭（不自动运转），但**后勤例外，保持自动运转**」——
 * 所以只有这一类默认 `active`，其余一律 `online`（待机、不运转）。
 *
 * 判定依据：SDE 的**装备组名**（实测均可命中：
 * `远程护盾回充增量器`、`远程电容传输装置`、`远程装甲维修器`、`远程船体维修器`）。
 */
export function isLogiModule(typeId: unknown): boolean {
  if (typeof typeId !== "number") return false;
  const g = sde.groupOf(typeId)?.name ?? "";
  return /远程(护盾|装甲|船体|结构|电容)/.test(g);
}

/**
 * 初始状态归一化（一次性迁移 + 导入器共用同一套规则）。
 *
 * 规则：
 *  · 后勤（远程维修 / 传电）→ `active`，保持自动运转（用户要求例外）；
 *  · 其余一切（含炮台、硬化、推进、注电…）→ `online`，**在线但不运转**，
 *    保留装配带来的被动加成（扩展/附甲/损伤控制仍计入 EHP），但绝不自动开火/运转；
 *  · `offline` 保持不动（尊重用户手工置离线）。
 *
 * 返回被改动的统计，用于向用户报告。
 */
export function normalizeInitialStates(fit: FitEntry): { idled: number; woken: number } {
  let idled = 0;
  let woken = 0;
  for (const m of fit.modules ?? []) {
    if (m.state === "offline") continue; // 用户手工离线 → 不动
    const want: ModuleSpec["state"] = isLogiModule(m.typeId) ? "active" : "online";
    if (m.state === want) continue;
    m.state = want;
    if (want === "active") woken++; else idled++;
  }
  return { idled, woken };
}

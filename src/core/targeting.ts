/**
 * 交火目标解析（用户补充规则的核心）。
 *
 * 引擎里"目标"有两种形态：
 *   · **单位**（舰船 / 建筑）—— 由 `Unit.targetId` 指向；
 *   · 单位挂载的**组**（铁骑纵队 / 无人机组）—— `targetId` 仍指母舰，
 *     另用 `targetKind` + `targetGroupId` 指明是哪一组。
 *
 * 为什么不引入统一的 TargetRef：
 *   位置、射程、锁定时长这些都按"母舰"算（组跟着母舰走，不建模独立轨道），
 *   只有**命中判定与伤害落点**需要区分到组。这样改动面最小，
 *   而且能**原样复用既有的命中/应用率公式** —— 另写一套正是上一版出错的地方。
 *
 * ★ 规则（用户明确要求）：
 *   - 默认只打"单位"；铁骑必须显式选中或走「集火舰载机」才打；
 *   - **无人机永不主动选择**，只被立体炸弹这类范围伤害波及；
 *   - 组是**实体**：有自己的信号半径与速度，参与命中判定，有自己的血池。
 */
import { isTargetable } from "./state.ts";
import type { DroneGroup, FighterSquadron, Unit } from "./state.ts";

export type GroupLike = FighterSquadron | DroneGroup;
export type GroupKind = "fighter" | "drone";

export interface TargetHandle {
  /** 母舰 / 舰船单位：位置与锁定的基准。 */
  host: Unit;
  kind: "unit" | GroupKind;
  /** 组对象（`kind !== "unit"` 时存在）。 */
  group?: GroupLike;
  /** 显示名（事件流与 UI 用）。 */
  name: string;
}

/** 组是否仍在场（血池未空、未回收）。 */
export function groupAlive(g: GroupLike): boolean {
  if (g.hpPool <= 0) return false;
  const launched = (g as FighterSquadron & DroneGroup).launched;
  return launched !== false;
}

export function groupKindLabel(kind: GroupKind): string {
  return kind === "fighter" ? "铁骑" : "无人机";
}

/** 取某单位挂载的指定组（含存在性与存活判断）。 */
export function findGroup(host: Unit, kind: GroupKind, groupId: string): GroupLike | undefined {
  const pool: GroupLike[] = kind === "fighter" ? host.fighters : host.drones;
  return pool.find((g) => g.id === groupId);
}

/**
 * 解析单位当前的交火目标。`null` = 目标无效（已死 / 已撤离 / 组已灭）。
 */
export function resolveTarget(
  get: (id: string | null) => Unit | undefined, u: Unit,
): TargetHandle | null {
  const host = get(u.targetId);
  if (!host || !isTargetable(host)) return null;
  if (u.targetKind === "unit" || !u.targetGroupId) {
    return { host, kind: "unit", name: host.name };
  }
  const g = findGroup(host, u.targetKind, u.targetGroupId);
  if (!g || !groupAlive(g)) return null;
  return {
    host,
    kind: u.targetKind,
    group: g,
    name: `${g.name}（${groupKindLabel(u.targetKind)}·${host.name}）`,
  };
}

/**
 * 为"组"构造轻量目标替身，让既有的命中/伤害函数原样可用。
 *
 * 位置沿用母舰（不建模组的独立轨道）；**信号半径与速度换成组自己的** ——
 * 这正是"铁骑/无人机是实体"的体现：小而快的东西更难打。
 * 速度用一个与组自身速度等大的向量表示，使
 *   · 导弹应用率的速度项（`targetSpeed`）正确；
 *   · 炮台追踪的角速度项获得相应惩罚（近似，但方向与量级正确）。
 */
export function groupProxy(h: TargetHandle): Unit {
  const g = h.group as GroupLike;
  const sig = Math.max(1, g.signatureRadius || 40);
  const nav = { ...h.host.stats.attrs.nav, signatureRadius: sig };
  return {
    ...h.host,
    // ★ 组有自己的位置与速度：射程、角速度一律用**组自身的**，不再借用母舰的。
    //   环绕中的铁骑因此真的"又快又小、难打"（速度就是它的实际环绕速度）。
    pos: { x: g.pos.x, y: g.pos.y },
    vel: { x: g.vel.x, y: g.vel.y },
    stats: { ...h.host.stats, attrs: { ...h.host.stats.attrs, nav } },
  } as Unit;
}

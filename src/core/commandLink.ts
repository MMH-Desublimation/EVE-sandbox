/**
 * 指挥脉冲的作用域求解（用户规则）。
 *
 * 规则原文：
 *   · 只作用于**同一个舰队** —— A、B 两个舰队同属蓝方，A 舰队的指挥舰开启脉冲，
 *     作用范围内**所有 A 舰队成员**（不分小队）受益，**B 舰队不受益**；
 *   · 同一种脉冲（同弹药）反复激活时，**取加成值最高**的那一个，并按其自身射程
 *     确定覆盖范围 —— 所以"交集范围内取强的，非交集范围内各取各自属性"。
 *
 * 因为每个单位的位置不同，"谁能覆盖它"就不同 → **每个单位的生效集合可能不一样**。
 * 引擎是"属性一次预热、运行期纯查表"的确定性设计，因此这里：
 *   1. 把每个舰队的**所有可能子集**枚举出来，算出各自的 link 列表（去重）；
 *   2. 启动时把这些集合全部预热成 `envKey`；
 *   3. 运行期按"同舰队 + 射程"求出每个单位当前命中的集合，**变了才重算属性**。
 */
import { vec } from "./geometry.ts";
import type { CommandLinkSpec } from "../shared/protocol.ts";
import type { ModuleState, Unit, Vec2 } from "./state.ts";

/** 指挥脉冲源：由某艘指挥舰开启的一路脉冲。 */
export interface CommandBurstSource {
  /** 开启脉冲的指挥舰（单位 id）。 */
  unitId: string;
  /** PYFA 的 link 类型键（如 `armor_energizing`，合法值见 COMMAND_LINK_DEFS）。 */
  linkType: string;
  /** 强度 0..5（5 = 指挥舰/T3 + 满级技能）。 */
  strength: number;
  /** 是否带指挥脉冲脑插（Mindlink）。 */
  mindlink: boolean;
  /** 作用半径（米）。 */
  rangeM: number;
  /**
   * 可选：绑定的模块下标。给出时，**只有该模块处于 active 才算"开启了脉冲"** ——
   * 这样玩家在界面上开/关这个模块就等于开关脉冲。
   */
  moduleIndex?: number;
}

/** 枚举上限：一次方最多这么多路脉冲参与组合（2^n 子集）。 */
export const MAX_SOURCES_PER_COMBO = 10;

/**
 * 指挥脉冲的加成倍率。
 *
 * ★ 这个公式**逐项对照过 PYFA 的 `getLinkMultiplier`**：
 *   12 个 (强度 × 脑插) 组合全部精确吻合（见 `sidecar/_probe_e8.py`）。
 *   它由 PYFA 自己的常量构成：SKILL_MULTIPLIER=1.5、TECH_MULTIPLIER=1.25、
 *   MINDLINK_MULTIPLIER=1.25，强度部分为 `1 + 0.05·strength`。
 *   战区测试里有一条断言拿它跟 oracle 的 `linkTable` 逐值比对，防止 PYFA 升级后悄悄错位。
 */
export function linkMultiplier(strength: number, mindlink: boolean): number {
  return (1 + 0.05 * strength) * 1.5 * 1.25 * (mindlink ? 1.25 : 1);
}

/** link 列表的稳定比较键（用于去重与缓存键）。 */
export function linksKey(links: readonly CommandLinkSpec[]): string {
  return links
    .map((l) => `${l.linkType}:${l.strength}:${l.mindlink ? 1 : 0}`)
    .sort()
    .join(",");
}

function toSpec(s: CommandBurstSource): CommandLinkSpec {
  return { linkType: s.linkType, strength: s.strength, mindlink: s.mindlink };
}

/** 从一组源里按"同种取最强"折叠出 link 列表（确定性：并列时 unitId 升序）。 */
function collapse(sources: readonly CommandBurstSource[]): CommandLinkSpec[] {
  const byType = new Map<string, { s: CommandBurstSource; mult: number }>();
  for (const s of sources) {
    const mult = linkMultiplier(s.strength, s.mindlink);
    const cur = byType.get(s.linkType);
    if (!cur || mult > cur.mult || (mult === cur.mult && s.unitId < cur.s.unitId)) {
      byType.set(s.linkType, { s, mult });
    }
  }
  return [...byType.values()].map((v) => toSpec(v.s));
}

/** 判定"谁能收到脉冲"所需的最小信息（Unit 结构上天然满足）。 */
export interface LinkSubject {
  sideId: number;
  fleetId: number;
  pos: Vec2;
  moduleStates: ModuleState[];
}

/** 脉冲源在某一时刻的状态。 */
export interface LinkSourceState extends LinkSubject {
  /** 源本身是否可用（存活 / 在场）。 */
  usable: boolean;
}

/** 从 Unit 取脉冲源状态（运行期用）。 */
export function sourceStateOf(u: Unit): LinkSourceState {
  return {
    sideId: u.sideId, fleetId: u.fleetId, pos: u.pos, moduleStates: u.moduleStates,
    usable: u.alive && !u.evacuated && u.arrivalDelayMs <= 0,
  };
}

/**
 * 某单位**当前**实际生效的指挥脉冲列表。
 *
 * 判定顺序：同势力 **且同舰队** → 源可用 → （绑定的）模块处于 active → 射程 → 同种取最强。
 */
export function effectiveLinks(
  sources: readonly CommandBurstSource[],
  subject: LinkSubject,
  get: (id: string) => LinkSourceState | undefined,
): CommandLinkSpec[] {
  const covering: CommandBurstSource[] = [];
  for (const s of sources) {
    const host = get(s.unitId);
    if (!host || !host.usable) continue;
    // ① 同势力 **且同舰队** —— 跨舰队不受益（用户规则的核心）
    if (host.sideId !== subject.sideId || host.fleetId !== subject.fleetId) continue;
    // ② 绑了模块的：必须处于 active（"开启指挥脉冲波"）
    if (s.moduleIndex !== undefined && host.moduleStates[s.moduleIndex] !== "active") continue;
    // ③ 射程
    if (vec.dist(host.pos, subject.pos) > s.rangeM) continue;
    covering.push(s);
  }
  return collapse(covering);
}

/**
 * 枚举某个舰队的**所有可能组合**（子集）→ 去重后的 link 列表集合。
 *
 * 用途：启动时把这批集合全部预热，运行期就能纯查表。
 * 一个真实局面必然是这些子集之一（没被覆盖到的源就等于不在子集里），
 * 因此预热是**完备**的。
 */
export function enumerateCombos(sources: readonly CommandBurstSource[]): CommandLinkSpec[][] {
  if (sources.length === 0) return [[]];
  if (sources.length > MAX_SOURCES_PER_COMBO) {
    // 退化保护：源太多时不做组合爆炸，只保留"每型取全局最强"这一种
    console.warn(
      `[commandLink] 一方有 ${sources.length} 路脉冲，超过组合上限 `
      + `${MAX_SOURCES_PER_COMBO}，退化为"每型取最强"单组合`,
    );
    return [collapse(sources)];
  }
  const out = new Map<string, CommandLinkSpec[]>();
  const n = sources.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const subset: CommandBurstSource[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(sources[i]);
    const links = collapse(subset);
    out.set(linksKey(links), links);
  }
  return [...out.values()];
}

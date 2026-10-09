/**
 * 引擎状态 → 只读视图（§8.2 / §8.3）。
 *
 * ★ 上一版的两个根因在这里被结构性防护：
 *   - C1「同 kind 多实例不能同时启用」：模块行的身份是 **(kind, instanceIndex)**，
 *     启停判定与 UI 判定都用这个二元组，绝不只按 kind。
 *   - B3「混编舰队换弹后所有船变成同一种船」：所有聚合都基于**单位自己的 fit/stat**，
 *     不存在"舰队级 fit"这一概念。
 */
import { unitDpsOf } from "../core/combat.ts";
import { lockRangeMultiplier } from "../core/geometry.ts";
import { jumpAllowed, warpAllowed } from "../core/jump.ts";
import type { Unit, BattleState } from "../core/state.ts";
import type { CelestialFrame, ModuleRow, SquadFrame, UnitFrame, WeaponRow } from "./protocol.ts";
import { groupOf, zhName } from "./sde.ts";
import { moduleAbbr, weaponAbbr } from "./util/abbr.ts";

const KIND_ABBR: Record<string, string> = {
  shieldHardener: "盾抗", armorHardener: "甲抗",
  trackingComputer: "索敌", missileGuidanceComputer: "制导", sensorBooster: "感应",
  shieldBooster: "盾修", armorRepairer: "甲修", hullRepairer: "结构修",
  remoteShield: "遥盾", remoteArmor: "遥甲", remoteHull: "遥构", capTransfer: "传电",
  capBooster: "注电", prop: "推进", siege: "会战", triage: "后勤模式", commandBurst: "指挥脉冲",
  web: "网", grappler: "抓钩", painter: "标记", damp: "阻扰", ecm: "ECM", ecmBurst: "ECM波",
  trackDisrupt: "追踪干扰", guidanceDisrupt: "制导干扰", neut: "毁电", nos: "吸电",
  smartbomb: "智能炸弹", bubble: "泡泡", interdictionLauncher: "拦截弹", warpDisrupt: "扰断",
  warpScramble: "扰断器", other: "其他",
};

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

export function kindAbbr(kind: string): string {
  return KIND_ABBR[kind] ?? kind;
}

export function moduleLabel(kind: string, instanceIndex: number): string {
  return `${kindAbbr(kind)}${CIRCLED[instanceIndex] ?? `#${instanceIndex + 1}`}`;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 最远武器的 **(最佳射程, 有效射程)**（米）。
 *
 * 按 PYFA 口径：`39km + 71.7km` = optimal 39 km、falloff 71.7 km，
 * 有效射程 = optimal + falloff。沙盘上要分别画"最佳 / 有效"两个环。
 */
function maxRangeOf(u: Unit): { optimal: number; effective: number } {
  let opt = 0;
  let eff = 0;
  for (const w of u.weapons) {
    const e = w.optimal + w.falloff;
    if (w.optimal > opt) { opt = w.optimal; eff = e; }
    else if (w.optimal === opt) eff = Math.max(eff, e);
  }
  for (const g of u.drones) {
    if (g.optimal > opt) { opt = g.optimal; eff = g.optimal; }
  }
  return { optimal: opt, effective: Math.max(eff, opt) };
}

/**
 * 单舰理论秒伤（PYFA 口径）。**公式在 core/combat.ts** —— 收敛到引擎侧，
 * 既避免显示层与引擎各写一份而漂移，也让 Node 验收测试能直接核对。
 */
export function unitDps(u: Unit): number {
  return unitDpsOf(u);
}

export function buildUnitFrames(state: BattleState): UnitFrame[] {
  const out: UnitFrame[] = [];
  for (const u of state.units) {
    const warpVerdict = warpAllowed(state, u);
    const rBest = maxRangeOf(u);
    out.push({
      id: u.id,
      name: u.name,
      shipName: u.shipName,
      icon: u.iconClass,
      empire: u.empire,
      hasJump: u.jump !== null,
      canJump: jumpAllowed(state, u).ok,
      canWarp: warpVerdict.ok,
      warpReason: warpVerdict.reason,
      jumpRemainingMs: u.jump ? Math.round(u.jump.remainingMs) : 0,
      structure: u.role === "structure",
      sideId: u.sideId,
      fleetId: u.fleetId,
      wingId: u.wingId,
      squadId: u.squadId,
      alive: u.alive,
      evac: u.evacuated,
      x: Math.round(u.pos.x),
      y: Math.round(u.pos.y),
      // 速度保留 0.1 m/s 精度就够渲染外推用了
      vx: Math.round(u.vel.x * 10) / 10,
      vy: Math.round(u.vel.y * 10) / 10,
      shield: u.maxHp.shield > 0 ? u.hp.shield / u.maxHp.shield : 0,
      armor: u.maxHp.armor > 0 ? u.hp.armor / u.maxHp.armor : 0,
      hull: u.maxHp.hull > 0 ? u.hp.hull / u.maxHp.hull : 0,
      cap: u.capMax > 0 ? u.cap / u.capMax : 0,
      locked: u.locked,
      targetId: u.targetId,
      order: u.order.type,
      doctrine: u.doctrine,
      range: rBest.optimal,
      rangeEff: rBest.effective,
      lockRange: Math.round(u.stats.attrs.scan.maxRange * lockRangeMultiplier(u)),
      warping: u.warpingOut,
      // 电子战连线（右上角"电子战连线"开关）：谁在干扰我
      ew: u.effects
        .filter((e) => typeof e.sourceId === "string" && e.sourceId !== u.id)
        .map((e) => ({ from: e.sourceId as string, kind: e.kind })),
      // 挂载的组（铁骑 / 无人机）：独立显示 —— 它们是实体，有自己的血量与信号半径
      groups: [
        ...u.fighters.map((f) => ({
          id: f.id, kind: "fighter" as const, name: f.name,
          hp: f.hpPoolMax > 0 ? f.hpPool / f.hpPoolMax : 0,
          hpPool: Math.round(f.hpPool), hpPoolMax: Math.round(f.hpPoolMax),
          alive: f.launched && f.hpPool > 0,
          outputRatio: f.outputRatio,
          signatureRadius: f.signatureRadius,
          maxVelocity: f.maxVelocity,
          tubes: f.tubes, size: f.squadronSize,
          targeted: u.targetGroupId === f.id,
          x: f.pos.x, y: f.pos.y, orbitRange: f.orbitRange,
          // 速度供渲染外推（组是自己机动的，不能跟着母舰插值）
          vx: Math.round(f.vel.x * 10) / 10, vy: Math.round(f.vel.y * 10) / 10,
        })),
        ...u.drones.map((g) => ({
          id: g.id, kind: "drone" as const, name: g.name,
          hp: g.hpPoolMax > 0 ? g.hpPool / g.hpPoolMax : 0,
          hpPool: Math.round(g.hpPool), hpPoolMax: Math.round(g.hpPoolMax),
          alive: g.launched && g.hpPool > 0,
          outputRatio: g.outputRatio,
          signatureRadius: g.signatureRadius,
          maxVelocity: g.maxVelocity,
          tubes: g.totalCount, size: g.totalCount,
          targeted: u.targetGroupId === g.id,
          x: g.pos.x, y: g.pos.y, orbitRange: g.optimal,
          vx: Math.round(g.vel.x * 10) / 10, vy: Math.round(g.vel.y * 10) / 10,
        })),
      ],
    });
  }
  return out;
}

/** 地物（星门 / 空间站）的只读视图。 */
export function buildCelestialFrames(state: BattleState): CelestialFrame[] {
  return state.celestials.map((c) => ({
    id: c.id,
    kind: c.kind,
    name: c.name,
    sideId: c.sideId,
    x: Math.round(c.pos.x),
    y: Math.round(c.pos.y),
    radiusM: c.radiusM,
  }));
}

/** 按 (势力, 舰队, 联队, 中队) 聚合小队视图。 */
export function buildSquads(state: BattleState): SquadFrame[] {
  const groups = new Map<string, Unit[]>();
  for (const u of state.units) {
    const key = `${u.sideId}:${u.fleetId}:${u.wingId}:${u.squadId}`;
    const list = groups.get(key);
    if (list) list.push(u);
    else groups.set(key, [u]);
  }

  const out: SquadFrame[] = [];
  for (const [key, units] of groups) {
    const sample = units[0];
    const alive = units.filter((u) => u.alive && !u.evacuated);
    const aliveCount = alive.length;

    // 三层血量比例：按满编血量加权
    const sumMax = { shield: 0, armor: 0, hull: 0 };
    const sumCur = { shield: 0, armor: 0, hull: 0 };
    for (const u of units) {
      sumMax.shield += u.maxHp.shield; sumMax.armor += u.maxHp.armor; sumMax.hull += u.maxHp.hull;
      sumCur.shield += u.hp.shield; sumCur.armor += u.hp.armor; sumCur.hull += u.hp.hull;
    }

    const dpsSingle = unitDps(sample);
    out.push({
      key,
      sideId: sample.sideId,
      fleetId: sample.fleetId,
      wingId: sample.wingId,
      squadId: sample.squadId,
      shipName: sample.shipName,
      // 全部由增援入场单位组成（运行时 spawn-* / 预备队 res:*）→ 左侧树标「增援舰队」
      reinforce: units.every((u) => /^(spawn-|res:)/.test(u.id)),
      alive: aliveCount,
      total: units.length,
      shield: sumMax.shield > 0 ? sumCur.shield / sumMax.shield : 0,
      armor: sumMax.armor > 0 ? sumCur.armor / sumMax.armor : 0,
      hull: sumMax.hull > 0 ? sumCur.hull / sumMax.hull : 0,
      dpsSingle,
      dpsTotal: dpsSingle * aliveCount,
      velocity: sample.maxVelocity,
      modules: moduleLayout(units),
      weapons: weaponLayout(units),
    });
  }
  return out.sort((a, b) => a.sideId - b.sideId || a.squadId - b.squadId);
}

/**
 * 模块行布局（§8.3 / V0.7 中文简写）。
 *
 * ★ 行身份 = **模块型号 typeId**（用户要求按型号聚合）。
 *   标签走 `moduleAbbr` 的中文简写（`多谱式护盾增强器` → `盾全抗`），
 *   数量走 ×每船实例数 + (运行/总数)。
 *   ★ C1 防护不变：每个实例仍带自己的 (kind, instanceIndex)，点击时逐条下发，
 *     因此"同 kind 不同型号"（如 多谱式盾抗 vs 爆炸盾抗）绝不会串味。
 */
export function moduleLayout(units: Unit[]): ModuleRow[] {
  interface Agg {
    typeId: number;
    label: string;
    kind: string;
    chargeName: string | null;
    cycleMs: number;
    owned: number;
    on: number;
    pendingOff: number;
    perShip: number;
    instances: Array<{ kind: string; instanceIndex: number }>;
    cycleSum: number;
    cycleCount: number;
  }
  const map = new Map<number, Agg>();
  const order: number[] = [];

  for (const u of units) {
    // 该船内每种 kind 的实例编号（与 commands.resolveModuleIndex 的算法一致）
    const kindCount = new Map<string, number>();
    const perShipOfType = new Map<number, number>();
    for (const a of u.actives) {
      const instanceIndex = kindCount.get(a.kind) ?? 0;
      kindCount.set(a.kind, instanceIndex + 1);

      let agg = map.get(a.typeId);
      if (!agg) {
        const group = groupOf(a.typeId)?.name ?? "";
        // ★ 中文简写必须基于**中文名**：帧里 ActiveInstance.name 是引擎自己的英文名
        //   （如 "Multispectrum Shield Hardener II"），直接喂给 moduleAbbr 会得到 "Multis"。
        //   统一按 typeId 从 SDE 取中文名再简写。
        map.set(a.typeId, (agg = {
          typeId: a.typeId,
          label: moduleAbbr(zhName(a.typeId) ?? a.name ?? "", group),
          kind: a.kind,
          chargeName: null,
          cycleMs: 0,
          owned: 0, on: 0, pendingOff: 0, perShip: 0,
          instances: [],
          cycleSum: 0, cycleCount: 0,
        }));
        order.push(a.typeId);
      }
      const n = (perShipOfType.get(a.typeId) ?? 0) + 1;
      perShipOfType.set(a.typeId, n);
      agg.perShip = Math.max(agg.perShip, n);
      agg.owned++;
      if (a.on) agg.on++;
      if (a.pendingOff) agg.pendingOff++;
      // 取第一个装了弹药的实例名（指挥脉冲波靠它区分是哪一路脉冲）
      if (!agg.chargeName && a.chargeName) agg.chargeName = a.chargeName;
      if (a.cycleMs > 0) {
        agg.cycleMs = Math.max(agg.cycleMs, a.cycleMs);
        // 只在"本轮循环正在走"时累计进度：停用（且非 pendingOff）的实例不进分母
        if (a.on || a.pendingOff) {
          agg.cycleSum += clamp01(1 - a.cycleRemainingMs / a.cycleMs);
          agg.cycleCount++;
        }
      }
      agg.instances.push({ kind: a.kind, instanceIndex });
    }
  }

  return order.map((t) => {
    const a = map.get(t)!;
    return {
      typeId: a.typeId,
      label: a.label,
      kind: a.kind,
      perShip: a.perShip,
      cycleMs: a.cycleMs,
      cycle: a.cycleCount > 0 ? a.cycleSum / a.cycleCount : 0,
      chargeName: a.chargeName,
      owned: a.owned,
      on: a.on,
      pendingOff: a.pendingOff,
      instances: a.instances,
    };
  });
}

/** 武器行布局（§8.3）：按型号 typeId 归类。 */
export function weaponLayout(units: Unit[]): WeaponRow[] {
  const map = new Map<number, WeaponRow>();
  // 开火循环进度按型号聚合（正在循环的门数取平均）
  const cycleSum = new Map<number, number>();
  const cycleN = new Map<number, number>();
  for (const u of units) {
    const seen = new Set<number>();
    for (const w of u.weapons) {
      let row = map.get(w.typeId);
      if (!row) {
        row = {
          // 武器名同样按 typeId 取中文名再简写（`1400mm榴弹炮 II` → `1400mm榴弹炮`）
          typeId: w.typeId, name: weaponAbbr(zhName(w.typeId) ?? w.name) || w.name,
          owned: 0, total: 0, on: 0, cycle: 0,
          range: w.optimal, falloff: w.falloff, rof: w.rofMs, chargeName: w.chargeName,
        };
        map.set(w.typeId, row);
      }
      // owned 统计"装了该型号的船数"，不重复计同船多门；total 计**门数**
      if (!seen.has(w.typeId)) {
        seen.add(w.typeId);
        row.owned++;
      }
      row.total++;
      if (w.on) row.on++;
      if (w.chargeName) row.chargeName = w.chargeName;
      if (w.rofMs > 0 && w.on) {
        cycleSum.set(w.typeId, (cycleSum.get(w.typeId) ?? 0)
          + clamp01(1 - w.cycleRemainingMs / w.rofMs));
        cycleN.set(w.typeId, (cycleN.get(w.typeId) ?? 0) + 1);
      }
    }
  }
  for (const row of map.values()) {
    const n = cycleN.get(row.typeId) ?? 0;
    row.cycle = n > 0 ? (cycleSum.get(row.typeId) ?? 0) / n : 0;
  }
  return [...map.values()].sort((a, b) => a.typeId - b.typeId);
}

/**
 * 把「战场编成」方案 + 配置库 → 引擎的 `BattleConfig`。
 *
 * 尺度说明（重要）：
 *  - `FormationPlan.radiusAU` 决定**星系圆边界**与**星门分布环**（用户要求：默认 17.5 AU，
 *    星门随机 1~3 个散布在中/外圈，不含中立空间站）。
 *  - 舰队在星系**中心附近按交战尺度展开**（几十~百余 km），否则武器射程之外永远打不起来；
 *    交战半径随编成规模自适应，并受星系半径上限约束。
 */
import type { BattleConfig } from "../../core/battle.ts";
import { makeUnitId, mulberry32 } from "../../core/deterministic.ts";
import { blobFormation, FORMATION_SPACING } from "../../core/formation.ts";
import type { Celestial, Doctrine, UnitBlueprint, Vec2 } from "../../core/state.ts";
import { groupOf } from "../sde.ts";
import type { FitEntry, FormationPlan, SquadPlan } from "./store.ts";
import { AU_METERS, getFit } from "./store.ts";
import { repairFitModules } from "./fitRepair.ts";

export interface BuildResult {
  config: BattleConfig;
  warnings: string[];
  /** 编成里实际产出的单位数 / 各方数量（供界面回显）。 */
  counts: { total: number; bySide: number[] };
  /** 星系半径（米）与地物数（供 UI 显示）。 */
  radiusM: number;
  landmarks: number;
}

/** 交战尺度上限：不超过星系半径的 45%。 */
function combatRadius(sideShips: number, radiusM: number): number {
  const spread = FORMATION_SPACING * 0.52 * Math.sqrt(Math.max(1, sideShips));
  const want = 3.5 * spread;
  return Math.min(0.45 * radiusM, Math.max(25_000, want));
}

/** 编成方案 → BattleConfig。缺配置/空编会记入 warnings，不产生单位。 */
export function buildBattleConfig(plan: FormationPlan): BuildResult {
  const warnings: string[] = [];
  /** 已经兜过底的配装（同一份配装可被多个小队引用，提示只报一次）。 */
  const sanitized = new Set<string>();
  const radiusM = Math.max(1, plan.radiusAU) * AU_METERS;
  const seed = Number.isFinite(plan.seed) ? plan.seed : 20261008;
  const rng = mulberry32(seed >>> 0);

  // 每方舰船总数 → 决定展开半径
  const sideCounts = plan.sides.map((side) =>
    side.fleets.reduce(
      (a, f) => a + f.wings.reduce(
        (b, w) => b + w.squads.reduce((c, q) => c + (q.fitId ? Math.max(0, q.count) : 0), 0), 0),
      0,
    ));
  const maxSide = Math.max(1, ...sideCounts);
  const anchorR = combatRadius(maxSide, radiusM);

  const blueprints: UnitBlueprint[] = [];

  plan.sides.forEach((side, si) => {
    const n = plan.sides.length;
    // 多势力均匀分布在圆上：0 号在 π（左），1 号在 2π≡0（右），其余依次排布
    const theta = Math.PI + (si / Math.max(1, n)) * Math.PI * 2;
    const rHat: Vec2 = { x: Math.cos(theta), y: Math.sin(theta) };
    const tHat: Vec2 = { x: -Math.sin(theta), y: Math.cos(theta) };
    const anchor: Vec2 = { x: rHat.x * anchorR, y: rHat.y * anchorR };

    side.fleets.forEach((fleet, fi) => {
      const fleetOffset = (fi - (side.fleets.length - 1) / 2) * 18_000;
      fleet.wings.forEach((wing, wi) => {
        const wingOffset = (wi - (fleet.wings.length - 1) / 2) * 14_000;
        wing.squads.forEach((squad, qi) => {
          if (!squad.fitId) {
            warnings.push(`${side.name}/${squad.name}：未指定配置，已跳过。`);
            return;
          }
          const fit = getFit(squad.fitId);
          if (!fit) {
            warnings.push(`${side.name}/${squad.name}：配置已从配置库移除，已跳过。`);
            return;
          }
          // ★ 进引擎前最后兜一次底：配装里若混进非装备条目（历史数据/外部写入），
          //   PYFA 会整份算不出来 → 一艘船都建不出来。这里就地修补并如实提示。
          if (!sanitized.has(fit.id)) {
            sanitized.add(fit.id);
            warnings.push(...repairFitModules(fit));
          }
          const count = Math.max(0, Math.floor(squad.count));
          if (count === 0) return;

          const squadOffset = (qi - (wing.squads.length - 1) / 2) * 12_000;
          const center: Vec2 = {
            x: anchor.x + tHat.x * (fleetOffset + squadOffset) + rHat.x * wingOffset,
            y: anchor.y + tHat.y * (fleetOffset + squadOffset) + rHat.y * wingOffset,
          };
          const positions = blobFormation(count, FORMATION_SPACING, center, si * 0.7 + fi * 0.3);

          for (let k = 0; k < count; k++) {
            blueprints.push(makeBlueprint(plan, si, fi, wi, qi, k, fit, squad, positions[k] ?? center, warnings));
          }
        });
      });
    });
  });

  const celestials = makeCelestials(plan.gateCount, radiusM, rng);

  const config: BattleConfig = {
    seed,
    mode: "expected",
    blueprints,
    celestials,
    settings: { passiveShieldRegen: true, passiveCapRecharge: true },
  };

  const bySide: number[] = plan.sides.map(() => 0);
  for (const bp of blueprints) bySide[bp.sideId] = (bySide[bp.sideId] ?? 0) + 1;

  if (blueprints.length === 0) warnings.push("编成为空：请先在「战场编成」里为小队指定配置。");

  return { config, warnings, counts: { total: blueprints.length, bySide }, radiusM, landmarks: celestials.length };
}

function makeBlueprint(
  plan: FormationPlan, si: number, fi: number, wi: number, qi: number, k: number,
  fit: FitEntry, squad: SquadPlan, pos: Vec2, warnings: string[],
): UnitBlueprint {
  const role = detectRole(fit, squad);
  if (squad.autoLogi && role !== "logi") {
    warnings.push(`${squad.name}：勾选了「自动后勤链」但配置里没有遥修/传电模块，按普通单位编入。`);
  }
  const modules = fit.modules.map((m) => ({ ...m, state: m.state ?? "online" }));
  return {
    unitId: makeUnitId(si, fi, wi, qi, k),
    name: `${plan.sides[si]?.name ?? `S${si}`}-${squad.name}-${k + 1}`,
    shipName: fit.shipName,
    shipTypeId: fit.shipTypeId,
    sideId: si,
    fleetId: fi,
    wingId: wi,
    squadId: qi,
    role,
    modules,
    drones: fit.drones.map((d) => ({ ...d })),
    fighters: fit.fighters.map((f) => ({ ...f })),
    fitFingerprint: fit.id,
    doctrine: squad.doctrine as Doctrine,
    order: { type: "hold" },
    pos: { x: pos.x, y: pos.y },
  };
}

/** 角色：用户显式选择优先；勾了自动后勤链且确有后勤模块时按后勤编入。 */
function detectRole(fit: FitEntry, squad: SquadPlan): UnitBlueprint["role"] {
  const hasLogi = fit.modules.some((m) => {
    if (m.typeId === undefined) return false;
    const g = groupOf(m.typeId)?.name ?? "";
    return /远程(护盾|装甲|船体|结构|电容)/.test(g);
  });
  if (squad.autoLogi && hasLogi) return "logi";
  return squad.role;
}

/**
 * 星门：随机 1~3 个（受 `gateCount` 约束），散布在**中/外圈**（0.55R ~ 0.92R）。
 * 归属中立（`sideId: null`）—— 双方都可经它增援入场。
 * 用户明确要求：**不放中立空间站**。
 */
function makeCelestials(gateCount: number, radiusM: number, rng: () => number): Celestial[] {
  const n = Math.max(1, Math.min(3, Math.floor(gateCount) || 1));
  const out: Celestial[] = [];
  const baseAngle = rng() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const angle = baseAngle + (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.6;
    const frac = 0.55 + rng() * 0.37; // 中/外圈
    out.push({
      id: `gate:${i}`,
      kind: "stargate",
      name: `星门 ${i + 1}`,
      sideId: null,
      pos: { x: Math.cos(angle) * radiusM * frac, y: Math.sin(angle) * radiusM * frac },
      radiusM: 25_000,
    });
  }
  return out;
}

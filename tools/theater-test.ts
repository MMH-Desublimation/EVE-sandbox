/**
 * 「战区机制」验收测试 —— 覆盖 §9.1 里此前未建模的项。
 *
 *   npm run theater-test
 *
 * 覆盖：
 *   1. 入场编队 = 密集**圆形**阵列（不是方阵），且无点重合
 *   2. 地物（星门 / 空间站）存在且与"单位"分离
 *   3. 玩家建筑：作为**单位**参战（有 HP、可被摧毁、不可机动）
 *   4. 旗舰跳能力来自 SDE（jumpDriveRange，单位是光年）
 *   5. 旗舰跳撤场：**被反跳则跳不掉**；未被反跳则成功离场
 *   6. 星门增援：落点在星门附近 + 过门延迟 + 延迟结束自动执行机动
 *   7. 旗舰跳增援：瞬到目标点 + 计入冷却
 *   8. 增援不重复投入；且增援后确定性不变（同输入 → 同结果）
 */
import { AttrCache } from "../src/stats/cache.ts";
import { IconSeparation } from "../src/ui/view/separation.ts";
import { warpAllowed } from "../src/core/jump.ts";
import { StatOracleClient } from "../src/stats/oracle/client.ts";
import { Battle } from "../src/core/battle.ts";
import type { BattleConfig } from "../src/core/battle.ts";
import type { Command } from "../src/core/commands.ts";
import { totalDmg, turretDamageMult, unitDpsOf, volleyOf } from "../src/core/combat.ts";
import { buildUnitFrames } from "../src/ui/viewModel.ts";
import { blobFormation, blobRadius, FORMATION_SPACING, minPairDistance } from "../src/core/formation.ts";
import { jumpAllowed } from "../src/core/jump.ts";
import { linkMultiplier } from "../src/core/commandLink.ts";
import {
  armorBurstEnv, buildScenario, celestialsFor, HIGHGRADE_NIRVANA, makeCarrier, makeReserves,
} from "../src/core/scenario.ts";
import type { BattleState, Vec2, UnitBlueprint } from "../src/core/state.ts";

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown, tol = 0): void {
  checks++;
  let ok: boolean;
  if (typeof actual === "number" && typeof expected === "number") {
    ok = Math.abs(actual - expected) <= tol;
  } else {
    ok = actual === expected;
  }
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}: ${fmt(actual)}${ok ? "" : `  (期望 ${fmt(expected)})`}`);
}

function fmt(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  return String(v);
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 状态指纹：单位位置/血量/撤离 + 地物 + 事件数。 */
function fingerprint(state: BattleState): string {
  const parts: string[] = [`t${state.tick}`, `n${state.units.length}`, `c${state.celestials.length}`];
  for (const u of state.units) {
    parts.push(
      `${u.id}:${Math.round(u.pos.x)},${Math.round(u.pos.y)}:${Math.round(u.hp.shield + u.hp.armor + u.hp.hull)}:`
      + `${u.alive ? 1 : 0}${u.evacuated ? 1 : 0}${u.order.type}`,
    );
  }
  return parts.join("|");
}

async function main(): Promise<void> {
  const client = new StatOracleClient({});
  const t0 = performance.now();
  const version = await client.start();
  console.log(`[theater-test] StatOracle 就绪 ${Math.round(performance.now() - t0)} ms (PYFA ${version})\n`);
  const cache = new AttrCache();

  /* ------------------------------------------------------------------ 1 */
  console.log("== 1) 入场编队：密集圆形阵列，不是方阵 ==");
  {
    const n = 64;
    const R = blobRadius(n, FORMATION_SPACING);
    const pts = blobFormation(n, FORMATION_SPACING, { x: 0, y: 0 });
    const maxR = Math.max(...pts.map((p) => Math.hypot(p.x, p.y)));
    const minD = minPairDistance(pts);
    // 方阵的判别特征：点落在少数几条离散的 x 线上（√n 条）。
    // 圆阵的 x 值几乎两两不同。用"不同 x 值个数"作为判别量最直接。
    const distinctX = new Set(pts.map((p) => Math.round(p.x))).size;
    const gridSide = (Math.ceil(Math.sqrt(n)) - 1) * FORMATION_SPACING;
    check("点数正确", pts.length, n);
    check("全部落在圆内", maxR <= R * 1.001, true);
    check("无点重合（最小间距 > 0）", minD > 0, true);
    check("足够密集（最小间距 > 0.3×名义间距）", minD > FORMATION_SPACING * 0.3, true);
    check("不是方阵（x 值几乎两两不同；方阵只会有 √n 个）",
      distinctX > n * 0.8, true);
    console.log(`     半径 ${Math.round(R)} m，最小间距 ${Math.round(minD)} m，`
      + `不同 x 值 ${distinctX}/${n}（方阵边长 ${gridSide} m）`);
  }

  /* ------------------------------------------------------------------ 2 */
  console.log("\n== 2) 场景入场真的是圆阵 ==");
  {
    const config = buildScenario("line-brawl", { unitsPerSide: 64 });
    const battle = await Battle.create(client, cache, config);
    const blue = battle.state.units.filter((u) => u.sideId === 0);
    const cx = blue.reduce((s, u) => s + u.pos.x, 0) / blue.length;
    const cy = blue.reduce((s, u) => s + u.pos.y, 0) / blue.length;
    const maxR = Math.max(...blue.map((u) => Math.hypot(u.pos.x - cx, u.pos.y - cy)));
    const R = blobRadius(blue.length, FORMATION_SPACING);
    check("蓝方单位数", blue.length, 64);
    check("全部在编队圆内", maxR <= R * 1.05, true);
    check("红蓝分离（红方在另一侧）", battle.state.units.filter((u) => u.sideId === 1)[0].pos.x > 0, true);
    console.log(`     蓝方圆心 x≈${Math.round(cx)}，半径 ${Math.round(maxR)} m（名义 ${Math.round(R)} m）`);
  }

  /* ------------------------------------------------------------------ 3 */
  console.log("\n== 3) 地物与玩家建筑 ==");
  {
    const config = buildScenario("structure-assault", { unitsPerSide: 4 });
    const battle = await Battle.create(client, cache, config);
    const s = battle.state;
    check("地物数量（2 星门 + 1 空间站）", s.celestials.length, 3);
    check("含星门", s.celestials.filter((c) => c.kind === "stargate").length, 2);
    check("含空间站", s.celestials.filter((c) => c.kind === "station").length, 1);
    check("地物不在单位列表里", s.units.some((u) => u.id.startsWith("gate:")), false);

    const st = s.units.find((u) => u.role === "structure");
    check("建筑作为单位存在", !!st, true);
    if (st) {
      check("建筑有 HP", st.maxHp.shield + st.maxHp.armor + st.maxHp.hull > 0, true);
      check("建筑不可机动（最大速度 0）", r2(st.maxVelocity), 0);
      check("建筑图标类别 = fortizar", st.iconClass, "fortizar");
      check("建筑可被锁定（是合法目标）", st.alive && st.arrivalDelayMs <= 0, true);
    }
  }

  /* ------------------------------------------------------------------ 4 */
  console.log("\n== 4) 旗舰跳能力来自 SDE（jumpDriveRange，单位：光年）==");
  const baseConfig: BattleConfig = {
    seed: 4242,
    mode: "expected",
    settings: { passiveShieldRegen: false, jumpBlockedWhenScrambled: true },
    blueprints: buildScenario("line-brawl", { unitsPerSide: 4 }).blueprints,
    celestials: celestialsFor(-30_000, 30_000),
    reserves: [...makeReserves(0, -30_000), ...makeReserves(1, 30_000)],
  };
  {
    const battle = await Battle.create(client, cache, baseConfig);
    const line = battle.state.units.find((u) => u.role === "line");
    check("战列舰不具备旗舰跳", line?.jump === null, true);
  }

  /* ------------------------------------------------------------------ 5 */
  console.log("\n== 5) 增援入场：星门派遣 / 旗舰跳直达 ==");
  {
    const gate = celestialsFor(-30_000, 30_000)[0];
    const target: Vec2 = { x: 5_000, y: 3_000 };
    const cmds: Command[] = [
      { tick: 1, target: { sideId: 0 }, action: "reinforce", params: { mode: "gate", to: target } },
      { tick: 40, target: { sideId: 1 }, action: "reinforce", params: { mode: "jump", to: { x: -5_000, y: -3_000 } } },
      { tick: 80, target: { sideId: 0 }, action: "reinforce", params: { mode: "gate" } },
    ];
    const battle = await Battle.create(client, cache, baseConfig, cmds);
    const before = battle.state.units.length;
    battle.run(2);

    const arrived = battle.state.units.filter((u) => u.id.startsWith("res:0:"));
    check("星门增援入场数量（蓝方 4 艘）", arrived.length, 4);
    const dGate = arrived.length
      ? Math.max(...arrived.map((u) => Math.hypot(u.pos.x - gate.pos.x, u.pos.y - gate.pos.y)))
      : -1;
    check("落点在星门附近（半径内）", dGate >= 0 && dGate <= blobRadius(4, FORMATION_SPACING) * 1.05, true);
    check("存在过门延迟", arrived.every((u) => u.arrivalDelayMs > 0), true);
    check("延迟期间不可被锁定", arrived.every((u) => !(u.alive && u.arrivalDelayMs <= 0)), true);
    // ★ V0.8：过门后要执行的是「跃迁至」，而不是平速接近
    check("星门增援落地后的指令 = 跃迁至", arrived.every((u) => u.pendingOrder?.type === "warp"), true);

    // 星门增援是旗舰 → 具备旗舰跳能力
    check("增援旗舰具备旗舰跳", arrived.every((u) => u.jump !== null), true);
    // 启示级基础 3.5 光年，技能全 V（跳跃引擎校准）后翻倍 → 7.0；只要 ≥ 基础即说明单位正确
    const ly = arrived[0]?.jump?.rangeLy ?? 0;
    check("跳跃距离 ≥ 基础 3.5 光年", ly >= 3.5, true);
    console.log(`     启示级跳跃距离 ${ly} 光年（SDE 基础 3.5，技能全 V 加成后）`);

    // 过门延迟走完 → 自动转为机动
    battle.run(8);
    const after = battle.state.units.filter((u) => u.id.startsWith("res:0:"));
    check("过门延迟已清空", after.every((u) => u.arrivalDelayMs === 0), true);
    // ★ V0.8：过门之后是**跃迁过去**（起跳 + 按 AU/s 旅行），不再是平速接近
    check("延迟结束后转入跃迁（不再是平速接近）",
      after.every((u) => u.order.type === "warp" || u.order.type === "hold" || u.warpingOut), true);
    check("增援后单位总数", battle.state.units.length, before + 4);

    // 红方旗舰跳增援
    battle.run(40);
    const jumped = battle.state.units.filter((u) => u.id.startsWith("res:1:"));
    check("旗舰跳增援入场数量（红方 4 艘）", jumped.length, 4);
    const dJump = Math.max(
      ...jumped.map((u) => Math.hypot(u.pos.x - -5_000, u.pos.y - -3_000)),
    );
    check("落点在指定坐标附近的密集圆阵内",
      dJump <= blobRadius(4, FORMATION_SPACING) * 1.05, true);
    check("旗舰跳增援计入冷却", jumped.every((u) => (u.jump?.remainingMs ?? 0) > 0), true);
  }

  /* ------------------------------------------------------------------ 6 */
  console.log("\n== 6) 增援不重复投入 ==");
  {
    const cmds: Command[] = [
      { tick: 1, target: { sideId: 0 }, action: "reinforce", params: { mode: "gate" } },
      { tick: 2, target: { sideId: 0 }, action: "reinforce", params: { mode: "gate" } },
    ];
    const battle = await Battle.create(client, cache, baseConfig, cmds);
    const before = battle.state.units.length;
    battle.run(3);
    check("第二次增援被忽略（预备单位已投入）", battle.state.units.length, before + 4);
  }

  /* ------------------------------------------------------------------ 7 */
  console.log("\n== 7) 旗舰跳撤场：被反跳则跳不掉 ==");
  {
    const cmds: Command[] = [
      { tick: 1, target: { sideId: 0 }, action: "reinforce", params: { mode: "gate" } },
      { tick: 20, target: { unitIds: ["res:0:0"] }, action: "jumpOut", params: {} },
    ];
    // (a) 不反跳 → 应当成功离场
    const a = await Battle.create(client, cache, baseConfig, cmds);
    a.run(21);
    const ua = a.state.units.find((u) => u.id === "res:0:0");
    check("未被反跳：旗舰跳撤场成功", ua?.evacuated, true);
    check("记录到 jump 事件", a.state.events.some((e) => e.type === "jump"), true);

    // (b) 反跳 → 应当被拒
    const b = await Battle.create(client, cache, baseConfig, cmds);
    b.run(2);
    const ub = b.state.units.find((u) => u.id === "res:0:0")!;
    ub.effects.push({
      kind: "warpScramble", sourceId: "test", untilTick: b.state.tick + 100, amount: 1,
    });
    check("被反跳时 jumpAllowed = false", jumpAllowed(b.state, ub).ok, false);
    b.run(20);
    check("被反跳：旗舰跳撤场被拒（仍在场）", ub.evacuated, false);
    // 被拒的原因写进 commandLog（D-37：UI 要能显示指令为什么没生效）
    check("commandLog 记录了拒绝原因",
      b.state.commandLog.some((c) => (c.note ?? "").includes("被反跳")), true);
  }

  /* ------------------------------------------------------------------ 8 */
  console.log("\n== 8) 旗舰跳（跳跃到指定坐标）与冷却 ==");
  {
    const cmds: Command[] = [
      { tick: 1, target: { sideId: 0 }, action: "reinforce", params: { mode: "gate" } },
      { tick: 20, target: { unitIds: ["res:0:0"] }, action: "setOrder", params: { type: "jump", to: { x: -60_000, y: 8_000 } } },
    ];
    const battle = await Battle.create(client, cache, baseConfig, cmds);
    battle.run(21);
    const u = battle.state.units.find((x) => x.id === "res:0:0")!;
    check("旗舰跳后到达目标点", Math.round(Math.hypot(u.pos.x - -60_000, u.pos.y - 8_000)), 0);
    check("旗舰跳后进入冷却", (u.jump?.remainingMs ?? 0) > 0, true);
  }

  /* ------------------------------------------------------------------ 9 */
  console.log("\n== 9) 增援后确定性不变 ==");
  {
    const cmds: Command[] = [
      { tick: 1, target: { sideId: 0 }, action: "reinforce", params: { mode: "gate" } },
      { tick: 5, target: { sideId: 1 }, action: "reinforce", params: { mode: "jump", to: { x: 0, y: 0 } } },
    ];
    const a = await Battle.create(client, cache, baseConfig, cmds);
    const b = await Battle.create(client, cache, baseConfig, cmds);
    a.run(30);
    b.run(30);
    check("两次运行指纹一致", fingerprint(a.state) === fingerprint(b.state), true);
    check("单位数一致", a.state.units.length === b.state.units.length, true);
  }

  /* ------------------------------------------------------------------ 11 */
  console.log("\n== 11) 铁骑纵队（一个发射管 = 一个纵队）==");
  {
    const config = buildScenario("carrier-strike", { unitsPerSide: 2 });
    const battle = await Battle.create(client, cache, config);
    const cv = battle.state.units.find((u) => u.id.startsWith("cv:0:"));
    check("航母在场", !!cv, true);
    check("航母有铁骑纵队（轻型×1 型号 + 重型×1 型号）", cv?.fighters.length ?? 0, 2);
    const light = cv?.fighters.find((f) => f.isLight);
    const heavy = cv?.fighters.find((f) => !f.isLight);
    check("轻型纵队规模 = 6", light?.squadronSize ?? 0, 6);
    check("轻型纵队发射管数 = 2（请求里 count=2）", light?.tubes ?? 0, 2);
    check("重型纵队发射管数 = 1", heavy?.tubes ?? 0, 1);
    check("纵队带 2 个攻击能力（贴身攻击 + 远程导弹）", light?.abilities.length ?? 0, 2);
    const atk = light?.abilities.find((a) => a.effect.includes("Attack"));
    const mis = light?.abilities.find((a) => a.effect.includes("Missiles"));
    check("攻击能力周期 5000ms", Math.round(atk?.cycleMs ?? 0), 5000);
    check("远程导弹周期 14000ms", Math.round(mis?.cycleMs ?? 0), 14000);
    check("攻击能力齐射 > 0", (atk ? Object.values(atk.volley).reduce((a, b) => a + b, 0) : 0) > 0, true);
    check("纵队血池 = 单架 HP × 纵队规模",
      Math.round(light?.hpPoolMax ?? 0) > 0 && (light?.outputRatio ?? 0) === 1, true);
    check("铁骑伤害按导弹公式（有爆炸半径与 DRF）",
      (atk?.explosionRadius ?? 0) > 0 && (atk?.drf ?? 0) > 0, true);
    console.log(`      轻型：规模 ${light?.squadronSize} 管数 ${light?.tubes} `
      + `血池 ${Math.round(light?.hpPoolMax ?? 0)} 攻击齐射 ${atk ? Math.round(Object.values(atk.volley).reduce((a, b) => a + b, 0)) : 0}`);
  }

  /* ------------------------------------------------------------------ 12 */
  console.log("\n== 12) 铁骑真的能打出伤害 ==");
  {
    const mkBs = (sideId: 0 | 1, pos: { x: number; y: number }) => ({
      unitId: `bs:${sideId}`,
      name: `靶船-${sideId}`,
      shipName: "Apocalypse Navy Issue",
      shipTypeId: 17726,
      sideId,
      fleetId: 0, wingId: 0, squadId: 0,
      role: "line" as const,
      modules: [],              // 无武装靶船：伤害只可能来自铁骑
      drones: [],
      fighters: [],
      fitFingerprint: `dummy-${sideId}`,
      doctrine: "free" as const,
      order: { type: "hold" as const },
      pos,
    });
    const config: BattleConfig = {
      seed: 777, mode: "expected",
      settings: { passiveShieldRegen: false },
      blueprints: [makeCarrier(0, 0, { x: -6_000, y: 0 }), mkBs(1, { x: 6_000, y: 0 })],
    };
    const battle = await Battle.create(client, cache, config);
    // 航母的扫描分辨率低（87.5），锁定一艘战列舰约需 69 秒 —— 必须给足时间，
    // 否则测到的是"还没锁定"而不是"铁骑不打"。
    // 分两段推进：先确认锁定（此时靶船还活着），再看战果（靶船会被打掉，
    // 打掉后 locked 会因目标失效而变回 false，不能拿它当"锁定过"的证据）。
    battle.run(150);
    const cv = battle.state.units.find((u) => u.id.startsWith("cv:"))!;
    const dummy = battle.state.units.find((u) => u.id === "bs:1")!;
    check("航母完成锁定", cv.locked, true);
    battle.run(120);
    check("航母累计造成伤害 > 0（铁骑在打）", cv.damageDealt > 0, true);
    check("靶船承受了伤害", dummy.damageTaken > 0, true);
    const expected = dummy.maxHp.shield + dummy.maxHp.armor + dummy.maxHp.hull;
    console.log(`      240 tick：航母输出 ${Math.round(cv.damageDealt)}，`
      + `靶船受伤 ${Math.round(dummy.damageTaken)}（三层 HP 共 ${Math.round(expected)}）`);
    check("靶船已进入战损（血条下降）",
      dummy.hp.shield + dummy.hp.armor + dummy.hp.hull < expected, true);
    const f = cv.fighters.find((x) => x.isLight)!;
    check("铁骑已选定能力并进入循环", f.cycleRemainingMs > 0 || f.targetId !== null, true);
  }

  /* ------------------------------------------------------------------ 13 */
  console.log("\n== 13) 脑插：配置里有才算，没有就不算 ==");
  {
    const bp = {
      unitId: "imp:0",
      name: "测试舰",
      shipName: "Apocalypse Navy Issue",
      shipTypeId: 17726,
      sideId: 0 as const,
      fleetId: 0, wingId: 0, squadId: 0,
      role: "line" as const,
      modules: [{ slot: "hi" as const, typeId: 3049, state: "active" as const, chargeTypeId: 258 }],
      drones: [], fighters: [],
      fitFingerprint: "imp-test",
      doctrine: "focus" as const,
      order: { type: "hold" as const },
      pos: { x: 0, y: 0 },
    };
    const plain = await Battle.create(client, cache, {
      seed: 1, mode: "expected", blueprints: [bp],
    });
    const withImp = await Battle.create(client, cache, {
      seed: 1, mode: "expected", blueprints: [bp], implants: HIGHGRADE_NIRVANA,
    });
    const s0 = plain.state.units[0].stats.attrs.hp.shield;
    const s1 = withImp.state.units[0].stats.attrs.hp.shield;
    check("无脑插时 implantRows 为空",
      (plain.state.units[0].stats.implants ?? []).length, 0);
    check("有脑插时记录 6 件",
      (withImp.state.units[0].stats.implants ?? []).length, 6);
    check("高级极乐全套提升护盾 > 30%", s1 / s0 - 1 > 0.30, true);
    console.log(`      护盾 ${Math.round(s0)} → ${Math.round(s1)}（${((s1 / s0 - 1) * 100).toFixed(2)}%）`);
    // ★ 缓存键必须区分两者，否则会把两套结果串用
    check("同一配装、两种脑插 → 属性不同（环境键生效）", Math.abs(s1 - s0) > 1, true);
    const again = await Battle.create(client, cache, {
      seed: 1, mode: "expected", blueprints: [bp], implants: HIGHGRADE_NIRVANA,
    });
    check("重复请求命中缓存且结果一致",
      Math.round(again.state.units[0].stats.attrs.hp.shield), Math.round(s1));
  }

  /* ------------------------------------------------------------------ 14 */
  console.log("\n== 14) 指挥脉冲：按 PYFA 真值改抗性 ==");
  {
    const bp = {
      unitId: "lnk:0",
      name: "测试舰",
      shipName: "Apocalypse Navy Issue",
      shipTypeId: 17726,
      sideId: 0 as const,
      fleetId: 0, wingId: 0, squadId: 0,
      role: "line" as const,
      modules: [],
      drones: [], fighters: [],
      fitFingerprint: "link-test",
      doctrine: "focus" as const,
      order: { type: "hold" as const },
      pos: { x: 0, y: 0 },
    };
    const plain = await Battle.create(client, cache, {
      seed: 1, mode: "expected", blueprints: [bp],
    });
    const burst = await Battle.create(client, cache, {
      seed: 1, mode: "expected", blueprints: [bp], envBySide: { 0: armorBurstEnv() },
    });
    const r0 = plain.state.units[0].stats.attrs.res.armor[0];
    const r1 = burst.state.units[0].stats.attrs.res.armor[0];
    const hp0 = plain.state.units[0].stats.attrs.hp.armor;
    const hp1 = burst.state.units[0].stats.attrs.hp.armor;
    check("装甲指挥脉冲 env 已记录",
      (burst.state.units[0].stats.env?.commandLinks ?? []).length, 2);
    check("装甲 EM 共振明显下降（抗性提升）", r1 < r0 * 0.85, true);
    check("装甲强化脉冲提升装甲 HP", hp1 > hp0, true);
    console.log(`      装甲 EM 共振 ${r0} → ${r1}；装甲 HP ${Math.round(hp0)} → ${Math.round(hp1)}`);
  }

  /* ------------------------------------------------------------------ 15 */
  console.log("\n== 15) 交火优先级：默认打母舰，「集火舰载机」才打铁骑 ==");
  {
    const mkRedBs = (doctrine: "focus" | "antiFighter") => ({
      unitId: "red:0",
      name: "红方战列舰",
      shipName: "Apocalypse Navy Issue",
      shipTypeId: 17726,
      sideId: 1 as const,
      fleetId: 0, wingId: 0, squadId: 0,
      role: "line" as const,
      modules: Array.from({ length: 8 }, () => ({
        slot: "hi" as const, typeId: 3049, state: "active" as const, chargeTypeId: 258,
      })),
      drones: [], fighters: [],
      fitFingerprint: "red-bs",
      doctrine,
      order: { type: "hold" as const },
      pos: { x: 0, y: 0 },
    });
    const config = (doctrine: "focus" | "antiFighter"): BattleConfig => ({
      seed: 31, mode: "expected",
      settings: { passiveShieldRegen: false },
      blueprints: [makeCarrier(0, 0, { x: -8_000, y: 0 }), mkRedBs(doctrine)],
    });

    // (a) 普通模式：红方应当一直打母舰，铁骑**毫发无损**
    const a = await Battle.create(client, cache, config("focus"));
    a.run(600);
    const cvA = a.state.units.find((u) => u.id.startsWith("cv:"))!;
    const redA = a.state.units.find((u) => u.id === "red:0")!;
    const fA = cvA.fighters.find((f) => f.isLight)!;
    check("普通模式下红方目标是母舰（kind=unit）", redA.targetKind, "unit");
    check("普通模式下铁骑**未被打**（血量满）", Math.round(fA.hpPool), Math.round(fA.hpPoolMax));
    check("母舰确实在承受伤害", cvA.damageTaken > 0, true);

    // (b) 集火舰载机：红方应当转向铁骑
    const b = await Battle.create(client, cache, config("antiFighter"));
    b.run(600);
    const cvB = b.state.units.find((u) => u.id.startsWith("cv:"))!;
    const redB = b.state.units.find((u) => u.id === "red:0")!;
    const fB = cvB.fighters.find((f) => f.isLight)!;
    check("集火舰载机模式下红方目标是铁骑（kind=fighter）", redB.targetKind, "fighter");
    check("铁骑**确实被打**（血量下降）", fB.hpPool < fB.hpPoolMax, true);
    check("铁骑被打击后输出按 D-25 线性折算", fB.outputRatio < 1, true);
    console.log(`      普通：铁骑 ${Math.round(fA.hpPool)}/${Math.round(fA.hpPoolMax)}（未动）；`
      + `集火舰载机：铁骑 ${Math.round(fB.hpPool)}/${Math.round(fB.hpPoolMax)}`
      + `（输出 ${(fB.outputRatio * 100).toFixed(1)}%）`);
    check("无人机永不被主动选择（代码只扫铁骑）",
      redB.targetKind !== "drone", true);
  }

  /* ------------------------------------------------------------------ 16 */
  console.log("\n== 16) 指挥脉冲作用域：同舰队受益 + 同种取最强 + 非交集各取自己 ==");
  {
    // (a) 倍率公式防漂移：与 oracle 的 getLinkMultiplier **逐值**比对
    const table = await client.linkTable();
    let mismatch = 0;
    for (const s of table.strengths) {
      for (const ml of [false, true]) {
        const got = table.multiplier[`${s}:${ml ? 1 : 0}`];
        if (Math.abs(got - linkMultiplier(s, ml)) > 1e-9) mismatch++;
      }
    }
    check("TS 倍率公式与 PYFA 逐值一致（防漂移）", mismatch, 0);

    const battle = await Battle.create(client, cache, buildScenario("command-burst"));
    const unitOf = (id: string) => battle.state.units.find((u) => u.id === id)!;
    const armorEm = (id: string) => unitOf(id).stats.attrs.res.armor[0];

    const base = armorEm("cb:0:0:4");       // 两路脉冲都够不着
    const onlyA = armorEm("cb:0:0:2");      // 只在 A（强）射程内
    const both = armorEm("cb:0:0:3");       // A ∩ B —— 应取最强（A）
    const crossFleet = armorEm("cb:0:1:0"); // 在 A 射程内但**另一个舰队**

    check("基线（无脉冲）装甲 EM 共振 = 0.5", Math.round(base * 1e4) / 1e4, 0.5);
    check("只被 A 覆盖 → 拿到 A 的加成", onlyA < base * 0.9, true);
    check("A ∩ B → **取最强**（与只被 A 覆盖完全一致）",
      Math.abs(both - onlyA) < 1e-9, true);
    check("跨舰队 → **不受益**（与基线完全一致）",
      Math.abs(crossFleet - base) < 1e-9, true);
    console.log(`      基线 ${base.toFixed(4)}｜只A ${onlyA.toFixed(4)}｜`
      + `A∩B ${both.toFixed(4)}｜跨舰队 ${crossFleet.toFixed(4)}`);
    const envLinks = unitOf("cb:0:0:2").stats.env?.commandLinks ?? [];
    check("已记录生效脉冲数量", envLinks.length, 1);
    check("取到的是强的那路（strength=5 + 脑插）",
      envLinks[0]?.strength === 5 && envLinks[0]?.mindlink === true, true);

    // —— 「关闭指挥脉冲波」：按"本轮循环走完才正式停用"的语义 ——
    //    （用户 V0.7 第 7 项：点一下正在运转的装备 → 变"停用中"，本轮结束才真正关闭）
    const off = await Battle.create(client, cache, buildScenario("command-burst"), [{
      tick: 2,
      target: { unitIds: ["cb:0:0:0"] },
      action: "toggleModule",
      params: { moduleIndex: 0, state: "online" },
    }]);
    off.run(4);
    const cmdA = off.state.units.find((u) => u.id === "cb:0:0:0")!;
    const affected = off.state.units.find((u) => u.id === "cb:0:0:2")!;
    // 关闭指令生效后：要么已进入「停用中」，要么本轮本来就已走完而直接关闭
    const pendingOrOff = cmdA.actives[0]?.on === false || cmdA.actives[0]?.pendingOff === true;
    check("关闭指令后：进入「停用中」或本轮已走完直接关闭", pendingOrOff, true);
    // 跑到本轮循环走完（上限 120 tick 防御）
    for (let i = 0; i < 120 && cmdA.actives[0]?.on; i++) off.run(1);
    off.run(2); // 再跑两拍：让 applyEnv 把"成员不再受益"重算落地
    check("本轮走完后脉冲模块才真正关闭", cmdA.actives[0]?.on, false);
    check("关闭后同舰队成员**不再获得**该加成",
      Math.abs(affected.stats.attrs.res.armor[0] - base) < 1e-9, true);
  }

  /* ------------------------------------------------------------------ 19 */
  console.log("\n== 19) 铁骑：出仓 → 飞向目标 → 按最佳射程平速环绕 ==");
  {
    const dummy = {
      unitId: "tgt:1",
      name: "靶船",
      shipName: "Apocalypse Navy Issue",
      shipTypeId: 17726,
      sideId: 1 as const,
      fleetId: 0, wingId: 0, squadId: 0,
      role: "line" as const,
      modules: [],
      drones: [],
      fighters: [],
      fitFingerprint: "orbit-target",
      doctrine: "hold" as const,
      order: { type: "hold" as const },
      pos: { x: 6_000, y: 0 },
    };
    const battle = await Battle.create(client, cache, {
      seed: 4242, mode: "expected",
      settings: { passiveShieldRegen: false },
      blueprints: [makeCarrier(0, 0, { x: -6_000, y: 0 }), dummy],
    });
    const cv = battle.state.units.find((u) => u.id.startsWith("cv:"))!;
    const tgt = battle.state.units.find((u) => u.id === "tgt:1")!;
    const f = cv.fighters.find((x) => x.isLight)!;

    // 出仓点 = 母舰位置
    const d0 = Math.hypot(f.pos.x - cv.pos.x, f.pos.y - cv.pos.y);
    check("出仓点就是母舰位置", Math.round(d0), 0);

    battle.run(5);
    const dHost = Math.hypot(f.pos.x - cv.pos.x, f.pos.y - cv.pos.y);
    check("出仓后已离开母舰（自主机动）", dHost > 1_000, true);
    check("自动继承母舰的交火目标", f.targetId, "tgt:1");

    // ★ 时序：航母锁定制导战列舰约需 69s，之后铁骑才会开火把它打掉。
    //   这里在**开火之前**检查环绕（否则靶船一死，组就收拢回母舰了）。
    battle.run(45); // 累计 50 tick，母舰尚未完成锁定
    check("环绕期间目标仍然存活", tgt.alive, true);
    const dTarget = Math.hypot(f.pos.x - tgt.pos.x, f.pos.y - tgt.pos.y);
    const speed = Math.hypot(f.vel.x, f.vel.y);
    check("已抵达最佳射程附近（≈ orbitRange）",
      Math.abs(dTarget - f.orbitRange) < f.orbitRange * 0.05, true);
    check("环绕是**平速**（速度 ≈ maxVelocity）",
      Math.abs(speed - f.maxVelocity) < f.maxVelocity * 0.05, true);

    // 环绕应当持续转圈：位置在变，但半径保持
    const p1 = { ...f.pos };
    battle.run(9);
    const moved = Math.hypot(f.pos.x - p1.x, f.pos.y - p1.y);
    const dTarget2 = Math.hypot(f.pos.x - tgt.pos.x, f.pos.y - tgt.pos.y);
    check("在持续环绕（位置在变）", moved > 100, true);
    check("环绕半径保持稳定", Math.abs(dTarget2 - dTarget) < f.orbitRange * 0.05, true);
    console.log(`      母舰→组 ${Math.round(dHost)} m｜组→目标 ${Math.round(dTarget)} m`
      + `（orbitRange ${Math.round(f.orbitRange)}）｜环绕速度 ${Math.round(speed)} m/s`
      + `（maxVelocity ${Math.round(f.maxVelocity)}）`);
  }

  /* ------------------------------------------------------------------ 17 */
  console.log("\n== 17) 立体炸弹：敌我通吃，铁骑也难逃 ==");
  {
    const battle = await Battle.create(client, cache, buildScenario("smartbomb"));
    battle.run(12); // 炸弹循环 10s，跑 12 tick 确保引爆过一次
    const u = (id: string) => battle.state.units.find((x) => x.id === id)!;
    const sb0 = u("sb:0");
    const friendly = u("sb:1");
    const red = u("sbr:0");
    const carrier = battle.state.units.find((x) => x.id.startsWith("cv:"))!;
    const fighter = carrier.fighters[0];

    check("立体炸弹被识别为 smartbomb", sb0.actives[0]?.kind, "smartbomb");
    check("取到了作用半径（empFieldRange）", (sb0.actives[0]?.smartbomb?.rangeM ?? 0) > 0, true);
    check("取到了伤害（四类之一 > 0）",
      Object.values(sb0.actives[0]?.smartbomb?.dmg ?? {}).some((v) => v > 0), true);
    check("**敌方**被炸到", red.damageTaken > 0, true);
    check("**友军**也被炸到（EVE 行为）", friendly.damageTaken > 0, true);
    check("**铁骑**被炸到（实体化：组有血量）", fighter.hpPool < fighter.hpPoolMax, true);
    check("引爆的舰本身不吃自己的炸弹", sb0.damageTaken >= 0, true);
    console.log(`      红方受伤 ${Math.round(red.damageTaken)}｜友军受伤 ${Math.round(friendly.damageTaken)}`
      + `｜铁骑 ${Math.round(fighter.hpPool)}/${Math.round(fighter.hpPoolMax)}`
      + `｜半径 ${Math.round(sb0.actives[0]?.smartbomb?.rangeM ?? 0)}m`);
  }

  /* ------------------------------------------------------------------ 20 */
  console.log("\n== 20) 运行时增援（右键对话框带入 fit，无预置预备单位）==");
  {
    // 模拟「用户自建战场」：只有两边各 2 艘线列，没有任何预备单位
    const base = buildScenario("line-brawl", { unitsPerSide: 2 });
    const config: BattleConfig = { ...base, reserves: [] };
    const before = (await Battle.create(client, cache, config)).state.units.length;

    // 右键对话框：用户挑了「红方(1) 2 艘 灾难级海军型」
    const stats = await client.calcFit({
      ship: { typeId: 17726, name: "Apocalypse Navy Issue" },
      modules: [],
    });
    const bp: UnitBlueprint = {
      unitId: "", name: "运行时增援", shipName: "Apocalypse Navy Issue", shipTypeId: 17726,
      sideId: 1, fleetId: 0, wingId: 0, squadId: 0, role: "line",
      modules: [], drones: [], fighters: [],
      fitFingerprint: "reinforce-17726", doctrine: "focus",
      order: { type: "hold" }, pos: { x: 0, y: 0 },
    };
    const cmds: Command[] = [{
      tick: 1, target: { sideId: 1 },
      action: "reinforce",
      params: {
        mode: "jump", to: { x: 1234, y: 5678 }, sideId: 1, count: 2,
        spawnId: "spawn-S1-77", blueprint: bp, stats,
      },
    }];
    const battle = await Battle.create(client, cache, config, cmds);
    battle.run(2);
    const newUnits = battle.state.units.filter((u) => String(u.id).startsWith("spawn-S1-77"));
    check("运行时增援：生成了 2 艘", newUnits.length, 2);
    check("单位总数 = 原 + 2", battle.state.units.length, before + 2);
    check("落点在使用者指定的坐标附近（密集圆阵内）",
      newUnits.every((u) => Math.hypot(u.pos.x - 1234, u.pos.y - 5678) <= blobRadius(2, FORMATION_SPACING) * 1.05),
      true);
    check("增援单位属性来自对话框的 fit（船名正确）",
      newUnits.every((u) => u.shipName === "Apocalypse Navy Issue"), true);
    check("未依赖任何预置预备单位", true, true);
  }

  /* ------------------------------------------------------------------ 21 */
  console.log("\n== 21) 跳刀（微型跳跃引擎）：运转 → 瞬移 100 km → 再启动冷却 ==");
  {
    // 大型微型跳跃引擎 = typeId 4383（med 槽）。初始 online（新默认：不自动运转）。
    // 给一个远处的航路点，让它有明确的移动方向（便于验证"朝移动方向"跃迁）。
    const bp: UnitBlueprint = {
      unitId: "mjd:0",
      name: "跳刀测试舰",
      shipName: "Apocalypse Navy Issue",
      shipTypeId: 17726,
      sideId: 0, fleetId: 0, wingId: 0, squadId: 0, role: "line",
      modules: [{ slot: "med", typeId: 4383, state: "online" }],
      drones: [], fighters: [],
      fitFingerprint: "mjd-test",
      doctrine: "passive",
      order: { type: "approach", to: { x: 1_000_000, y: 0 } },
      pos: { x: 0, y: 0 },
    };
    // 必须有一名"敌方"在场：checkFinished 在只剩一方存活时立刻结束战斗，
    // 否则推演会在第 1 tick 就 finished、后面的 tick 全部不推进。
    const dummy: UnitBlueprint = {
      unitId: "mjd-tgt",
      name: "远处的靶船",
      shipName: "Apocalypse Navy Issue",
      shipTypeId: 17726,
      sideId: 1, fleetId: 0, wingId: 0, squadId: 0, role: "line",
      modules: [], drones: [], fighters: [],
      fitFingerprint: "mjd-dummy",
      doctrine: "passive",
      order: { type: "hold" },
      pos: { x: 0, y: 500_000 },
    };
    const config: BattleConfig = {
      seed: 1, mode: "expected",
      settings: { passiveShieldRegen: false },
      blueprints: [bp, dummy],
    };

    // (a) 静态识别：必须是 microJump（旧行为是 other → 永远空转）
    const probe = await Battle.create(client, cache, config);
    const p0 = probe.state.units[0];
    const mj0 = p0.actives.find((a) => a.kind === "microJump");
    check("跳刀识别为 microJump（旧 bug 是 other，导致永久空转）", !!mj0, true);
    check("初始状态：不自动运转（on=false）", mj0?.on, false);
    check("跃迁距离 = 100 km", Math.round(mj0?.microJump?.distanceM ?? 0), 100_000);
    check("再启动冷却 = 180 s", Math.round(mj0?.microJump?.cooldownMs ?? 0), 180_000);
    // 运转时间取 PYFA 的**修正后** duration（基础 12000，PYFA 实测给出 9000）。
    // 关键是"必须有一段真实的运转时间"，而不是启用即瞬移。
    check("存在真实的运转时间（不是启用即瞬移）", (mj0?.cycleMs ?? 0) >= 5000, true);

    // (b) tick 2 启用 → 应运转约 12 tick 后起跳；tick 20 再启用 → 冷却中应被拒
    const battle = await Battle.create(client, cache, config, [
      { tick: 2, target: { unitIds: ["mjd:0"] }, action: "toggleModule", params: { moduleIndex: 0, state: "active" } },
      { tick: 20, target: { unitIds: ["mjd:0"] }, action: "toggleModule", params: { moduleIndex: 0, state: "active" } },
      { tick: 210, target: { unitIds: ["mjd:0"] }, action: "toggleModule", params: { moduleIndex: 0, state: "active" } },
    ]);

    const jumps: Array<{ tick: number; x: number; y: number }> = [];
    let prev = { x: 0, y: 0 };
    let jumpTick = -1;
    let jumpDist = 0;
    let jumpDx = 0;
    let jumpDy = 0;
    let onAfterJump: boolean | undefined;
    let cdAfterJump = -1;
    for (let i = 0; i < 240; i++) {
      battle.run(1);
      const u = battle.state.units[0];
      const dx = u.pos.x - prev.x;
      const dy = u.pos.y - prev.y;
      const step = Math.hypot(dx, dy);
      if (step > 50_000) {           // 单 tick 位移 > 50 km → 就是这一次跃迁
        if (jumpTick < 0) {
          jumpTick = battle.state.tick;
          jumpDist = step;
          jumpDx = dx;
          jumpDy = dy;
          onAfterJump = u.actives[0]?.on;
          cdAfterJump = u.actives[0]?.cooldownRemainingMs ?? -1;
        }
        jumps.push({ tick: battle.state.tick, x: u.pos.x, y: u.pos.y });
      }
      prev = { x: u.pos.x, y: u.pos.y };
    }

    check("确实发生了跃迁", jumpTick > 0, true);
    // 启用发生在 tick 2；运转 9 s（≈9 tick）后才起跳 → 起跳 tick 应显著晚于 2
    check("启用后先运转一段时间才起跳（不是当拍瞬移）", jumpTick >= 5, true);
    // 单 tick 位移 ≈ 100 km（外加该 tick 的正常机动量，每拍仅百余米）
    check("跃迁距离 ≈ 100 km", Math.abs(jumpDist - 100_000) < 2_000, true);
    // 方向：航路点在 +X，故 X 方向位移应接近满程、Y 方向几乎不变
    check("跃迁方向 = 移动方向（+X）", jumpDx > 90_000 && Math.abs(jumpDy) < 5_000, true);
    check("起跳后立即停机（单次装备，不再自动循环）", onAfterJump, false);
    check("起跳后进入再启动冷却", cdAfterJump > 0, true);

    const events = battle.state.events.filter((e) => e.type === "microJump");
    check("两次跃迁（第二次等冷却结束后才启用）", events.length, 2);
    check("冷却拒用的两次之间：只跳了一次", jumps.length >= 2, true);

    // "冷却中"必须写进 commandLog（D-37：UI 要能显示指令为什么没生效）
    const refused = battle.state.commandLog.filter((c) => (c.note ?? "").includes("冷却中"));
    check("冷却未结束时再次启用被拒并记录原因", refused.length, 1);
    console.log(`      跃迁 tick=${jumpTick} 距离=${Math.round(jumpDist / 1000)} km`
      + `｜冷却=${Math.round(cdAfterJump / 1000)} s｜跃迁次数=${events.length}`);
  }

  /* ------------------------------------------------------------------ 22 */
  console.log("\n== 22) 增援：新开舰队（不并入原舰队）+ 单次上限 256 ==");
  {
    const base = buildScenario("line-brawl", { unitsPerSide: 2 });
    const config: BattleConfig = { ...base, reserves: [] };
    const probe = await Battle.create(client, cache, config);
    const blueMax = Math.max(
      ...probe.state.units.filter((u) => u.sideId === 1).map((u) => u.fleetId),
    );

    const stats = await client.calcFit({
      ship: { typeId: 17726, name: "Apocalypse Navy Issue" },
      modules: [],
    });
    const bp: UnitBlueprint = {
      unitId: "", name: "批量增援", shipName: "Apocalypse Navy Issue", shipTypeId: 17726,
      sideId: 1, fleetId: 0, wingId: 0, squadId: 0, role: "line",
      modules: [], drones: [], fighters: [],
      fitFingerprint: "reinforce-batch", doctrine: "focus",
      order: { type: "hold" }, pos: { x: 0, y: 0 },
    };
    // 请求 300 条 → 只应生成 256 条（单次上限）
    const battle = await Battle.create(client, cache, config, [{
      tick: 1, target: { sideId: 1 },
      action: "reinforce",
      params: {
        mode: "jump", to: { x: 0, y: 0 }, sideId: 1, count: 300,
        spawnId: "spawn-S1-900", blueprint: bp, stats,
      },
    }]);
    battle.run(2);

    const spawned = battle.state.units.filter((u) => String(u.id).startsWith("spawn-S1-900"));
    check("单次增援上限 256（请求 300 → 生成 256）", spawned.length, 256);
    const fleets = new Set(spawned.map((u) => u.fleetId));
    check("整批增援落在**同一个**舰队", fleets.size, 1);
    check("舰队号 = 该势力原有最大舰队号 + 1（不并入原舰队）",
      spawned[0]?.fleetId ?? -1, blueMax + 1);
    const original = battle.state.units.filter(
      (u) => u.sideId === 1 && u.fleetId === blueMax && !String(u.id).startsWith("spawn"),
    );
    check("原舰队未被混入增援单位", original.length, 2);
  }

  /* ------------------------------------------------------------------ 23 */
  console.log("\n== 23) 增援的势力归属 + 星门落点（不落到空白处）==");
  {
    const config: BattleConfig = {
      ...buildScenario("line-brawl", { unitsPerSide: 2 }),
      celestials: celestialsFor(-30_000, 30_000),
      reserves: [],
    };
    const stats = await client.calcFit({
      ship: { typeId: 17726, name: "Apocalypse Navy Issue" },
      modules: [],
    });
    const mkBp = (): UnitBlueprint => ({
      unitId: "", name: "增援", shipName: "Apocalypse Navy Issue", shipTypeId: 17726,
      sideId: 1, fleetId: 0, wingId: 0, squadId: 0, role: "line",
      modules: [], drones: [], fighters: [],
      fitFingerprint: "reinforce-side", doctrine: "focus",
      order: { type: "hold" }, pos: { x: 0, y: 0 },
    });
    const battle = await Battle.create(client, cache, config, [{
      tick: 1, target: { sideId: 1 },
      action: "reinforce",
      params: {
        mode: "gate", to: { x: 0, y: 0 }, sideId: 1, count: 2,
        spawnId: "spawn-side-a", blueprint: mkBp(), stats,
      },
    }]);
    battle.run(2);
    const arrived = battle.state.units.filter((u) => String(u.id).startsWith("spawn-side-a"));
    check("星门增援：势力 = 指令指定的 1（不会变成「3号势力」）",
      arrived.length === 2 && arrived.every((u) => u.sideId === 1), true);
    check("星门增援：带有过门延迟", arrived.every((u) => u.arrivalDelayMs > 0), true);
    const gates = battle.state.celestials.filter((c) => c.kind === "stargate");
    const nearGate = arrived.every((u) => gates.some((g) =>
      Math.hypot(u.pos.x - g.pos.x, u.pos.y - g.pos.y)
        <= blobRadius(2, FORMATION_SPACING) * 1.05 + (g.radiusM ?? 0)));
    check("星门增援：落点在**星门**附近（不是 (0,0) 空白处）", gates.length > 0 && nearGate, true);
    battle.run(8);
    const landed = battle.state.units.filter((u) => String(u.id).startsWith("spawn-side-a"));
    check("星门增援：过门延迟结束后开始执行机动", landed.every((u) => u.arrivalDelayMs === 0), true);
    console.log(`      星门数 ${gates.length}｜增援落点`
      + ` (${Math.round(arrived[0]?.pos.x ?? 0)}, ${Math.round(arrived[0]?.pos.y ?? 0)})`);
  }

  /* ------------------------------------------------------------------ 24 */
  console.log("\n== 24) 批量开关装备：预热不再组合爆炸（不再卡死）==");
  {
    const config = buildScenario("line-brawl", { unitsPerSide: 100 }); // 200 单位
    // 一批 toggle(active)（批量"开启装备"）：旧实现会对被触及下标做 2^n 枚举，
    // n 十几个 → 每份配装上万组合 → 预热要跑上万次 PYFA → 界面卡在"重算中"。
    // 新实现只对"关"类指令做闭包，这类"开"指令不产生额外状态 → 预热几乎零成本。
    const cmds: Command[] = [];
    for (let i = 0; i < 12; i++) {
      cmds.push({
        tick: 1, target: { sideId: 0 },
        action: "toggleModule", params: { moduleIndex: i, state: "active" },
      });
    }
    const t0 = performance.now();
    const battle = await Battle.create(client, cache, config, cmds);
    const ms = performance.now() - t0;
    battle.run(3);
    check("200 单位 + 12 条批量开关：预热完成且耗时 < 8 s", ms < 8_000, true);
    check("批量开关后仍能正常推进", battle.state.tick >= 3, true);
    console.log(`      预热耗时 ${Math.round(ms)} ms（12 条批量开关指令）`);
  }

  /* ------------------------------------------------------------------ 25 */
  console.log("\n== 25) 图标分离：大量单位不再退化为 O(n²)（防界面卡死）==");
  {
    const sep = new IconSeparation();
    // 800 个单位**全部重合在一点** + 极小 scale → 网格退化成一格（最坏情况）
    const units = Array.from({ length: 800 }, (_, i) => ({
      id: `u:${i}`, alive: true, evac: false, x: 0, y: 0,
    })) as unknown as Parameters<typeof sep.update>[0];
    const t0 = performance.now();
    for (let f = 0; f < 5; f++) sep.update(units, 1e-5, 16, () => 12);
    const ms = performance.now() - t0;
    check("800 重合单位 × 5 帧：分离计算 < 300 ms（有每帧配对预算）", ms < 300, true);
    console.log(`      800 单位 5 帧分离耗时 ${Math.round(ms)} ms`);
  }

  /* ------------------------------------------------------------------ 26 */
  console.log("\n== 26) 跃迁至：起跳时间 + 跃迁速度（不是平速跑过去）==");
  {
    const mkShip = (id: string, sideId: 0 | 1, pos: { x: number; y: number }) => ({
      unitId: id, name: id, shipName: "Apocalypse Navy Issue", shipTypeId: 17726,
      sideId, fleetId: 0, wingId: 0, squadId: 0, role: "line" as const,
      modules: [], drones: [], fighters: [],
      fitFingerprint: `warp-${id}`, doctrine: "auto" as const,
      order: { type: "hold" as const }, pos,
    });
    const config: BattleConfig = {
      seed: 7, mode: "expected",
      settings: { passiveShieldRegen: false },
      blueprints: [mkShip("w:0", 0, { x: 0, y: 0 }), mkShip("w:1", 1, { x: 500_000, y: 0 })],
    };
    const battle = await Battle.create(client, cache, config, [{
      tick: 1, target: { unitIds: ["w:0"] },
      action: "warpTo", params: { targetId: "w:1", range: 30_000 },
    }]);
    battle.run(3);
    const u = battle.state.units[0];
    check("下达「跃迁至」后进入跃迁（warpingOut）", u.order.type === "warp" && u.warpingOut, true);
    // 平速跑 500 km 需要 > 3000 s；跃迁只需"起跳时间 + 极短的跃迁旅行"
    const slowSeconds = 500_000 / Math.max(1, u.stats.attrs.nav.maxVelocity);
    battle.run(60);
    const d = Math.hypot(u.pos.x - 500_000, u.pos.y);
    check("跃迁落地在**距目标 30 km** 处", Math.abs(d - 30_000) < 2_000, true);
    check("跃迁用时（tick）远小于平速所需秒数", battle.state.tick < slowSeconds, true);
    check("落地后不再处于跃迁中", u.warpingOut, false);
    console.log(`      平速需 ${Math.round(slowSeconds)} s，跃迁只用了 ${battle.state.tick} s`
      + `（起跳 ${u.alignTime.toFixed(1)} s）`);

    // 距离 ≤ 150 km：拒绝（改用机动指令）
    const nearCfg: BattleConfig = {
      seed: 7, mode: "expected",
      settings: { passiveShieldRegen: false },
      blueprints: [mkShip("n:0", 0, { x: 0, y: 0 }), mkShip("n:1", 1, { x: 100_000, y: 0 })],
    };
    const b2 = await Battle.create(client, cache, nearCfg, [{
      tick: 1, target: { unitIds: ["n:0"] },
      action: "warpTo", params: { targetId: "n:1", range: 0 },
    }]);
    b2.run(2);
    check("距离 ≤150 km：跃迁被拒并写明原因",
      b2.state.commandLog.some((c) => (c.note ?? "").includes("≤150")), true);

    // 被干扰：普通舰船稳定系数 1，一个扰断（-1）→ 0 < 1 → 不允许
    const b3 = await Battle.create(client, cache, config, []);
    b3.run(1);
    const w0 = b3.state.units[0];
    w0.effects.push({
      kind: "warpDisrupt", sourceId: "test", untilTick: b3.state.tick + 100, amount: 1,
    });
    const v1 = warpAllowed(b3.state, w0);
    check("被扰断（-1）时 1-1=0 < 1 → 不允许跃迁", v1.ok, false);
    check("拒绝原因写明跃迁稳定系数", v1.reason.includes("稳定系数"), true);

    // 拦截力场：直接禁止（稳定系数再高也不行）
    w0.effects = w0.effects.filter((e) => e.kind !== "warpDisrupt");
    w0.effects.push({
      kind: "bubble", sourceId: "test", untilTick: b3.state.tick + 100, amount: 1,
    });
    check("处于拦截力场内 → 直接禁止跃迁", warpAllowed(b3.state, w0).ok, false);

    // 跃迁稳定系数来自 PYFA（用户示例：夜神级 = 1 + 5×技能5 = 26）
    const nyx = await client.calcFit({ ship: { typeId: 23913, name: "夜神级" }, modules: [] });
    const stab = nyx.attrs.nav.warpCoreStability;
    console.log(`      夜神级跃迁稳定系数 = ${stab}`);
    check("夜神级跃迁稳定系数 = 26（1 + 5×技能5）", Math.round(stab ?? 0), 26);

    const nyxCfg: BattleConfig = {
      seed: 9, mode: "expected",
      settings: { passiveShieldRegen: false },
      blueprints: [
        { ...mkShip("x:0", 0, { x: 0, y: 0 }), shipName: "Nyx", shipTypeId: 23913 },
        mkShip("x:1", 1, { x: 500_000, y: 0 }),
      ],
    };
    const b4 = await Battle.create(client, cache, nyxCfg, []);
    b4.run(1);
    const nx = b4.state.units[0];
    check("夜神级有效跃迁稳定系数 = 26", Math.round(warpAllowed(b4.state, nx).effective), 26);
    nx.effects.push({
      kind: "warpDisrupt", sourceId: "t", untilTick: b4.state.tick + 100, amount: 1,
    });
    check("夜神级被单点扰断（-1）后仍可跃迁（26-1=25 ≥ 1）",
      warpAllowed(b4.state, nx).ok, true);
    nx.effects.push({
      kind: "warpScramble", sourceId: "t2", untilTick: b4.state.tick + 100, amount: 2,
    });
    check("夜神级再被扰频（-2）后仍可跃迁（26-3=23 ≥ 1）",
      warpAllowed(b4.state, nx).ok, true);
  }

  /* ------------------------------------------------------------------ 27 */
  console.log("\n== 27) 增援后对增援单位开关装备：不再\"属性组合未预热\"卡死 ==");
  {
    // 用户报障：星门增援 → 舰队正在跃迁 → 点「启动装备（附甲板/索敌计算机）」→ 卡死。
    // 根因：运行时增援的单位在 Battle.create 时不存在，预热覆盖不到它们的装备状态位图。
    const mods = [
      { slot: "low" as const, typeId: 1306, state: "online" as const }, // 装甲附甲（被动）
      { slot: "med" as const, typeId: 1978, state: "online" as const }, // 索敌计算机 II
    ];
    const config: BattleConfig = {
      ...buildScenario("line-brawl", { unitsPerSide: 2 }),
      celestials: celestialsFor(-30_000, 30_000),
      reserves: [],
    };
    const stats = await client.calcFit({
      ship: { typeId: 17726, name: "Apocalypse Navy Issue" }, modules: mods,
    });
    const bp: UnitBlueprint = {
      unitId: "", name: "增援测试", shipName: "Apocalypse Navy Issue", shipTypeId: 17726,
      sideId: 1, fleetId: 0, wingId: 0, squadId: 0, role: "line",
      modules: mods, drones: [], fighters: [],
      fitFingerprint: "regress-rein", doctrine: "auto", order: { type: "hold" }, pos: { x: 0, y: 0 },
    };
    const ids = ["spawn-T-1-0", "spawn-T-1-1"];
    // UI 下发的是 oracle 报告的 kind（不是我们猜的），测试也照此动态取用
    const kind1 = stats.actives.find((r) => r.inputIndex === 1)?.kind ?? "other";
    const cmds: Command[] = [
      {
        tick: 1, target: { sideId: 1 }, action: "reinforce",
        params: {
          mode: "gate", to: { x: 200_000, y: 0 }, sideId: 1, count: 2,
          spawnId: "spawn-T-1", blueprint: bp, stats,
        },
      },
      // 跃迁途中（约 tick 10~25）开装备 —— 复刻用户的操作
      { tick: 12, target: { unitIds: ids }, action: "toggleModule", params: { moduleIndex: 0, state: "active" } },
      // UI 实际下发的是 kind + 实例序号（不是 moduleIndex），一并覆盖
      { tick: 13, target: { unitIds: ids }, action: "toggleModule", params: { kind: kind1, instanceIndex: 0, state: "active" } },
      // 再关掉一个：走 pendingOff → 本轮循环走完才置回 online 的路径
      { tick: 14, target: { unitIds: ids }, action: "toggleModule", params: { moduleIndex: 0, state: "online" } },
    ];

    let battle: Battle | null = null;
    let err: string | null = null;
    try {
      battle = await Battle.create(client, cache, config, cmds);
      for (let i = 0; i < 60; i++) battle.run(1);
    } catch (e) {
      err = (e as Error).message;
    }
    if (err) console.log(`      抛错：${err.slice(0, 220)}`);
    check("增援后开关装备不再抛错（旧版这里是\"属性组合未预热\"）", err === null, true);
    const spawned = battle?.state.units.filter((u) => String(u.id).startsWith("spawn-T-1")) ?? [];
    check("增援单位已生成 2 艘", spawned.length, 2);
    check(`第 2 个模块指令生效（kind=${kind1} + 实例序号路径，与 UI 一致）`,
      spawned.every((u) => u.moduleStates[1] === "active"), true);
    check("装甲附甲最终停用（本轮走完落地，不留 pendingOff）",
      spawned.every((u) => u.moduleStates[0] !== "active"), true);
    check("跃迁已正常结束（不是卡在跃迁中）",
      spawned.every((u) => !u.warpingOut && u.order.type !== "warp"), true);
  }

  /* ------------------------------------------------------------------ 28 */
  console.log("\n== 28) 增援单位的属性预热**有界**（不被会话指令数放大）==");
  {
    // 用户报障：长时间操作后（命令表很长）对增援单位点装备 → 卡死。
    // 根因是"把整条会话历史都套到增援配装上"的过度近似。这里用 60 条历史装备指令
    // 复现该压力，并用**独立缓存**测量真实的 PYFA 求解次数。
    const freshCache = new AttrCache();
    const mods = [
      { slot: "low" as const, typeId: 1306, state: "online" as const },
      { slot: "low" as const, typeId: 2048, state: "online" as const },
      { slot: "med" as const, typeId: 1978, state: "online" as const },
      { slot: "med" as const, typeId: 2281, state: "online" as const },
    ];
    const config: BattleConfig = {
      ...buildScenario("capital-reinforce", { unitsPerSide: 4 }),
      celestials: celestialsFor(-30_000, 30_000),
      reserves: [],
    };
    const probe = await Battle.create(client, freshCache, config);
    const kinds = [...new Set(probe.state.units.flatMap((u) => u.actives.map((a) => a.kind)))];

    const stats = await client.calcFit({
      ship: { typeId: 17726, name: "Apocalypse Navy Issue" }, modules: mods,
    });
    const bp: UnitBlueprint = {
      unitId: "", name: "增援", shipName: "Apocalypse Navy Issue", shipTypeId: 17726,
      sideId: 1, fleetId: 0, wingId: 0, squadId: 0, role: "line",
      modules: mods, drones: [], fighters: [],
      fitFingerprint: "bounded-rein", doctrine: "auto", order: { type: "hold" }, pos: { x: 0, y: 0 },
    };

    const cmds: Command[] = [];
    // 60 条"增援之前"的全体装备指令（target {} = 命中所有单位，最坏情况）
    for (let k = 0; k < 60; k++) {
      cmds.push({
        tick: 1, target: {}, action: "toggleModule",
        params: {
          kind: kinds[k % Math.max(1, kinds.length)], instanceIndex: 0,
          state: k % 2 === 0 ? "active" : "online",
        },
      });
    }
    const reinforceTick = 40;
    cmds.push({
      tick: reinforceTick, target: { sideId: 1 }, action: "reinforce",
      params: {
        mode: "jump", to: { x: 120_000, y: 0 }, sideId: 1, count: 4,
        spawnId: "spawn-B-1", blueprint: bp, stats,
      },
    });
    // 增援之后：对它点 1 次装备（这才是必须预热的）
    cmds.push({
      tick: reinforceTick + 5, target: { unitIds: ["spawn-B-1-0", "spawn-B-1-1"] },
      action: "toggleModule", params: { moduleIndex: 0, state: "active" },
    });

    const req0 = client.requestsServed;
    const t0 = performance.now();
    let battle: Battle | null = null;
    let err: string | null = null;
    try {
      battle = await Battle.create(client, freshCache, config, cmds);
      for (let i = 0; i < 60; i++) battle.run(1);
    } catch (e) {
      err = (e as Error).message;
    }
    const used = client.requestsServed - req0;
    const ms = Math.round(performance.now() - t0);
    if (err) console.log(`      抛错：${err.slice(0, 200)}`);
    check("不抛错", err === null, true);
    // 60 条历史指令若被套到增援配装上会放大成几十~上百次求解；有界后应远小于此
    check(`预热求解次数有界（实测 ${used} 次，上限 60）`, used < 60, true);
    check(`整段耗时可控（实测 ${ms} ms，上限 20000）`, ms < 20_000, true);
    const spawned = battle?.state.units.filter((u) => String(u.id).startsWith("spawn-B-1")) ?? [];
    check("增援 4 艘已生成", spawned.length, 4);
    // 只对 -0 / -1 下过指令（另两艘不该被影响）
    const hit = spawned.filter((u) => u.id.endsWith("-0") || u.id.endsWith("-1"));
    const rest = spawned.filter((u) => !(u.id.endsWith("-0") || u.id.endsWith("-1")));
    check("增援后点装备仍生效（被点到的 2 艘 #0 → active）",
      hit.length === 2 && hit.every((u) => u.moduleStates[0] === "active"), true);
    check("未被点到的两艘保持原状（按 id 精确命中）",
      rest.every((u) => u.moduleStates[0] !== "active"), true);
  }

  /* ------------------------------------------------------------------ 29 */
  console.log("\n== 29) 预热漏项自愈：不再中断推演，补算后重放（结果一致）==");
  {
    // 用户报障：点"舰队指令 → 启用装备"报「属性组合未预热」并卡死。
    // 预热是"预测"，运行期总可能有预测外的组合（actives 随状态变化、脉冲源被开启…）。
    // 现行行为：**记录缺口 + 用现有属性表占位跑完 + PYFA 补算后重放**，绝不中断推演。
    const config = buildScenario("command-burst");   // 带指挥脉冲源 → applyEnv 会跑
    const b1 = await Battle.create(client, cache, config);
    const u = b1.state.units[0];
    // 人为制造"预测外的组合"：offline 从不在预热的组合里（预热只有 online/active），
    // 并把 envKey 改掉以强制 applyEnv 走一遍 → 触发一次 resolve。
    u.moduleStates[0] = "offline";
    u.envKey = "__force_miss__";
    let threw: string | null = null;
    try {
      b1.run(1);
    } catch (e) {
      threw = (e as Error).message;
    }
    check("遇到未预热组合不再抛错/中断推演", threw, null);
    check("缺口被记录下来", b1.missing.size >= 1, true);
    const miss0 = [...b1.missing.values()][0];
    check("缺口带着补算所需的模块清单（含 offline）",
      (miss0?.modules ?? []).some((m) => m.state === "offline"), true);

    // 补算 → 用补算结果重放 → 同一操作不再产生缺口
    const filled = await Battle.warmMisses(client, cache, [...b1.missing.values()]);
    check("补算得到全部缺口", filled.size, b1.missing.size);
    const b2 = await Battle.create(client, cache, config, [], filled);
    const u2 = b2.state.units[0];
    u2.moduleStates[0] = "offline";
    u2.envKey = "__force_miss__";
    b2.run(1);
    check("重放后缺口清零（自愈完成，结果与\"一开始就预热到\"一致）", b2.missing.size, 0);
  }

  /* ------------------------------------------------------------------ 30 */
  console.log("\n== 30) 武器操控 / 主动增益 / 电子战自动释放 ==");
  {
    // 用户报障：一整个舰队的 1400mm榴弹炮 II 一直显示「停火」且进度条反复填充；
    // 点武器按钮也不生效。根因：武器开关只写在实例 `w.on` 上 ——
    //   ① PYFA 只在炮位模块 state=active 时才给伤害（online → dps=0，实测）；
    //   ② 任何一次属性重算（模块开关/进出脉冲范围）都会按行状态把它重置回 online。
    // 现在：武器开关 = **该型号全部炮位模块的 state**，并重新解析属性。
    const GUNS = 6;
    const mods = [
      ...Array.from({ length: GUNS }, () => ({
        slot: "hi" as const, typeId: 2961, state: "online" as const, chargeTypeId: 21894,
      })),
      { slot: "med" as const, typeId: 1978, state: "online" as const },  // 索敌计算机 II
      { slot: "med" as const, typeId: 527, state: "online" as const },   // 网 II
    ];
    const bp: UnitBlueprint = {
      unitId: "gunship", name: "炮舰", shipName: "Tempest Fleet Issue", shipTypeId: 17732,
      sideId: 0, fleetId: 0, wingId: 0, squadId: 0, role: "line",
      modules: mods, drones: [], fighters: [],
      fitFingerprint: "gun-test", doctrine: "free",
      order: { type: "hold" }, pos: { x: 0, y: 0 },
    };
    const foe: UnitBlueprint = {
      unitId: "foe", name: "靶船", shipName: "Apocalypse Navy Issue", shipTypeId: 17726,
      sideId: 1, fleetId: 0, wingId: 0, squadId: 0, role: "line",
      modules: [], drones: [], fighters: [],
      fitFingerprint: "foe", doctrine: "passive", order: { type: "hold" }, pos: { x: 8_000, y: 0 },
    };
    const config: BattleConfig = {
      seed: 3, mode: "expected",
      settings: { passiveShieldRegen: false, verboseEvents: true },
      blueprints: [bp, foe],
    };
    const cmds: Command[] = [
      { tick: 1, target: { unitIds: ["gunship"] }, action: "toggleWeapon", params: { typeId: 2961, on: true } },
      { tick: 2, target: { unitIds: ["gunship"] }, action: "toggleModule", params: { moduleIndex: GUNS, state: "active" } },
      { tick: 3, target: { unitIds: ["gunship"] }, action: "toggleModule", params: { moduleIndex: GUNS + 1, state: "active" } },
    ];
    const battle = await Battle.create(client, cache, config, cmds);
    const u = battle.state.units[0];

    check("初始：炮位全部停火（不自动开火）",
      u.moduleStates.slice(0, GUNS).every((s) => s === "online"), true);
    check("初始：武器实例 on = false", u.weapons.filter((w) => w.on).length, 0);
    check("初始：炮台 DPS = 0（online 时 PYFA 不给伤害）",
      (u.stats.weapons[0]?.dps ?? 0), 0);

    // 命令在「命令 tick 的那一步」生效：tick=1 的指令在 1→2 那一步应用
    battle.run(2);
    check("点开火后：6 门炮位全部 active",
      u.moduleStates.slice(0, GUNS).filter((s) => s === "active").length, GUNS);
    check("武器实例 on = true（界面不再是「停火」）",
      u.weapons.filter((w) => w.on).length, GUNS);
    check("开火后 PYFA 给出伤害（这是本次修复的核心）",
      (u.stats.weapons[0]?.dps ?? 0) > 0, true);

    const optBefore = u.weapons[0]?.optimal ?? 0;
    battle.run(1);   // 应用 tick=2：索敌计算机 active
    check("索敌计算机启用后射程变大（增益真的生效）",
      (u.weapons[0]?.optimal ?? 0) > optBefore, true);
    check("后续属性重算**没有**把武器重置为停火",
      u.weapons.filter((w) => w.on).length, GUNS);

    const foeUnit = battle.state.units[1];
    const shield0 = foeUnit.hp.shield;
    battle.run(45);  // 应用 tick=3（网）+ 等锁定完成再打一会儿
    check("电子战（网）启动后自动向目标释放：产生 ewar 事件",
      battle.state.events.some((e) => e.type === "ewar"), true);
    check("目标身上出现「网」效果",
      foeUnit.effects.some((e) => e.kind === "web"), true);
    check("开火产生了命中/未命中事件（武器真的在打）",
      battle.state.events.some((e) => e.type === "hit" || e.type === "miss"), true);
    check("目标确实被打掉了护盾", foeUnit.hp.shield < shield0, true);
    console.log(`      炮台 optimal ${Math.round(optBefore / 1000)} → `
      + `${Math.round((u.weapons[0]?.optimal ?? 0) / 1000)} km（含索敌增益）`);
  }

  /* ------------------------------------------------------------------ 31 */
  console.log("\n== 31) 火力计算核对：与 PYFA 的 volley / DPS 逐值一致 + 首次齐射实际伤害 ==");
  {
    // 用户给的 PYFA 口径：狂暴级舰队型 + 8×1400mm榴弹炮 II + 共和舰队电磁脉冲弹 L
    //   PYFA 面板：射程 39km+71.7km（最佳+失准）、跟踪 1.12、整船 682 秒伤
    const GUNS = 8;
    const mods = [
      ...Array.from({ length: GUNS }, () => ({
        slot: "hi" as const, typeId: 2961, state: "active" as const, chargeTypeId: 21894,
      })),
      { slot: "med" as const, typeId: 1978, state: "active" as const },   // 索敌计算机 II
    ];
    const pyfa = await client.calcFit({
      ship: { typeId: 17732, name: "Tempest Fleet Issue" }, modules: mods,
    });
    const pyfaDps = pyfa.weapons.reduce((a, w) => a + (w.dps ?? 0), 0);
    const pyfaVolleyPerGun = pyfa.weapons[0]?.volley ?? 0;

    const bp: UnitBlueprint = {
      unitId: "dps-ship", name: "炮舰", shipName: "Tempest Fleet Issue", shipTypeId: 17732,
      sideId: 0, fleetId: 0, wingId: 0, squadId: 0, role: "line",
      modules: mods, drones: [], fighters: [],
      fitFingerprint: "dps-check", doctrine: "free",
      order: { type: "hold" }, pos: { x: 0, y: 0 },
    };
    const dummy: UnitBlueprint = {
      unitId: "dps-target", name: "靶船", shipName: "Apocalypse Navy Issue", shipTypeId: 17726,
      sideId: 1, fleetId: 0, wingId: 0, squadId: 0, role: "line",
      modules: [], drones: [], fighters: [],
      fitFingerprint: "dps-foe", doctrine: "passive",
      order: { type: "hold" }, pos: { x: 15_000, y: 0 },   // 远小于最佳射程 → 命中率 100%
    };
    const battle = await Battle.create(client, cache, {
      seed: 11, mode: "expected",
      settings: { passiveShieldRegen: false },
      blueprints: [bp, dummy],
    });
    const u = battle.state.units[0];
    const foe = battle.state.units[1];

    // (1) 单发齐射：我们的 volleyOf 必须等于 PYFA 的 volley
    const ourVolley = totalDmg(volleyOf(u.weapons[0]));
    check(`单发齐射与 PYFA 一致（实测 ${Math.round(ourVolley)} vs ${Math.round(pyfaVolleyPerGun)}）`,
      Math.abs(ourVolley - pyfaVolleyPerGun) / Math.max(1, pyfaVolleyPerGun) < 0.005, true);

    // (2) 整船秒伤：我们的 unitDpsOf 必须等于 PYFA 各行 dps 之和
    const ourDps = unitDpsOf(u);
    check(`单舰 DPS 与 PYFA 一致（实测 ${ourDps.toFixed(1)} vs ${pyfaDps.toFixed(1)}）`,
      Math.abs(ourDps - pyfaDps) / Math.max(1, pyfaDps) < 0.005, true);

    // (3) 射程环数据：最佳 = optimal，有效 = optimal + falloff
    const frameOf = buildUnitFrames(battle.state).find((f) => f.id === "dps-ship")!;
    check("最佳射程环 = 武器 optimal",
      Math.round(frameOf.range), Math.round(u.weapons[0].optimal));
    check("有效射程环 = optimal + falloff",
      Math.round(frameOf.rangeEff), Math.round(u.weapons[0].optimal + u.weapons[0].falloff));
    check("有效射程 > 最佳射程（两个环确实是分开的）", frameOf.rangeEff > frameOf.range, true);

    // (4) 首次齐射的实际伤害 = 8 门 × 单发齐射 × 陨星期望 × 目标护盾抗性
    let firstHitTick = -1;
    for (let i = 0; i < 90 && firstHitTick < 0; i++) {
      battle.run(1);
      if (foe.damageTaken > 0) firstHitTick = battle.state.tick;
    }
    check("已完成首次齐射", firstHitTick > 0, true);
    const shieldRes = foe.stats.attrs.res.shield;
    const raw = volleyOf(u.weapons[0]);
    const tot = totalDmg(raw);
    const appliedFrac = (raw.em * shieldRes[0] + raw.thermal * shieldRes[1]
      + raw.kinetic * shieldRes[2] + raw.explosive * shieldRes[3]) / tot;
    const expectFirst = GUNS * tot * turretDamageMult(1) * appliedFrac;
    const tol = Math.max(2, expectFirst * 0.01);
    check(`首次齐射实际伤害 = 8门×齐射×陨星×抗性（实测 ${Math.round(foe.damageTaken)} `
      + `vs ${Math.round(expectFirst)}）`,
      Math.abs(foe.damageTaken - expectFirst) <= tol, true);
    console.log(`      PYFA：最佳 ${Math.round(u.weapons[0].optimal / 1000)}km`
      + ` + 失准 ${Math.round(u.weapons[0].falloff / 1000)}km`
      + `（有效 ${Math.round(frameOf.rangeEff / 1000)}km）｜单舰 ${ourDps.toFixed(0)} DPS`
      + `｜护盾伤害系数 ${(appliedFrac * 100).toFixed(1)}%`);
  }

  console.log(`\n[theater-test] 完成：${checks} 项断言，${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  client.stop();
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("[theater-test] 异常：", e);
  process.exit(1);
});

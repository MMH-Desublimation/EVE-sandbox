/**
 * 阶段 2 验收测试（交接文档 §10.3 的 6 条通过标准）。
 *
 *   npm run engine-test
 *
 * 1. 确定性：同 fit + 同种子 + 同命令 → 逐 tick 状态完全一致
 * 2. 重放一致：重放后击毁记录、单位数量、血量全部一致
 * 3. 几何解析解：单挑靶船的击杀时间可（独立）手算验证
 * 4. 传电不变量：传电链电量不被抽干
 * 5. 战术敏感性：只改一条指令，结果有明显、可解释的差异
 * 6. 性能：数百单位 × 数百 tick 的耗时
 */
import { StatOracleClient, defaultOracleOptions } from "../src/stats/oracle/client.ts";
import { AttrCache } from "../src/stats/cache.ts";
import { makeUnitId } from "../src/core/deterministic.ts";
import { Battle } from "../src/core/battle.ts";
import type { Command } from "../src/core/commands.ts";
import type { UnitBlueprint } from "../src/core/state.ts";
import { ehp } from "../src/core/combat.ts";
import type { ModuleSpec } from "../src/shared/protocol.ts";

const APOC = 17726;      // Apocalypse Navy Issue
const MEGA_BEAM = 3049;  // Mega Beam Laser II
const STANDARD_L = 258;  // Standard L
const HEAT_SINK = 2364;  // Heat Sink II

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
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}: ${s(actual)}${ok ? "" : `  (期望 ${s(expected)}${tol ? ` ±${tol}` : ""})`}`);
}

function s(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  return String(v);
}

function bp(
  sideId: 0 | 1, fleetId: number, squadId: number, index: number,
  shipTypeId: number, shipName: string, modules: ModuleSpec[],
  opts: Partial<UnitBlueprint> = {},
): UnitBlueprint {
  return {
    unitId: makeUnitId(sideId, fleetId, 0, squadId, index),
    name: `${shipName}#${index + 1}`,
    shipName,
    shipTypeId,
    sideId,
    fleetId,
    wingId: 0,
    squadId,
    role: "line",
    modules,
    drones: [],
    fighters: [],
    fitFingerprint: `f${shipTypeId}-${modules.length}`,
    pos: { x: 0, y: 0 },
    ...opts,
  };
}

function laserFit(): ModuleSpec[] {
  const mods: ModuleSpec[] = [];
  for (let i = 0; i < 8; i++) mods.push({ slot: "hi", typeId: MEGA_BEAM, state: "active", chargeTypeId: STANDARD_L });
  for (let i = 0; i < 2; i++) mods.push({ slot: "lo", typeId: HEAT_SINK, state: "active" });
  return mods;
}

/** 状态指纹：只取与确定性相关的字段。 */
function fingerprint(b: Battle): string {
  const st = b.state;
  return JSON.stringify({
    tick: st.tick,
    finished: st.finished,
    winner: st.winnerSideId,
    units: st.units.map((u) => ({
      id: u.id, alive: u.alive, evac: u.evacuated,
      hp: [r2(u.hp.shield), r2(u.hp.armor), r2(u.hp.hull)],
      cap: r2(u.cap),
      pos: [r2(u.pos.x), r2(u.pos.y)],
      vel: [r2(u.vel.x), r2(u.vel.y)],
      locked: u.locked,
      dealt: r2(u.damageDealt),
    })),
    kills: st.kills.map((k) => `${k.tick}:${k.unitId}`),
  });
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const opts = defaultOracleOptions();
  const client = new StatOracleClient({ onLog: process.env.DEBUG === "1" ? (l) => console.error("  " + l) : undefined });
  const t0 = performance.now();
  const version = await client.start();
  console.log(`[engine-test] StatOracle 就绪 ${Math.round(performance.now() - t0)} ms (PYFA ${version})\n`);
  const cache = new AttrCache();

  const baseConfig = {
    seed: 12345,
    mode: "expected" as const,
    settings: { passiveShieldRegen: false },
  };

  /* ---------------- 3. 几何解析解（先跑，便于定位其它问题） ---------------- */
  console.log("== 3) 几何解析解：单挑靶船 ==");
  {
    const attacker = bp(0, 0, 0, 0, APOC, "Apocalypse Navy Issue",
      [{ slot: "hi", typeId: MEGA_BEAM, state: "active", chargeTypeId: STANDARD_L }],
      { pos: { x: 0, y: 0 }, order: { type: "hold" } });
    const target = bp(1, 0, 0, 0, APOC, "Apocalypse Navy Issue", [],
      { pos: { x: 0, y: 0 }, order: { type: "hold" } });

    const battle = await Battle.create(client, cache, {
      ...baseConfig,
      settings: { passiveShieldRegen: false, verboseEvents: true },
      blueprints: [attacker, target],
    });
    const a = battle.state.units[0];
    const t = battle.state.units[1];

    const rofMs = a.weapons[0].rofMs;
    const period = Math.ceil(rofMs / 1000);
    const volley = a.weapons[0].dmgTypes.em * a.weapons[0].damageMultiplier +
      a.weapons[0].dmgTypes.thermal * a.weapons[0].damageMultiplier;

    // 锁定时间（独立公式，秒）：40000 / (扫描分辨率 × asinh(信号))
    // 引擎在第 n 个 tick 累加 (n+1)*1000 ms 的锁定进度，故首发 tick = ceil(lockSec) - 1
    const lockSec = 40000 / (a.stats.attrs.scan.resolution * Math.asinh(t.stats.attrs.nav.signatureRadius));
    const firstShot = Math.ceil(lockSec) - 1;

    console.log(`  锁定时间 ${lockSec.toFixed(2)} s → 预期首发 tick ${firstShot}；射速 ${rofMs} ms → 每 ${period} tick 一轮`);
    console.log(`  单门齐射 ${volley.toFixed(3)}；目标 HP ${t.maxHp.shield}/${t.maxHp.armor}/${t.maxHp.hull}`);

    // 独立手算：逐层扣血（只用纯算术，不复用引擎 combat.ts）
    const res = t.stats.attrs.res;
    const emV = a.weapons[0].dmgTypes.em * a.weapons[0].damageMultiplier;
    const thV = a.weapons[0].dmgTypes.thermal * a.weapons[0].damageMultiplier;
    const mult = 1.01505; // turretDamageMult(1.0)：0.99*((0.01+1)/2+0.49) + 0.01*3
    // 逐发推进；**每发内部再逐层下渗**（与引擎 applyDamageToUnit 同语义，但只用纯算术）
    const lhp = [t.maxHp.shield, t.maxHp.armor, t.maxHp.hull];
    const lres: Array<readonly number[]> = [res.shield, res.armor, res.hull];
    let layer = 0;
    let shots = 0;
    while (layer < 3 && shots < 100000) {
      shots++;
      let remEm = emV * mult;
      let remTh = thV * mult;
      while (layer < 3) {
        const lr = lres[layer];
        const loss = remEm * lr[0] + remTh * lr[1];
        if (loss <= lhp[layer]) {
          lhp[layer] -= loss;
          break;
        }
        const absorbed = lhp[layer] / loss;
        lhp[layer] = 0;
        remEm *= 1 - absorbed;
        remTh *= 1 - absorbed;
        layer++;
      }
    }
    const expectedKillTick = firstShot + (shots - 1) * period;
    console.log(`  独立手算：需 ${shots} 次齐射 → 预期击杀 tick = ${expectedKillTick}`);

    battle.runToEnd(5000);
    const killed = battle.state.kills;
    const fires = battle.state.events.filter((e) => e.type === "fire").map((e) => e.tick);
    console.log(`  实际开火 ${fires.length} 次：首发 tick ${fires[0]}，末发 tick ${fires[fires.length - 1]}`
      + `（与手算齐射数之差 ${fires.length - shots}）`);
    check("靶船被击毁", killed.length, 1);
    check("首发 tick（对照独立锁定公式）", fires[0], firstShot, 0);
    if (killed.length > 0) {
      check("击杀 tick（= 首发 + (齐射数-1)×周期）",
        killed[0].tick, fires[0] + (fires.length - 1) * period, 0);
      check("引擎齐射数（对照独立手算）", fires.length, shots, 0);
      check("击杀 tick（对照独立手算）", killed[0].tick, expectedKillTick, 1);
      check("击杀方为蓝方", killed[0].sideId, 1);
    }
    const totalHp = t.maxHp.shield + t.maxHp.armor + t.maxHp.hull;
    check("靶船累计承受伤害 ≈ 三层 HP 之和", a.damageDealt, totalHp, 1);
    check("靶船 EHP > 三层 HP 之和（抗性生效）", ehp(t) > totalHp, true);
  }

  /* ---------------- 1. 确定性 ---------------- */
  console.log("\n== 1) 确定性：同输入逐 tick 完全一致 ==");
  {
    const blueprints = [
      bp(0, 0, 0, 0, APOC, "Apocalypse Navy Issue", laserFit(), { pos: { x: -20000, y: 0 } }),
      bp(1, 0, 0, 0, APOC, "Apocalypse Navy Issue", laserFit(), { pos: { x: 20000, y: 0 } }),
    ];
    const commands: Command[] = [
      { tick: 0, target: { sideId: 0 }, action: "setDoctrine", params: { doctrine: "focus" } },
      { tick: 0, target: { sideId: 1 }, action: "setDoctrine", params: { doctrine: "focus" } },
    ];
    const b1 = await Battle.create(client, cache, { ...baseConfig, mode: "stochastic", blueprints }, commands);
    const b2 = await Battle.create(client, cache, { ...baseConfig, mode: "stochastic", blueprints }, commands);
    b1.run(300);
    b2.run(300);
    check("两次运行状态指纹一致", fingerprint(b1) === fingerprint(b2), true);
    check("确实发生了交战（有伤害）", b1.state.units[0].damageDealt > 0, true);
  }

  /* ---------------- 2. 重放一致 ---------------- */
  console.log("\n== 2) 重放一致：从 t=0 重放结果完全相同 ==");
  {
    const blueprints = [
      bp(0, 0, 0, 0, APOC, "Apocalypse Navy Issue", laserFit(), { pos: { x: -30000, y: 0 } }),
      bp(0, 0, 0, 1, APOC, "Apocalypse Navy Issue", laserFit(), { pos: { x: -34000, y: 0 } }),
      bp(1, 0, 0, 0, APOC, "Apocalypse Navy Issue", laserFit(), { pos: { x: 30000, y: 0 } }),
      bp(1, 0, 0, 1, APOC, "Apocalypse Navy Issue", laserFit(), { pos: { x: 34000, y: 0 } }),
    ];
    const commands: Command[] = [
      { tick: 0, target: { sideId: 0 }, action: "setDoctrine", params: { doctrine: "focus" } },
      { tick: 0, target: { sideId: 1 }, action: "setDoctrine", params: { doctrine: "focus" } },
      { tick: 120, target: { sideId: 1 }, action: "setOrder", params: { type: "orbit", range: 30000 } },
    ];
    const first = await Battle.create(client, cache, { ...baseConfig, blueprints }, commands);
    first.run(400);
    const snapAfter = fingerprint(first);

    const replay = await Battle.create(client, cache, { ...baseConfig, blueprints }, commands);
    replay.run(400);
    check("重放后状态指纹一致", fingerprint(replay) === snapAfter, true);
    check("重放后单位数量一致", replay.state.units.length, first.state.units.length);
    check("重放后击毁记录一致", replay.state.kills.length, first.state.kills.length);
  }

  /* ---------------- 5. 战术敏感性 ---------------- */
  console.log("\n== 5) 战术敏感性：只改一条指令，结果应明显不同 ==");
  {
    const makeBps = () => [
      bp(0, 0, 0, 0, APOC, "Apocalypse Navy Issue", laserFit(), { pos: { x: -30000, y: 0 } }),
      bp(1, 0, 0, 0, APOC, "Apocalypse Navy Issue", laserFit(), { pos: { x: 30000, y: 0 } }),
    ];
    // A：双方都"停止机动"（火力继续）
    const cmdsA: Command[] = [
      { tick: 0, target: { sideId: 0 }, action: "stop", params: {} },
      { tick: 0, target: { sideId: 1 }, action: "stop", params: {} },
    ];
    // B：红方撤离（起跳）
    const cmdsB: Command[] = [
      { tick: 0, target: { sideId: 0 }, action: "stop", params: {} },
      { tick: 0, target: { sideId: 1 }, action: "warpOut", params: {} },
    ];

    const bA = await Battle.create(client, cache, { ...baseConfig, blueprints: makeBps() }, cmdsA);
    bA.run(600);
    const bB = await Battle.create(client, cache, { ...baseConfig, blueprints: makeBps() }, cmdsB);
    bB.run(600);

    const dealtA = bA.state.units[0].damageDealt;
    const dealtB = bB.state.units[0].damageDealt;
    console.log(`  A(互射) 蓝方伤害 ${dealtA.toFixed(0)}；B(红方撤离) 蓝方伤害 ${dealtB.toFixed(0)}`);
    check("两份结果的伤害明显不同", Math.abs(dealtA - dealtB) > dealtA * 0.5, true);
    check("A 场景红方未撤离", bA.state.units[1].evacuated, false);
    check("B 场景红方已撤离", bB.state.units[1].evacuated, true);
    check("B 场景红方伤害显著更低", dealtB < dealtA, true);
  }

  /* ---------------- 4. 传电不变量 ---------------- */
  console.log("\n== 4) 传电不变量：电容始终在 [0, capMax] 内，且传电不抽干来源 ==");
  {
    const transmitters = await client.resolveNames([
      "Large Remote Capacitor Transmitter II",
      "Medium Remote Capacitor Transmitter II",
      "Small Remote Capacitor Transmitter II",
      "Remote Capacitor Transmitter II",
    ]);
    const found = Object.entries(transmitters.resolved)[0];
    if (!found) {
      console.log("  [SKIP] 未找到远程电容传输装置，跳过传电用例（记入遗留）");
    } else {
      const [name, info] = found;
      console.log(`  使用传电模块：${name} (typeId=${info.typeId})`);
      const logiMods: ModuleSpec[] = [{ slot: "med", typeId: info.typeId, state: "active" }];
      const blueprints = [
        bp(0, 0, 0, 0, APOC, "Apocalypse Navy Issue", logiMods, { pos: { x: -5000, y: 0 }, role: "logi" }),
        bp(0, 0, 0, 1, APOC, "Apocalypse Navy Issue", laserFit(), { pos: { x: 0, y: 0 } }),
        bp(1, 0, 0, 0, APOC, "Apocalypse Navy Issue", laserFit(), { pos: { x: 5000, y: 0 } }),
      ];
      const cmds: Command[] = [
        { tick: 0, target: { sideId: 0 }, action: "setDoctrine", params: { doctrine: "focus" } },
        { tick: 0, target: { sideId: 1 }, action: "setDoctrine", params: { doctrine: "focus" } },
      ];
      const battle = await Battle.create(client, cache, { ...baseConfig, blueprints }, cmds);
      // 制造电容缺口：把受电方电量压到 5%，否则"电容稳定"的舰船不会产生传电需求
      const ally = battle.state.units[1];
      ally.cap = ally.capMax * 0.05;
      const allyStartRatio = ally.cap / ally.capMax;

      let minRatio = 1;
      let maxAllyRatio = allyStartRatio;
      let maxViolation = 0;
      for (let i = 0; i < 400; i++) {
        battle.run(1);
        for (const u of battle.state.units) {
          if (!u.alive) continue;
          minRatio = Math.min(minRatio, u.cap / u.capMax);
          if (u.cap < -1e-6) maxViolation = Math.max(maxViolation, -u.cap);
          if (u.cap > u.capMax + 1e-6) maxViolation = Math.max(maxViolation, u.cap - u.capMax);
        }
        maxAllyRatio = Math.max(maxAllyRatio, battle.state.units[1].cap / battle.state.units[1].capMax);
      }
      const logi = battle.state.units[0];
      console.log(`  受电方电量峰值比例 ${(maxAllyRatio * 100).toFixed(1)}%（起点 ${(allyStartRatio * 100).toFixed(1)}%）；`
        + `后勤舰电量 ${(logi.cap / logi.capMax * 100).toFixed(1)}%；越界量 ${maxViolation.toExponential(2)}`);
      check("电容从未越界（[0, capMax]）", maxViolation < 1e-3, true);
      check("传电来源未被抽干（> 5%）", logi.cap / logi.capMax > 0.05, true);
      check("确实发生了传电（有 capTransfer 记录）",
        battle.state.events.some((e) => e.type === "capTransfer"), true);
      check("受电方电量被补充（峰值 > 起点）", maxAllyRatio > allyStartRatio + 0.05, true);
    }
  }

  /* ---------------- 6. 性能 ---------------- */
  console.log("\n== 6) 性能：规模与耗时 ==");
  {
    for (const n of [20, 100, 200]) {
      const blueprints: UnitBlueprint[] = [];
      for (let i = 0; i < n; i++) {
        const side = (i % 2) as 0 | 1;
        blueprints.push(bp(side, 0, 0, i, APOC, "Apocalypse Navy Issue", laserFit(), {
          pos: { x: side === 0 ? -40000 : 40000, y: (i - n / 2) * 3000 },
        }));
      }
      const cmds: Command[] = [
        { tick: 0, target: { sideId: 0 }, action: "setDoctrine", params: { doctrine: "focus" } },
        { tick: 0, target: { sideId: 1 }, action: "setDoctrine", params: { doctrine: "focus" } },
      ];
      const tBuild = performance.now();
      const battle = await Battle.create(client, cache, { ...baseConfig, blueprints }, cmds);
      const buildMs = performance.now() - tBuild;
      const tRun = performance.now();
      battle.run(600);
      const runMs = performance.now() - tRun;
      const totalUnits = battle.state.units.length;
      console.log(`  ${totalUnits} 单位 × 600 tick：建场 ${buildMs.toFixed(0)} ms，推演 ${runMs.toFixed(0)} ms `
        + `(${((600 / runMs) * 1000).toFixed(0)} tick/s)，击毁 ${battle.state.kills.length}`);
      check(`${totalUnits} 单位 600 tick 推演 < 20 s`, runMs < 20000, true);
    }
  }

  await client.stop();
  console.log(`\n[engine-test] 完成：${checks} 项断言，${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[engine-test] 异常:", err);
  process.exit(2);
});

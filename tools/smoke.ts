/**
 * 阶段 1 冒烟测试：StatOracle 客户端 + 属性缓存。
 *
 * 运行： npm run smoke     （或 node --experimental-strip-types tools/smoke.ts）
 *
 * 断言依据 docs/第4章-PYFA集成协议-冻结稿.md §4.3 冒烟测试表。
 */
import { StatOracleClient, defaultOracleOptions } from "../src/stats/oracle/client.ts";
import { AttrCache, makeAttrKey } from "../src/stats/cache.ts";
import type { FitStats } from "../src/shared/contract.ts";
import type { ModuleSpec } from "../src/shared/protocol.ts";

const op = defaultOracleOptions();
const verbose = process.env.DEBUG === "1";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown, tol = 0): void {
  let ok: boolean;
  if (typeof actual === "number" && typeof expected === "number") {
    ok = Math.abs(actual - expected) <= tol;
  } else {
    ok = actual === expected;
  }
  if (!ok) failures++;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${label}: ${String(actual)}${ok ? "" : `  (期望 ${String(expected)}${tol ? ` ±${tol}` : ""})`}`);
}

function totalDps(stats: FitStats): number {
  return stats.weapons.reduce((sum, w) => sum + (w.dps ?? 0), 0);
}

function laserFit(): ModuleSpec[] {
  const lasers: ModuleSpec[] = [];
  for (let i = 0; i < 8; i++) {
    lasers.push({ slot: "hi", typeId: 3049, state: "active", chargeTypeId: 258 });
  }
  for (let i = 0; i < 2; i++) {
    lasers.push({ slot: "lo", typeId: 2364, state: "active" });
  }
  return lasers;
}

async function main(): Promise<void> {
  console.log("[smoke] 启动 StatOracle ...");
  console.log(`[smoke] python=${op.python}`);
  console.log(`[smoke] pyfaDir=${op.pyfaDir}`);
  console.log(`[smoke] workDir=${op.workDir}`);

  const client = new StatOracleClient({ onLog: verbose ? (l) => console.error("  " + l) : undefined });
  const t0 = performance.now();
  const version = await client.start();
  console.log(`[smoke] 就绪 ${Math.round(performance.now() - t0)} ms, PYFA ${version}\n`);

  const cache = new AttrCache();

  console.log("== S0 版本 ==");
  check("pyfaVersion 形如 vX.Y.Z", /^v\d+\.\d+\.\d+$/.test(version), true);

  console.log("\n== S3 Raven 基础属性 ==");
  const raven = await client.calcFit({ ship: { name: "Raven" } });
  check("shieldCapacity", raven.attrs.hp.shield, 9625, 1);
  check("armorHP", raven.attrs.hp.armor, 7975, 1);
  check("hull", raven.attrs.hp.hull, 8800, 1);

  console.log("\n== S1/S2 灾难级海军型基准（8×Mega Beam Laser II + Standard L + 2×Heat Sink II）==");
  const apocModules = laserFit();
  const apoc = await client.calcFit({ ship: { typeId: 17726 }, modules: apocModules });
  check("shieldCapacity", apoc.attrs.hp.shield, 11000, 1);
  check("armorHP", apoc.attrs.hp.armor, 14437.5, 1);
  check("hull", apoc.attrs.hp.hull, 13750, 1);
  check("武器行数", apoc.weapons.length, 1);
  check("武器门数", apoc.weapons[0]?.count, 8);
  check("单门齐射", apoc.weapons[0]?.volley ?? 0, 299.4627, 0.01);
  check("8 门总 DPS（文档基准 454.6）", totalDps(apoc), 454.6, 0.5);
  check("rof", apoc.weapons[0]?.rof ?? 0, 5270.34, 0.1);
  check("damageMultiplier", apoc.weapons[0]?.damageMultiplier ?? 0, 9.3582, 0.001);
  check("被动件数（2×散热槽）", apoc.passives.length, 2);
  check("unhandled 为空", apoc.unhandled.length, 0);
  check("传感器强度 RADAR", apoc.attrs.scan.sensor[3], 30, 0.01);
  check("warpSpeedMultiplier", apoc.attrs.nav.warpSpeedMultiplier ?? 0, 3, 0.01);

  console.log("\n== S4 会战装备（siege）开关 ==");
  const siegeOnline = await client.calcFit({
    ship: { name: "Phoenix" },
    modules: [{ slot: "hi", name: "Siege Module II", state: "online" }],
  });
  const siegeActive = await client.calcFit({
    ship: { name: "Phoenix" },
    modules: [{ slot: "hi", name: "Siege Module II", state: "active" }],
  });
  check("siege 在线时 maxVelocity > 0", (siegeOnline.attrs.nav.maxVelocity ?? 0) > 0, true);
  check("siege 开启时 maxVelocity = 0", siegeActive.attrs.nav.maxVelocity, 0, 0.0001);
  check("siege 开启时质量 ×10",
    siegeActive.attrs.nav.mass / siegeOnline.attrs.nav.mass, 10, 0.01);
  check("siege kind", siegeActive.actives[0]?.kind ?? "", "siege");

  console.log("\n== 属性缓存：同一 (配装, 状态) 只算一次 ==");
  const before = client.requestsServed;
  const key = makeAttrKey(17726, apocModules);
  const first = await cache.getOrCompute(key, () => client.calcFit({ ship: { typeId: 17726 }, modules: apocModules }));
  const second = await cache.getOrCompute(key, () => client.calcFit({ ship: { typeId: 17726 }, modules: apocModules }));
  check("第二次命中缓存（未新增请求）", client.requestsServed, before + 1);
  check("两次结果 DPS 一致", totalDps(second), totalDps(first), 0.0001);
  check("缓存命中率", cache.stats().hitRate, 0.5, 0.0001);

  console.log("\n== 状态位图区分（state 变化 → 不同缓存键）==");
  const keyOn = makeAttrKey(17726, apocModules);
  const offModules = apocModules.map((m) => ({ ...m, state: "online" as const }));
  const keyOff = makeAttrKey(17726, offModules);
  check("stateBitmap 不同", keyOn.stateBitmap !== keyOff.stateBitmap, true);

  await client.stop();

  console.log(`\n[smoke] 完成：${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] 异常:", err);
  process.exit(2);
});

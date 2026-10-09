/**
 * 性能实测：属性解析（PYFA 查询）／引擎推进／UI 投影。
 *
 * 用法：node tools/perf-test.ts [每方单位数，默认 100]
 *
 * 判据：
 *   · 引擎 `ms/tick` 必须远小于 1000ms（时间模型是 1 tick = 1 秒，但一次推进要能跑多个 tick）
 *   · UI 投影必须远小于 16.7ms（60fps 的每帧预算）
 */
import { StatOracleClient } from "../src/stats/oracle/client.ts";
import { AttrCache } from "../src/stats/cache.ts";
import { Battle } from "../src/core/battle.ts";
import { buildScenario } from "../src/core/scenario.ts";
import { buildSquads, buildUnitFrames } from "../src/ui/viewModel.ts";

const perSide = Number(process.argv[2] ?? 100);
const client = new StatOracleClient({});
await client.start();
const cache = new AttrCache();

let t0 = performance.now();
const battle = await Battle.create(
  client, cache, buildScenario("stress", { unitsPerSide: perSide }),
);
const tCreate = performance.now() - t0;
const units = battle.state.units.length;

// 先跑一小段让 JIT 热身（不计入）
battle.run(20);

t0 = performance.now();
battle.run(600);
const tStep = performance.now() - t0;

// UI 每帧要做的事：单位投影 + 小队聚合
t0 = performance.now();
let checksum = 0;
const FRAMES = 200;
for (let i = 0; i < FRAMES; i++) {
  checksum += buildUnitFrames(battle.state).length + buildSquads(battle.state).length;
}
const tProj = performance.now() - t0;

const msPerTick = tStep / 600;
const projMs = tProj / FRAMES;
const tick = battle.state.tick;
const alive = battle.state.units.filter((u) => u.alive).length;

console.log("=== 性能实测 ===");
console.log(`规模：${units} 单位（每方 ${perSide}）`);
console.log(`属性解析（PYFA 查询 + 预热）：${tCreate.toFixed(0)} ms`);
console.log(`引擎推进：600 tick 用 ${tStep.toFixed(0)} ms → ${msPerTick.toFixed(2)} ms/tick`);
console.log(`  折算：单核每秒可推进 ${Math.round(1000 / msPerTick)} tick`
  + `（UI 以 15× 加速 = 每秒 15 tick 播放时占用 `
  + `${(msPerTick * 15).toFixed(1)} ms/s）`);
console.log(`UI 投影：${FRAMES} 帧用 ${tProj.toFixed(0)} ms → ${projMs.toFixed(2)} ms/帧`
  + `（60fps 预算 16.7 ms，占用 ${((projMs / 16.7) * 100).toFixed(1)}%）`);
console.log(`推演状态：tick=${tick}，存活 ${alive}/${units}（校验和 ${checksum}）`);

const budgetOk = projMs < 16.7 * 0.5;
const stepOk = msPerTick * 15 < 100;
console.log("");
console.log(`[${budgetOk ? "PASS" : "FAIL"}] UI 帧预算：投影占用 < 50% 的 60fps 预算`);
console.log(`[${stepOk ? "PASS" : "FAIL"}] 播放预算：15× 加速播放时引擎占用 < 10% 单核`);

client.stop();
process.exit(budgetOk && stepOk ? 0 : 1);

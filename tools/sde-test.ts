/**
 * 数据层 + 中文简写 自检（阶段：静态数据访问层 / abbr 改造）。
 *
 *   node tools/sde-test.ts
 *
 * 断言：
 *  1. hydrateFrom 注入后 isLoaded() 为真，ship(582) 非空且 zhName(582) 是中文；
 *  2. findByName 中英文解析到同一 typeId（另见下方 NOTE：任务书给的“秃鹰级”样例在本数据集中不成立）；
 *  3. chargesFor(模块) 返回非空，且每个弹药的 group 都在该模块 cg 里；
 *  4. moduleAbbr / weaponAbbr 的关键样例；
 *  5. 遍历全部 modules：moduleAbbr 不抛异常、不返回空串，并统计“退化到通用规则”的比例。
 *
 * 退出码：全部通过 0，有失败 1，异常 2（与 tools/engine-test.ts 一致）。
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  hydrateFrom,
  isLoaded,
  ship,
  zhName,
  enName,
  get,
  findByName,
  searchName,
  chargesFor,
  chargesForModule,
  module_,
  meta,
} from "../src/ui/sde.ts";
import type { SdeRaw, ModuleData, ChargeData } from "../src/ui/sde.ts";
import { moduleAbbr, moduleAbbrDetailed, weaponAbbr, stripTech } from "../src/ui/util/abbr.ts";

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  checks++;
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}: ${String(actual)}${ok ? "" : `  (期望 ${String(expected)})`}`);
}

function info(label: string, value: unknown): void {
  console.log(`  [INFO] ${label}: ${String(value)}`);
}

const CJK_RE = /[\u3400-\u9fff]/;

/** 读一个 JSON 文件（相对本脚本），返回 unknown 供收窄。 */
async function readJson(rel: string): Promise<unknown> {
  const url = new URL(rel, import.meta.url);
  const txt = await readFile(fileURLToPath(url), "utf8");
  return JSON.parse(txt) as unknown;
}

async function main(): Promise<void> {
  console.log("=== 数据层 / 中文简写 自检 ===");

  /* ---------------------------------------------------------------- 加载数据 */
  const raw: SdeRaw = {
    meta: (await readJson("../src/ui/data/meta.json")) as SdeRaw["meta"],
    groups: (await readJson("../src/ui/data/groups.json")) as SdeRaw["groups"],
    ships: (await readJson("../src/ui/data/ships.json")) as SdeRaw["ships"],
    structShips: (await readJson("../src/ui/data/structShips.json")) as SdeRaw["structShips"],
    modules: (await readJson("../src/ui/data/modules.json")) as SdeRaw["modules"],
    structModules: (await readJson("../src/ui/data/structModules.json")) as SdeRaw["structModules"],
    charges: (await readJson("../src/ui/data/charges.json")) as SdeRaw["charges"],
    drones: (await readJson("../src/ui/data/drones.json")) as SdeRaw["drones"],
    structures: (await readJson("../src/ui/data/structures.json")) as SdeRaw["structures"],
    deployables: (await readJson("../src/ui/data/deployables.json")) as SdeRaw["deployables"],
    index: (await readJson("../src/ui/data/index.json")) as SdeRaw["index"],
  };
  hydrateFrom(raw);

  /* ---------------------------------------------------------------- 1. 舰船名 */
  console.log("\n[1] 数据注入 + 舰船名");
  info("meta.counts", JSON.stringify(meta()?.counts ?? null));
  check("isLoaded()", isLoaded(), true);
  check("ship(582) 非空", ship(582) !== null, true);
  const zh582 = zhName(582);
  check("zhName(582) 是中文", zh582 !== null && CJK_RE.test(zh582), true);
  info("zhName(582)", zh582);
  info("enName(582)", enName(582));
  check("未知 id zhName 返回 null", zhName(999999999), null);
  check("未知 id get 返回 null", get(999999999), null);
  check("未知 id chargesFor 返回空数组", Array.isArray(chargesFor(999999999)) && chargesFor(999999999).length === 0, true);

  /* ---------------------------------------------------------------- 2. 中英文同 id */
  console.log("\n[2] findByName 中英文解析");
  const idEn = findByName("Bantam");
  const idZh = findByName("矮脚鸡级"); // 582 的真实中文名
  info("findByName('Bantam')", idEn);
  info("findByName('矮脚鸡级')", idZh);
  check("Bantam 与 矮脚鸡级 解析到同一 typeId", idEn, idZh);
  check("且该 typeId 为 582", idEn, 582);
  check("findByName 大小写不敏感", findByName("bantam"), findByName("BANTAM"));
  check("findByName 未命中返回 null", findByName("不存在的名字XYZ"), null);

  // 任务书示例写的是 findByName("秃鹰级") 应与 Bantam 同 id。核对真实数据后：
  //   秃鹰级 -> 11192（是另一条舰船），Bantam/矮脚鸡级 -> 582。
  // 故该字面样例在本数据集中【无法成立】，此处如实记录，不伪造成通过。
  const idTuYing = findByName("秃鹰级");
  if (idTuYing !== idEn) {
    console.log(`  [NOTE] 任务书样例 findByName("秃鹰级")==findByName("Bantam") 在真实数据中不成立：`
      + `秃鹰级=${String(idTuYing)}，Bantam=${String(idEn)}（582 的中文名实为“矮脚鸡级”）。`);
    console.log("         已改为断言 Bantam ↔ 矮脚鸡级 同一 id（同样满足“中英文解析到同一 typeId”的本意）。");
  }

  /* ---------------------------------------------------------------- 3. 弹药匹配 */
  console.log("\n[3] chargesFor 弹药匹配");
  const launcherId = 499; // 轻型导弹发射器 I，cg=[384,394]
  const launcher = module_(launcherId) as ModuleData | null;
  check("module_(499) 非空", launcher !== null, true);
  const chs = chargesFor(launcherId);
  check("chargesFor(499) 非空", chs.length > 0, true);
  const cgSet = new Set((launcher?.cg ?? []).map(Number));
  let allInCg = true;
  for (const c of chs) {
    if (!cgSet.has(Number((c as ChargeData).group))) allInCg = false;
  }
  check("chargesFor(499) 每个弹药的 group 都在 cg 里", allInCg, true);
  info("chargesFor(499).length", chs.length);
  check("无 cg 模块 chargesFor 返回空数组", chargesFor(377).length, 0); // 小型护盾扩展装置
  const sm = chargesForModule(35921); // 屹立反旗舰导弹发射器 I（建筑模块）
  check("chargesForModule(建筑模块) 非空", sm.length > 0, true);

  /* ---------------------------------------------------------------- 4. 简写样例 */
  console.log("\n[4] 中文简写样例");
  check("moduleAbbr('多谱式护盾增强器 II')", moduleAbbr("多谱式护盾增强器 II"), "盾全抗");
  check("moduleAbbr('爆炸装甲增强器 II')", moduleAbbr("爆炸装甲增强器 II"), "甲爆抗");
  check("moduleAbbr('动能护盾增效器 II')", moduleAbbr("动能护盾增效器 II"), "盾动抗");
  check("moduleAbbr('电磁护盾增效器 I')", moduleAbbr("电磁护盾增效器 I"), "盾电抗");
  check("moduleAbbr('热能装甲增强器 I')", moduleAbbr("热能装甲增强器 I"), "甲热抗");
  check("moduleAbbr('多谱式涂层 II')", moduleAbbr("多谱式涂层 II", "装甲附甲"), "甲全抗");
  check("moduleAbbr('小型护盾扩展装置 I')", moduleAbbr("小型护盾扩展装置 I", "护盾扩展装置"), "盾扩");
  check("moduleAbbr('小型装甲维修器 I')", moduleAbbr("小型装甲维修器 I", "装甲维修组件"), "甲修");
  check("moduleAbbr('中型电容注电器 I')", moduleAbbr("中型电容注电器 I", "电容注电器"), "注电");
  check("moduleAbbr('跃迁扰频器 I')", moduleAbbr("跃迁扰频器 I", "跃迁扰乱设备"), "扰断");
  check("moduleAbbr 不因维修而误判抗性", moduleAbbr("突变适应远程装甲维修器 I", "突变适应远程装甲维修器"), "遥甲");
  check("weaponAbbr('1400mm榴弹炮 II')", weaponAbbr("1400mm榴弹炮 II"), "1400mm榴弹炮");
  check("weaponAbbr('超级集束激光器')", weaponAbbr("超级集束激光器"), "超级集束激光器");
  check("stripTech('多谱式护盾增强器 II')", stripTech("多谱式护盾增强器 II"), "多谱式护盾增强器");

  /* ---------------------------------------------------------------- 5. 全量扫描 */
  console.log("\n[5] 遍历全部 modules：非空 / 不抛异常 / 退化比例");
  const mods = raw.modules ?? {};
  const ids = Object.keys(mods);
  let emptyCount = 0;
  let throwCount = 0;
  const bySource: Record<string, number> = { resistance: 0, group: 0, weapon: 0, fallback: 0 };
  const fallbackGroups = new Map<string, number>();
  for (const id of ids) {
    const md = mods[id] as ModuleData;
    try {
      const r = moduleAbbrDetailed(md.zh, md.groupName);
      bySource[r.source]++;
      if (!r.abbr) emptyCount++;
      if (r.source === "fallback") {
        const g = md.groupName || "(无分组)";
        fallbackGroups.set(g, (fallbackGroups.get(g) ?? 0) + 1);
      }
    } catch (err) {
      throwCount++;
      console.log(`  [FAIL] moduleAbbr 抛异常 id=${id} zh=${md?.zh}: ${String(err)}`);
    }
  }
  const total = ids.length;
  const fallbackRatio = total ? (bySource.fallback / total) * 100 : 0;
  check("全部 modules 无空简写", emptyCount, 0);
  check("全部 modules 无异常", throwCount, 0);
  info("覆盖模块数", total);
  info("命中来源分布", `抗性=${bySource.resistance} 分组=${bySource.group} 武器=${bySource.weapon} 退化=${bySource.fallback}`);
  info("退化到通用规则的比例", `${fallbackRatio.toFixed(1)}%  (${bySource.fallback}/${total})`);
  const topFallback = [...fallbackGroups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (topFallback.length) {
    console.log("  [INFO] 退化最多的分组（供后续补规则）：");
    for (const [g, c] of topFallback) console.log(`           ${c}\t${g}`);
  } else {
    console.log("  [INFO] 无退化条目");
  }

  /* ---------------------------------------------------------------- 6. searchName 性能 */
  console.log("\n[6] searchName");
  const hits = searchName("bantam", 5);
  check("searchName('bantam') 命中非空", hits.length > 0, true);
  check("searchName('bantam') 含 582", hits.some((h) => h.id === 582), true);
  check("searchName 中文查询命中", searchName("护盾", 5).length > 0, true);
  const t0 = performance.now();
  let n = 0;
  for (let i = 0; i < 100; i++) n += searchName("护盾", 40).length;
  const ms = performance.now() - t0;
  info("searchName('护盾',40) ×100 次耗时", `${ms.toFixed(1)} ms（命中累计 ${n}）`);
  check("searchName 平均单次 < 20ms（2.1MB index 线性扫描）", ms / 100 < 20, true);

  /* ---------------------------------------------------------------- 汇总 */
  console.log("");
  console.log(`[sde-test] 完成：${checks} 项断言，${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[sde-test] 异常:", err);
  process.exit(2);
});

/**
 * 示例场景（交接文档 D-36：随包提供若干，用于教学与自检）。
 *
 * 全部由程序生成，因此可自由放大规模（性能测试用）。
 */
import type { EnvSpec, ImplantSpec, ModuleSpec } from "../shared/protocol.ts";
import type { BattleConfig } from "./battle.ts";
import { makeUnitId } from "./deterministic.ts";
import { blobFormation, FORMATION_SPACING } from "./formation.ts";
import type { Celestial, Doctrine, UnitBlueprint, Vec2 } from "./state.ts";

/* 常用 typeId（全部来自 SDE —— 见 sidecar/_probe_ids.py，不靠记忆） */
export const ID = {
  APOC_NAVY: 17726,
  MEGA_BEAM_II: 3049,
  STANDARD_L: 258,
  HEAT_SINK_II: 2364,
  REMOTE_ARMOR_II: 26914,
  REMOTE_CAP_II: 12102,
  WEB_II: 527,
  SCRAM_II: 448,
  // —— 旗舰 / 跳跃货舰（增援编成）——
  PHOENIX: 19726,
  REVELATION: 19720,
  APOSTLE: 37604,
  ARCHON: 23757,
  AEON: 23919,
  RHEA: 28844,
  // —— 会战 / 旗舰装备 ——
  SIEGE_II: 4292,
  TRIAGE_II: 4294,
  CAP_ARMOR_REPAIRER_II: 41500,
  CAP_REMOTE_ARMOR_II: 41466,
  CAP_REMOTE_SHIELD_II: 3618,
  CAP_NEUT_II: 40662,
  DUAL_GIGA_PULSE_II: 37298,
  MULTIFREQ_XL: 17686,
  // —— 建筑（§9.1：按单位处理，可装配、可开火、可被摧毁）——
  FORTIZAR: 35833,
  KEEPSTAR: 35834,
  STANDUP_ANTICAP: 35921,
  STANDUP_XL_NEUT: 35924,
  STANDUP_PDT: 35926,
  // —— 铁骑（一个发射管 = 一个纵队，D-27）——
  TEMPLAR_I: 23055,   // 轻型铁骑（Amarr）
  CYCLOPS_I: 32325,   // 重型铁骑（Gallente）
  STANDUP_TEMPLAR_I: 47035, // 建筑铁骑（纵队规模 9）
  // —— 指挥脉冲（模块 + 弹药）——
  ARMOR_COMMAND_BURST_II: 43552,
  ARMOR_ENERGIZING_CHARGE: 42832,
  // —— 立体炸弹（EMP 型：emDamage 300、作用半径 6000m、循环 10s）——
  LARGE_EMP_SMARTBOMB_II: 3995,
} as const;

export function lineFit(): ModuleSpec[] {
  const mods: ModuleSpec[] = [];
  for (let i = 0; i < 8; i++) {
    mods.push({ slot: "hi", typeId: ID.MEGA_BEAM_II, state: "active", chargeTypeId: ID.STANDARD_L });
  }
  for (let i = 0; i < 2; i++) mods.push({ slot: "lo", typeId: ID.HEAT_SINK_II, state: "active" });
  return mods;
}

export function logiFit(): ModuleSpec[] {
  return [
    { slot: "hi", typeId: ID.REMOTE_ARMOR_II, state: "active" },
    { slot: "med", typeId: ID.REMOTE_CAP_II, state: "active" },
  ];
}

export function tackleFit(): ModuleSpec[] {
  return [{ slot: "med", typeId: ID.WEB_II, state: "active" }];
}

/** 反跳（warp scrambler）：**拦住旗舰跳**的关键手段。 */
export function scramFit(): ModuleSpec[] {
  return [{ slot: "med", typeId: ID.SCRAM_II, state: "active" }];
}

/** 无畏配装：旗舰炮 + 会战装备（siege）+ 本地甲修。 */
export function dreadFit(): ModuleSpec[] {
  return [
    { slot: "hi", typeId: ID.DUAL_GIGA_PULSE_II, state: "active", chargeTypeId: ID.MULTIFREQ_XL },
    { slot: "hi", typeId: ID.SIEGE_II, state: "online" },
    { slot: "lo", typeId: ID.CAP_ARMOR_REPAIRER_II, state: "active" },
  ];
}

/** 战力辅助舰（FAX）配装：旗舰遥修 + 会战装备（triage）+ 旗舰毁电。 */
export function faxFit(): ModuleSpec[] {
  return [
    { slot: "hi", typeId: ID.CAP_REMOTE_ARMOR_II, state: "active" },
    { slot: "hi", typeId: ID.TRIAGE_II, state: "online" },
    { slot: "med", typeId: ID.CAP_NEUT_II, state: "active" },
  ];
}

/** 航空母舰配装：旗舰遥修 + 旗舰毁电。 */
export function carrierFit(): ModuleSpec[] {
  return [
    { slot: "hi", typeId: ID.CAP_REMOTE_ARMOR_II, state: "active" },
    { slot: "med", typeId: ID.CAP_NEUT_II, state: "active" },
  ];
}

/** 指挥舰配装：会战指挥脉冲（装甲激能弹药）。 */
export function commandFit(): ModuleSpec[] {
  return [{
    slot: "hi", typeId: ID.ARMOR_COMMAND_BURST_II, state: "active",
    chargeTypeId: ID.ARMOR_ENERGIZING_CHARGE,
  }];
}

/** 立体炸弹配装（EMP 型：作用半径 6km、EM 伤害 300、循环 10s）。 */
export function smartbombFit(): ModuleSpec[] {
  return [{ slot: "hi", typeId: ID.LARGE_EMP_SMARTBOMB_II, state: "active" }];
}

/** 建筑配装：反旗舰导弹 + 超大型毁电 + 点防（§9.1 建筑可装配、可开火）。 */
export function structureFit(): ModuleSpec[] {
  return [
    { slot: "hi", typeId: ID.STANDUP_ANTICAP, state: "active" },
    { slot: "hi", typeId: ID.STANDUP_XL_NEUT, state: "active" },
    { slot: "hi", typeId: ID.STANDUP_PDT, state: "active" },
  ];
}

interface Slot {
  index: number;
  role: UnitBlueprint["role"];
  modules: ModuleSpec[];
  name: string;
  order: UnitBlueprint["order"];
}

/** 生成一方的单位列表（线列 + 可选后勤/网船）。 */
function makeSide(
  sideId: 0 | 1,
  unitsPerSide: number,
  opts: { logi: boolean; tackle: boolean; baseX: number; doctrine: Doctrine },
): UnitBlueprint[] {
  const out: UnitBlueprint[] = [];
  let index = 0;
  // 入场编队：**密集圆形阵列**，而非方阵（见 core/formation.ts）。
  // 每一方的圆阵中心就是该方的锚点（baseX, 0）；红方随后整体镜像到对面。
  const positions = blobFormation(unitsPerSide, FORMATION_SPACING, { x: opts.baseX, y: 0 });
  const posFor = (i: number) => positions[i] ?? { x: opts.baseX, y: 0 };

  const slots: Slot[] = [];
  if (opts.logi) {
    slots.push({ index: index++, role: "logi", modules: logiFit(), name: "Apocalypse Navy Issue", order: { type: "hold" } });
  }
  if (opts.tackle) {
    slots.push({ index: index++, role: "line", modules: tackleFit(), name: "Apocalypse Navy Issue", order: { type: "hold" } });
  }
  while (slots.length < unitsPerSide) {
    slots.push({ index: index++, role: "line", modules: lineFit(), name: "Apocalypse Navy Issue", order: { type: "hold" } });
  }

  for (const s of slots) {
    out.push({
      unitId: makeUnitId(sideId, 0, 0, 0, s.index),
      name: `${sideId === 0 ? "蓝" : "红"}-${s.role}-${s.index + 1}`,
      shipName: s.name,
      shipTypeId: ID.APOC_NAVY,
      sideId,
      fleetId: 0,
      wingId: 0,
      squadId: s.role === "logi" ? 1 : 0,
      role: s.role,
      modules: s.modules,
      drones: [],
      fighters: [],
      fitFingerprint: `gen-${s.role}`,
      doctrine: opts.doctrine,
      order: s.order,
      pos: posFor(s.index),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 地物与增援编成                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 星门（星门增援的入场口）与一座中立空间站。
 * ★ 地物（§9.2）：不可装配、不可开火、不可摧毁；玩家建筑不在此列，它是**单位**。
 */
export function celestialsFor(blueX: number, redX: number): Celestial[] {
  return [
    { id: "gate:0", kind: "stargate", name: "蓝方星门", sideId: 0, pos: { x: blueX, y: -140_000 }, radiusM: 25_000 },
    { id: "gate:1", kind: "stargate", name: "红方星门", sideId: 1, pos: { x: redX, y: -140_000 }, radiusM: 25_000 },
    { id: "station:0", kind: "station", name: "中立空间站", sideId: null, pos: { x: 0, y: 70_000 }, radiusM: 40_000 },
  ];
}

/**
 * 增援编成（场外待召）。
 *
 * 全部是**旗舰**，因此天生具备旗舰跳能力（SDE `jumpDriveRange > 0`）。
 * 属性在 Battle 创建时一次性预热，所以运行中的「增援」指令是纯同步的。
 */
export function makeReserves(sideId: 0 | 1, anchorX: number): UnitBlueprint[] {
  const defs: Array<{
    tag: string;
    ship: string;
    typeId: number;
    modules: ModuleSpec[];
  }> = [
    { tag: "无畏", ship: "Revelation", typeId: ID.REVELATION, modules: dreadFit() },
    { tag: "无畏", ship: "Revelation", typeId: ID.REVELATION, modules: dreadFit() },
    { tag: "战力辅助", ship: "Apostle", typeId: ID.APOSTLE, modules: faxFit() },
    { tag: "航母", ship: "Archon", typeId: ID.ARCHON, modules: carrierFit() },
  ];
  return defs.map((d, i) => ({
    unitId: `res:${sideId}:${i}`,
    name: `${sideId === 0 ? "蓝" : "红"}-增援-${d.tag}-${i + 1}`,
    shipName: d.ship,
    shipTypeId: d.typeId,
    sideId,
    fleetId: 0,
    wingId: 1,
    squadId: 2,
    role: "capital" as UnitBlueprint["role"],
    modules: d.modules,
    drones: [],
    fighters: [],
    fitFingerprint: `reserve-${d.tag}-${d.typeId}`,
    // 建筑/旗舰都不做"自动接敌"，交火方式交给玩家指令
    doctrine: "free" as Doctrine,
    order: { type: "hold" },
    // 未入场时的占位坐标（只有入场后才加入 state.units，因此不会显示）
    pos: { x: anchorX, y: -140_000 },
  }));
}

/**
 * 建筑单位（§9.1「玩家建筑：可装配、可开火、可被摧毁」）。
 * 与地物的区别就在这里：它会出现在 `state.units` 里，有 HP、能开火、能被摧毁。
 */
export function makeStructure(
  sideId: 0 | 1, index: number, typeId: number, pos: Vec2,
): UnitBlueprint {
  const isKeepstar = typeId === ID.KEEPSTAR;
  return {
    unitId: `struct:${sideId}:${index}`,
    name: `${sideId === 0 ? "蓝" : "红"}方${isKeepstar ? "星城" : "铁壁"}`,
    shipName: isKeepstar ? "Keepstar" : "Fortizar",
    shipTypeId: typeId,
    sideId,
    fleetId: 0,
    wingId: 0,
    squadId: 3,
    role: "structure",
    modules: structureFit(),
    drones: [],
    fighters: [],
    fitFingerprint: `structure-${typeId}`,
    // 建筑不机动（PYFA 给的最大速度为 0），也不该自动接敌
    doctrine: "free" as Doctrine,
    order: { type: "hold" },
    pos,
  };
}

/* -------------------------------------------------------------------------- */
/* 脑插与指挥脉冲（环境加成）                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 「高级极乐」(High-grade Nirvana) 植入体全套。
 *
 * 演示用户的规则：**配置里有脑插才算**。实测整套 +53.6% 护盾；
 * 只装单件（Alpha）+1.15% —— 套装机制天然体现。
 */
export const HIGHGRADE_NIRVANA: ImplantSpec[] = [
  { name: "High-grade Nirvana Alpha" },
  { name: "High-grade Nirvana Beta" },
  { name: "High-grade Nirvana Gamma" },
  { name: "High-grade Nirvana Delta" },
  { name: "High-grade Nirvana Epsilon" },
  { name: "High-grade Nirvana Omega" },
];

/**
 * 装甲指挥脉冲（实战常见形态：满级技能 + 指挥舰船体加成 + 指挥脉冲脑插）。
 *
 * `strength: 5` = 指挥舰/T3 + 满级技能；`mindlink: true` = 带指挥脉冲脑插。
 * 两者都被 PYFA 折算进 `getLinkMultiplier(strength, mindlink)`
 * （实测 5 + mindlink → ×2.9296875，装甲 EM 共振 0.5 → 0.3828125）。
 */
export function armorBurstEnv(): EnvSpec {
  return {
    commandLinks: [
      { linkType: "armor_energizing", strength: 5, mindlink: true },
      { linkType: "armor_reinforcement", strength: 5, mindlink: true },
    ],
  };
}

/**
 * 航母（铁骑为主动力来源，用于 §9.1「无人机 / 铁骑」的复盘）。
 * `fighters` 里的 `count` 是**发射管数**：一个发射管 = 一个纵队（D-27）。
 */
export function makeCarrier(
  sideId: 0 | 1, index: number, pos: Vec2,
): UnitBlueprint {
  return {
    unitId: `cv:${sideId}:${index}`,
    name: `${sideId === 0 ? "蓝" : "红"}-航母-${index + 1}`,
    shipName: "Archon",
    shipTypeId: ID.ARCHON,
    sideId,
    fleetId: 0,
    wingId: 1,
    squadId: 0,
    role: "capital",
    modules: carrierFit(),
    drones: [],
    fighters: [
      { typeId: ID.TEMPLAR_I, count: 2 },   // 2 个轻型铁骑纵队
      { typeId: ID.CYCLOPS_I, count: 1 },   // 1 个重型铁骑纵队
    ],
    fitFingerprint: `carrier-archon-${index}`,
    doctrine: "focus" as Doctrine,
    order: { type: "hold" },
    pos,
  };
}

export interface ScenarioInfo {
  id: string;
  name: string;
  description: string;
}

export const SCENARIOS: ScenarioInfo[] = [
  { id: "duel", name: "单挑靶船", description: "蓝方 1 舰（1×超级集束激光器）对红方无武装靶船，用于解析解校验。" },
  { id: "line-brawl", name: "战列线对决", description: "红蓝各 8 艘战列舰，密集圆阵入场，集中火力互射。" },
  { id: "logi-line", name: "后勤掩护线", description: "红蓝各 6 线列 + 1 后勤（远程甲修 + 传电），对比有无后勤的差异。" },
  { id: "tackle-line", name: "网船压制", description: "蓝方带网船与反跳，验证电子战与「被反跳则不能旗舰跳」。" },
  { id: "capital-reinforce", name: "旗舰增援", description: "战列线交火中投入旗舰增援：星门派遣 / 旗舰跳直达；旗舰可旗舰跳撤场。" },
  { id: "structure-assault", name: "建筑攻防", description: "蓝方战列线强攻红方铁壁：建筑可装配、可开火、可被摧毁（§9.1）。" },
  { id: "carrier-strike", name: "航母铁骑打击", description: "蓝方 2 航母（轻型+重型铁骑）带高级极乐脑插与装甲指挥脉冲，对红方战列线；用于铁骑与加成的复盘。" },
  { id: "command-burst", name: "指挥脉冲作用域", description: "蓝方同一舰队的两艘指挥舰（一强一弱、射程不同），验证「同舰队才受益、同种取最强、非交集各取自己」。" },
  { id: "smartbomb", name: "立体炸弹", description: "蓝方双立体炸弹贴身引爆：敌舰、友军、以及铁骑/无人机都会被波及。" },
  { id: "stress", name: "压力测试", description: "红蓝各 100 艘，用于 UI 帧率与推演性能实测。" },
];

/**
 * 把红方整体镜像到 x 轴另一侧。
 * 两侧都用同一个 baseX 生成，再把红方取负 —— 这样"两队之间隔开一段距离"
 * 才是真的隔开（否则密集圆阵会彼此重叠）。
 */
function mirrorRed(list: UnitBlueprint[]): UnitBlueprint[] {
  return list.map((b) => (b.sideId === 1 ? { ...b, pos: { x: -b.pos.x, y: b.pos.y } } : b));
}

/** 每个场景通用的地物与增援编成（不主动投入就不影响推演结果）。 */
function theater(anchorX: number): Pick<BattleConfig, "celestials" | "reserves"> {
  return {
    celestials: celestialsFor(-anchorX, anchorX),
    reserves: [...makeReserves(0, -anchorX), ...makeReserves(1, -anchorX)],
  };
}

export function buildScenario(id: string, opts: { unitsPerSide?: number } = {}): BattleConfig {
  const n = opts.unitsPerSide;
  switch (id) {
    case "duel": {
      // 解析解校验场景：保持纯净（无地物、无增援），便于手算比对
      const blue = makeSide(0, 1, { logi: false, tackle: false, baseX: 0, doctrine: "focus" });
      blue[0].modules = [{ slot: "hi", typeId: ID.MEGA_BEAM_II, state: "active", chargeTypeId: ID.STANDARD_L }];
      const red = makeSide(1, 1, { logi: false, tackle: false, baseX: 0, doctrine: "hold" });
      red[0].modules = [];
      return {
        seed: 20261008, mode: "expected",
        settings: { passiveShieldRegen: true },
        blueprints: [...blue, ...red],
      };
    }
    case "line-brawl": {
      const k = n ?? 8;
      const anchor = 30_000;
      return {
        seed: 20261008, mode: "expected",
        ...theater(anchor),
        blueprints: mirrorRed([
          ...makeSide(0, k, { logi: false, tackle: false, baseX: -anchor, doctrine: "focus" }),
          ...makeSide(1, k, { logi: false, tackle: false, baseX: -anchor, doctrine: "focus" }),
        ]),
      };
    }
    case "logi-line": {
      const k = n ?? 6;
      const anchor = 30_000;
      return {
        seed: 20261008, mode: "expected",
        ...theater(anchor),
        blueprints: mirrorRed([
          ...makeSide(0, k, { logi: true, tackle: false, baseX: -anchor, doctrine: "focus" }),
          ...makeSide(1, k, { logi: false, tackle: false, baseX: -anchor, doctrine: "focus" }),
        ]),
      };
    }
    case "tackle-line": {
      const k = n ?? 6;
      const anchor = 30_000;
      // 蓝方额外带一条反跳船：用于验证"被反跳的旗舰不能跳走"
      const blue = makeSide(0, k, { logi: false, tackle: true, baseX: -anchor, doctrine: "focus" });
      if (blue.length > 1) {
        blue[1].modules = scramFit();
        blue[1].name = "蓝-反跳-1";
        blue[1].fitFingerprint = "gen-scram";
      }
      return {
        seed: 20261008, mode: "expected",
        ...theater(anchor),
        blueprints: mirrorRed([
          ...blue,
          ...makeSide(1, k, { logi: false, tackle: false, baseX: -anchor, doctrine: "focus" }),
        ]),
      };
    }
    case "capital-reinforce": {
      const k = n ?? 6;
      const anchor = 40_000;
      return {
        seed: 20261008, mode: "expected",
        ...theater(anchor),
        blueprints: mirrorRed([
          ...makeSide(0, k, { logi: true, tackle: true, baseX: -anchor, doctrine: "focus" }),
          ...makeSide(1, k, { logi: false, tackle: false, baseX: -anchor, doctrine: "focus" }),
        ]),
      };
    }
    case "structure-assault": {
      const k = n ?? 6;
      const anchor = 30_000;
      const blue = makeSide(0, k, { logi: true, tackle: false, baseX: -anchor, doctrine: "focus" });
      const red = mirrorRed(makeSide(1, 2, { logi: false, tackle: false, baseX: -anchor, doctrine: "focus" }));
      return {
        seed: 20261008, mode: "expected",
        ...theater(anchor),
        // 建筑作为**单位**参战：可装配、可开火、可被摧毁
        blueprints: [...blue, ...red, makeStructure(1, 0, ID.FORTIZAR, { x: anchor, y: 0 })],
      };
    }
    case "carrier-strike": {
      const k = n ?? 4;
      const anchor = 60_000;
      return {
        seed: 20261008, mode: "expected",
        ...theater(anchor),
        // 蓝方：高级极乐脑插全套 + 装甲指挥脉冲（strength 5 + 脑插）
        // 红方：什么都不带 —— 直接对照出"有加成 / 无加成"的差别
        implants: HIGHGRADE_NIRVANA,
        envBySide: { 0: armorBurstEnv() },
        blueprints: [
          makeCarrier(0, 0, { x: -anchor, y: 0 }),
          makeCarrier(0, 1, { x: -anchor, y: 15_000 }),
          ...mirrorRed(makeSide(1, k, {
            logi: true, tackle: false, baseX: -anchor, doctrine: "focus",
          })),
        ],
      };
    }
    case "command-burst": {
      const mk = (
        sideId: 0 | 1, fleetId: number, index: number, x: number, burst?: "strong" | "weak",
      ): UnitBlueprint => ({
        unitId: `cb:${sideId}:${fleetId}:${index}`,
        name: `${sideId === 0 ? "蓝" : "红"}-${burst ? (burst === "strong" ? "指挥A" : "指挥B") : "线列"}-${index}`,
        shipName: "Apocalypse Navy Issue",
        shipTypeId: ID.APOC_NAVY,
        sideId,
        fleetId,
        wingId: 0,
        squadId: 0,
        role: "line" as UnitBlueprint["role"],
        modules: burst ? commandFit() : lineFit(),
        drones: [],
        fighters: [],
        fitFingerprint: burst ? `burst-${burst}` : "cb-line",
        doctrine: (burst ? "free" : "focus") as Doctrine,
        order: { type: "hold" },
        pos: { x, y: 0 },
      });
      const cmdA = mk(0, 0, 0, -20_000, "strong");
      const cmdB = mk(0, 0, 1, 0, "weak");
      return {
        seed: 20261008, mode: "expected",
        settings: { passiveShieldRegen: false },
        // 两艘指挥舰同属蓝方**舰队 0**：A 强（5 + 脑插，40km）、B 弱（2，10km）
        commandBurstSources: [
          {
            unitId: cmdA.unitId, linkType: "armor_energizing",
            strength: 5, mindlink: true, rangeM: 40_000, moduleIndex: 0,
          },
          {
            unitId: cmdB.unitId, linkType: "armor_energizing",
            strength: 2, mindlink: false, rangeM: 10_000, moduleIndex: 0,
          },
        ],
        blueprints: [
          cmdA, cmdB,
          mk(0, 0, 2, -22_000), // 只在 A 射程内
          mk(0, 0, 3, -5_000),  // A ∩ B → 取最强（A）
          mk(0, 0, 4, -80_000), // 两个都够不着
          mk(0, 1, 0, -18_000), // ★ 在 A 射程内，但属于**另一个舰队** → 不应受益
          mk(1, 0, 0, 40_000),  // 红方陪衬
        ],
      };
    }
    case "smartbomb": {
      const bomb = (index: number, x: number): UnitBlueprint => ({
        unitId: `sb:${index}`,
        name: `蓝-炸弹-${index + 1}`,
        shipName: "Apocalypse Navy Issue",
        shipTypeId: ID.APOC_NAVY,
        sideId: 0,
        fleetId: 0,
        wingId: 0,
        squadId: 0,
        role: "line" as UnitBlueprint["role"],
        modules: smartbombFit(),
        drones: [],
        fighters: [],
        fitFingerprint: `smartbomb-${index}`,
        doctrine: "free" as Doctrine,
        order: { type: "hold" },
        pos: { x, y: 0 },
      });
      const redLine: UnitBlueprint = {
        unitId: "sbr:0",
        name: "红-线列-1",
        shipName: "Apocalypse Navy Issue",
        shipTypeId: ID.APOC_NAVY,
        sideId: 1,
        fleetId: 0,
        wingId: 0,
        squadId: 0,
        role: "line" as UnitBlueprint["role"],
        modules: lineFit(),
        drones: [],
        fighters: [],
        fitFingerprint: "sbr-line",
        doctrine: "free" as Doctrine,
        order: { type: "hold" },
        pos: { x: 1_000, y: 0 },
      };
      return {
        seed: 20261008, mode: "expected",
        settings: { passiveShieldRegen: false },
        blueprints: [
          bomb(0, -3_000),
          bomb(1, -1_000),          // 两枚炸弹相距 2km → 会互相炸到（EVE 行为）
          redLine,                  // 敌方
          makeCarrier(1, 0, { x: 2_500, y: 0 }), // 红方航母：铁骑也会被炸
        ],
      };
    }
    case "stress":
    default: {
      const k = n ?? 100;
      const anchor = 80_000;
      return {
        seed: 20261008, mode: "expected",
        ...theater(anchor),
        blueprints: mirrorRed([
          ...makeSide(0, k, { logi: false, tackle: false, baseX: -anchor, doctrine: "focus" }),
          ...makeSide(1, k, { logi: false, tackle: false, baseX: -anchor, doctrine: "focus" }),
        ]),
      };
    }
  }
}

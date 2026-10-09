/**
 * 舰船标识（吨位图标）归类 + 势力配色。
 *
 * ★ 归类**建立在 SDE 的 category / group 上，不对船名做正则猜测**。
 *   这样用户的图标规则自然成立：
 *     多米尼克斯级（`Battleship`）/ 多米尼克斯级海军型（`Battleship`）/
 *     罪恶级（`Black Ops`）/ 克洛诺斯级（`Marauder`）
 *     → 同属"战列舰"，用同一个 `battleship.png`。
 *
 * group 名清单来自实测（`sidecar/_probe_hulls.py`，PYFA v2.69.0 的 eve.db）。
 */

/** 可用的图标类别，一一对应 `src/ui/assets/ships/<name>.png`。 */
export type IconClass =
  | "shuttle" | "frigate" | "destroyer" | "cruiser" | "battlecruiser" | "battleship"
  | "transport" | "freighter"
  | "dreadnought" | "fax" | "carrier" | "supercarrier" | "titan" | "colossus"
  | "keepstar" | "fortizar"
  | "unknown";

export const ICON_CLASSES: readonly IconClass[] = [
  "shuttle", "frigate", "destroyer", "cruiser", "battlecruiser", "battleship",
  "transport", "freighter",
  "dreadnought", "fax", "carrier", "supercarrier", "titan", "colossus",
  "keepstar", "fortizar",
];

/** 吨位类别的中文名（战报 / 列表显示用；与图标集一一对应）。 */
export const ICON_CLASS_LABELS: Record<IconClass, string> = {
  shuttle: "穿梭机",
  frigate: "护卫舰",
  destroyer: "驱逐舰",
  cruiser: "巡洋舰",
  battlecruiser: "战斗巡洋舰",
  battleship: "战列舰",
  transport: "运输舰",
  freighter: "货舰",
  dreadnought: "无畏舰",
  fax: "后勤旗舰",
  carrier: "航母",
  supercarrier: "超级航母",
  titan: "泰坦",
  colossus: "巨像",
  keepstar: "星城",
  fortizar: "建筑",
  unknown: "未知",
};

/** 战报里的展示顺序：**吨位从大到小**（用户示例：无畏舰在战列舰之前）。 */
export const ICON_CLASS_ORDER: readonly IconClass[] = [
  "keepstar", "titan", "supercarrier", "colossus", "dreadnought", "carrier", "fax",
  "fortizar", "freighter", "battleship", "battlecruiser", "cruiser", "destroyer",
  "frigate", "transport", "shuttle", "unknown",
];

/** 吨位类别 → 中文名；未知类别回退到"未知"。 */
export function iconClassLabel(cls: string | null | undefined): string {
  if (!cls) return ICON_CLASS_LABELS.unknown;
  return ICON_CLASS_LABELS[cls as IconClass] ?? ICON_CLASS_LABELS.unknown;
}

/** SDE group 名 → 图标类别。同吨位不同科技等级刻意映射到同一项。 */
const GROUP_TO_ICON: Record<string, IconClass> = {
  // —— 小型 ——
  Corvette: "shuttle",
  Shuttle: "shuttle",
  Frigate: "frigate",
  "Assault Frigate": "frigate",
  "Covert Ops": "frigate",
  Interceptor: "frigate",
  "Electronic Attack Ship": "frigate",
  "Expedition Frigate": "frigate",
  "Logistics Frigate": "frigate",
  "Stealth Bomber": "frigate",
  "Prototype Exploration Ship": "frigate",
  Destroyer: "destroyer",
  Interdictor: "destroyer",
  "Command Destroyer": "destroyer",
  "Tactical Destroyer": "destroyer",
  // —— 中型 ——
  Cruiser: "cruiser",
  "Heavy Assault Cruiser": "cruiser",
  "Heavy Interdiction Cruiser": "cruiser",
  Logistics: "cruiser",
  "Recon Ship": "cruiser",
  "Strategic Cruiser": "cruiser",
  "Flag Cruiser": "cruiser",
  "Expedition Cruiser": "cruiser",
  "Combat Battlecruiser": "battlecruiser",
  "Attack Battlecruiser": "battlecruiser",
  "Command Ship": "battlecruiser",
  // —— 大型 ——
  Battleship: "battleship",
  "Elite Battleship": "battleship",
  "Black Ops": "battleship",
  Marauder: "battleship",
  // —— 工业 ——
  Hauler: "transport",
  Industrial: "transport",
  "Blockade Runner": "transport",
  "Deep Space Transport": "transport",
  Freighter: "freighter",
  "Jump Freighter": "freighter",
  // —— 旗舰 ——
  Dreadnought: "dreadnought",
  "Lancer Dreadnought": "dreadnought",
  "Force Auxiliary": "fax",
  Carrier: "carrier",
  Supercarrier: "supercarrier",
  Titan: "titan",
  Colossus: "colossus",
  // —— 建筑（图标集只有两种建筑形状，其余归到"铁壁"形状并靠名称细分）——
  Citadel: "fortizar",
  "Engineering Complex": "fortizar",
  Refinery: "fortizar",
  "Upwell Structure": "fortizar",
};

/** 名称兜底：缺少 SDE group 信息时（或需要更细的建筑区分时）使用。 */
const NAME_RULES: Array<[RegExp, IconClass]> = [
  [/keepstar/i, "keepstar"],
  [/fortizar|astrahus|raitaru|athanor|tatara|citadel/i, "fortizar"],
  [/titan/i, "titan"],
  [/supercarrier/i, "supercarrier"],
  [/colossus/i, "colossus"],
  [/carrier|thanatos|nidhoggur|chimera|archon/i, "carrier"],
  [/fax|force auxiliary|apostle|minokawa|lif|ninazu/i, "fax"],
  [/dreadnought|dread|phoenix|moros|naglfar|revelation/i, "dreadnought"],
  [/jump freighter|freighter|charon|obelisk|fenrir|providence/i, "freighter"],
  [/industrial|hauler|transport|iteron|badger|mammoth|bestower|prowler|bustard/i, "transport"],
  [/marauder|black ops|battleship|apocalypse|raven|megathron|tempest|domi|abaddon|rokh|hyperion|maelstrom|vargur|kronos|panther|sin/i, "battleship"],
  [/battlecruiser|harbinger|drake|brutix|hurricane|sleipnir|cyclone/i, "battlecruiser"],
  [/cruiser|omen|caracal|vexor|stabber|maller|thorax|rupture|loki|muninn|vagabond/i, "cruiser"],
  [/destroyer|coercer|corax|algos|thrasher|interdictor|sabre|flycatcher/i, "destroyer"],
  [/frigate|rifter|punisher|merlin|incursus|slasher|executioner|condor|atron|breacher|wolf|jaguar|retribution/i, "frigate"],
  [/shuttle|corvette|impairor|ibis|velator|reaper/i, "shuttle"],
];

/**
 * 判定图标类别。优先用 SDE group（权威），缺失时退回船名规则。
 * @param groupName   SDE group 名（`calcFit` 响应的 `ship.groupName`）
 * @param shipName    船名（兜底）
 */
export function iconClassOf(groupName: string | null | undefined, shipName: string): IconClass {
  const byGroup = groupName ? GROUP_TO_ICON[groupName] : undefined;
  // 建筑组内按名称细分：星城 → keepstar 图标，其余建筑 → fortizar 图标
  if (byGroup === "fortizar") return /keepstar/i.test(shipName) ? "keepstar" : "fortizar";
  if (byGroup) return byGroup;
  for (const [re, cls] of NAME_RULES) {
    if (re.test(shipName)) return cls;
  }
  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* 配色                                                                        */
/* -------------------------------------------------------------------------- */

/** 帝国（SDE raceID）→ 名称与配色。raceID 为 2 的幂：1=Caldari 2=Minmatar 4=Amarr 8=Gallente。 */
export const EMPIRES: Record<number, { name: string; color: string }> = {
  1: { name: "加达里", color: "#5aa9e6" },
  2: { name: "米玛塔尔", color: "#e0813f" },
  4: { name: "阿玛尔", color: "#e8c24a" },
  8: { name: "盖伦特", color: "#5fd39a" },
};

export const NEUTRAL_EMPIRE_COLOR = "#cfd8e6";

/**
 * 图标染色方式。
 *
 * `side`（默认）：按**本沙盒的势力**——红方 / 蓝方（D-19：固定红蓝双方）染色。
 * `empire`：按舰船的 **EVE 帝国**（阿玛尔 / 加达里 / 盖伦特 / 米玛塔尔）染色。
 *
 * 两种信息都已具备（side 来自单位，empire 来自 SDE raceID），切换只需改这一个常量。
 */
export const ICON_TINT_MODE: "side" | "empire" = "side";

export function empireColor(raceId: number | null | undefined): string {
  if (raceId && EMPIRES[raceId]) return EMPIRES[raceId].color;
  return NEUTRAL_EMPIRE_COLOR;
}

export function empireName(raceId: number | null | undefined): string {
  if (raceId && EMPIRES[raceId]) return EMPIRES[raceId].name;
  return "未知";
}

/** 图标基准尺寸（CSS px，按吨位递增）。 */
export const ICON_SIZE: Record<IconClass, number> = {
  shuttle: 11,
  frigate: 12,
  destroyer: 13,
  cruiser: 15,
  battlecruiser: 17,
  battleship: 19,
  transport: 17,
  freighter: 22,
  dreadnought: 22,
  fax: 22,
  carrier: 24,
  supercarrier: 26,
  titan: 29,
  colossus: 27,
  keepstar: 34,
  fortizar: 28,
  unknown: 14,
};

export function iconSizeOf(cls: IconClass): number {
  return ICON_SIZE[cls] ?? ICON_SIZE.unknown;
}

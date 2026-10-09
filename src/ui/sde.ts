/**
 * 静态数据访问层（TypeScript 版）。
 *
 * 对应上一版 `reference/src/core/sde.js`（232 行）的等价 TS 实现，接口保持同名同义。
 * 读取 tools/extract-sde.mjs 从 PYFA (eve.db) 抽取出来的本地 JSON 数据包，纯离线，
 * 运行时不依赖 sqlite / 网络。
 *
 * ★ 构建方式：tools/build-ui.ts 用 Node 内置类型擦除（无打包器），`.json` 会被原样拷贝到
 *   `dist/ui/src/ui/data/`。所以**不能** `import x from "./x.json"`（那需要 JSON 模块加载
 *   或打包器），必须运行时用相对 URL fetch。本模块位于 `dist/ui/src/ui/sde.js`，数据位于
 *   `dist/ui/src/ui/data/`，因此 `./data/xxx.json`（相对本模块）即可用 `new URL(...)` 解析。
 *
 * ★ 数值一律来自 PYFA oracle；本数据层只提供名称/槽位/分组/弹药匹配等**静态信息**，
 *   不参与任何数值计算。
 */

/* ------------------------------------------------------------------ 类型定义 */

/** 所有可查询条目共有的字段（舰船 / 模块 / 弹药 / 无人机 / 建筑 / 可部署物）。 */
export interface TypeInfo {
  id: number;
  /** 中文名 */
  zh: string;
  /** 英文名 */
  en: string;
  /** 分组 id */
  group: number;
  /** 中文分组名 */
  groupName: string;
  /** 允许兜底，避免用 any */
  [k: string]: unknown;
}

/** 属性袋（a 字段），键值不逐一枚举，用 unknown 访问 + 收窄。 */
export type AttrBag = Record<string, unknown>;

export interface SlotLayout {
  hi?: number;
  med?: number;
  low?: number;
  rig?: number;
  turret?: number;
  launcher?: number;
  service?: number;
  [k: string]: unknown;
}

export interface ShipData extends TypeInfo {
  meta?: number | null;
  tech?: number | null;
  slots?: SlotLayout;
  /** 是否建筑（structShips 条目为 true） */
  isStructure?: boolean;
}

export interface ModuleData extends TypeInfo {
  meta?: number | null;
  tech?: number | null;
  slot?: string;
  weapon?: boolean;
  /** 是否建筑模块 */
  struct?: boolean;
  /** 属性袋 */
  a?: AttrBag;
  /** 效果名列表 */
  e?: string[];
  /** 可装弹药的 charge group id 列表 */
  cg?: number[];
  /** 弹药尺寸（chargeSize） */
  cs?: number;
}

export interface ChargeData extends TypeInfo {
  meta?: number | null;
  a?: AttrBag;
  e?: string[];
}

export interface DroneData extends TypeInfo {
  meta?: number | null;
  /** 分类 id：87 = 铁骑，18 = 普通无人机 */
  cat?: number;
  a?: AttrBag;
  e?: string[];
}

export interface StructureData extends TypeInfo {
  cat?: number;
  a?: AttrBag;
  e?: string[];
}

export interface DeployableData extends TypeInfo {
  a?: AttrBag;
  e?: string[];
}

export interface GroupData {
  id: number;
  name: string;
  en?: string;
  cat?: number;
  [k: string]: unknown;
}

export interface MetaData {
  source?: string;
  build?: string;
  schema?: string;
  generated?: string;
  counts?: Record<string, number>;
  [k: string]: unknown;
}

export interface GroupsFile {
  groups: Record<string, GroupData>;
  categories?: Record<string, unknown>;
  attrIds?: Record<string, unknown>;
  [k: string]: unknown;
}

/** index.json 条目：[名称, typeId]，中英文名各一条。 */
export type IndexEntry = [string, number];

/** 名称搜索命中结果。 */
export interface NameHit {
  id: number;
  /** 命中的原始名称（中文或英文） */
  name: string;
  zh: string | null;
  en: string | null;
}

/** 注入用的原始数据（hydrateFrom 参数）。 */
export interface SdeRaw {
  meta?: MetaData | null;
  groups?: GroupsFile | null;
  ships?: Record<string, ShipData>;
  structShips?: Record<string, ShipData>;
  modules?: Record<string, ModuleData>;
  structModules?: Record<string, ModuleData>;
  charges?: Record<string, ChargeData>;
  drones?: Record<string, DroneData>;
  structures?: Record<string, StructureData>;
  deployables?: Record<string, DeployableData>;
  index?: IndexEntry[];
}

/* ------------------------------------------------------------------ 数据源 */

/** 各数据文件的相对 URL（相对本模块，保证在 dist 目录结构下也正确）。 */
const FILES: Record<string, URL> = {
  meta: new URL("./data/meta.json", import.meta.url),
  groups: new URL("./data/groups.json", import.meta.url),
  ships: new URL("./data/ships.json", import.meta.url),
  structShips: new URL("./data/structShips.json", import.meta.url),
  modules: new URL("./data/modules.json", import.meta.url),
  structModules: new URL("./data/structModules.json", import.meta.url),
  charges: new URL("./data/charges.json", import.meta.url),
  drones: new URL("./data/drones.json", import.meta.url),
  structures: new URL("./data/structures.json", import.meta.url),
  deployables: new URL("./data/deployables.json", import.meta.url),
  index: new URL("./data/index.json", import.meta.url),
};

/* ------------------------------------------------------------------ 内部 DB */

/** 内部数据库（对外只读）。 */
export interface SdeDatabase {
  meta: MetaData | null;
  groups: GroupsFile | null;
  ships: Record<string, ShipData>;
  structShips: Record<string, ShipData>;
  modules: Record<string, ModuleData>;
  structModules: Record<string, ModuleData>;
  charges: Record<string, ChargeData>;
  drones: Record<string, DroneData>;
  structures: Record<string, StructureData>;
  deployables: Record<string, DeployableData>;
  index: IndexEntry[];
}

export const DB: SdeDatabase = {
  meta: null,
  groups: null,
  ships: {},
  structShips: {},
  modules: {},
  structModules: {},
  charges: {},
  drones: {},
  structures: {},
  deployables: {},
  index: [],
};

/** 名称 -> typeID（小写索引，中英文都在，先到先得）。 */
let nameMap = new Map<string, number>();

/** 重建名称索引：小写、去空白；同一 key 先到先得。 */
function rebuildNameMap(): void {
  nameMap = new Map();
  for (const entry of DB.index) {
    if (!entry || entry.length < 2) continue;
    const key = String(entry[0]).toLowerCase().trim();
    if (!key) continue;
    if (!nameMap.has(key)) nameMap.set(key, Number(entry[1]));
  }
}

/* ------------------------------------------------------------------ 加载 */

/**
 * 并发 fetch 全部 JSON，填充内部 DB 并构建名称索引。
 * @param onProgress 可选进度回调 (key, index, total)
 */
export async function loadSde(
  onProgress: (key: string, index: number, total: number) => void = () => {},
): Promise<SdeDatabase> {
  const keys = Object.keys(FILES);
  const results = await Promise.all(
    keys.map(async (k, i) => {
      onProgress(k, i, keys.length);
      // `cache` 属于 fetch 标准选项，但当前 tsconfig 未引入 DOM lib，RequestInit 类型里缺失，
      // 故显式断言为 RequestInit 以避免类型报错（运行时行为不变：禁用缓存取静态数据）。
      const res = await fetch(FILES[k], { cache: "no-cache" } as RequestInit);
      if (!res.ok) {
        throw new Error("数据文件缺失: " + FILES[k].pathname + " —— 请先执行 npm run extract");
      }
      return [k, (await res.json()) as unknown] as const;
    }),
  );
  for (const [k, v] of results) {
    // 运行时注入，字段形状由数据包保证；用 unknown 收窄而非 any。
    (DB as unknown as Record<string, unknown>)[k] = v;
  }
  rebuildNameMap();
  return DB;
}

/** 数据是否已加载（meta 存在即视为就绪）。 */
export const isLoaded = (): boolean => !!DB.meta;

/** 上一版别名，保持兼容。 */
export const ready = (): boolean => isLoaded();

/**
 * 直接注入数据（供 Node 端自检脚本 / 单元测试使用，浏览器端走 loadSde）。
 * 只覆盖传入的键，未传的保持原值。
 */
export function hydrateFrom(raw: SdeRaw): SdeDatabase {
  if (raw.meta !== undefined) DB.meta = raw.meta;
  if (raw.groups !== undefined) DB.groups = raw.groups;
  if (raw.ships !== undefined) DB.ships = raw.ships;
  if (raw.structShips !== undefined) DB.structShips = raw.structShips;
  if (raw.modules !== undefined) DB.modules = raw.modules;
  if (raw.structModules !== undefined) DB.structModules = raw.structModules;
  if (raw.charges !== undefined) DB.charges = raw.charges;
  if (raw.drones !== undefined) DB.drones = raw.drones;
  if (raw.structures !== undefined) DB.structures = raw.structures;
  if (raw.deployables !== undefined) DB.deployables = raw.deployables;
  if (raw.index !== undefined) DB.index = raw.index;
  rebuildNameMap();
  return DB;
}

/* ------------------------------------------------------------------ 查询辅助 */

/** 汇总查询：按 ships → structShips → modules → structModules → charges → drones → structures → deployables 顺序取第一个命中。 */
export function get(typeId: unknown): TypeInfo | null {
  const id = Number(typeId);
  if (!Number.isFinite(id)) return null;
  return (
    DB.ships[id] ||
    DB.structShips[id] ||
    DB.modules[id] ||
    DB.structModules[id] ||
    DB.charges[id] ||
    DB.drones[id] ||
    DB.structures[id] ||
    DB.deployables[id] ||
    null
  );
}

/** 舰船（普通舰船） */
export const ship = (id: unknown): ShipData | null => DB.ships[Number(id)] || null;
/** 舰体（舰船或建筑） */
export const hull = (id: unknown): ShipData | null =>
  DB.ships[Number(id)] || DB.structShips[Number(id)] || null;
/** 建筑舰体 */
export const structure = (id: unknown): ShipData | null => DB.structShips[Number(id)] || null;
/** 建筑模块（或普通模块） */
export const module_ = (id: unknown): ModuleData | null =>
  DB.modules[Number(id)] || DB.structModules[Number(id)] || null;
/** 建筑模块（严格） */
export const structModule = (id: unknown): ModuleData | null =>
  DB.structModules[Number(id)] || null;
/** 弹药 */
export const charge = (id: unknown): ChargeData | null => DB.charges[Number(id)] || null;
/** 无人机 */
export const drone = (id: unknown): DroneData | null => DB.drones[Number(id)] || null;
/** 建筑信息（structures.json） */
export const structureInfo = (id: unknown): StructureData | null =>
  DB.structures[Number(id)] || null;
/** 可部署物 */
export const deployable = (id: unknown): DeployableData | null =>
  DB.deployables[Number(id)] || null;

/** 是否为建筑舰体 */
export const isStructure = (id: unknown): boolean => !!DB.structShips[Number(id)];
/** 是否为铁骑舰载机（cat 87）而非普通无人机（cat 18） */
export const isFighter = (id: unknown): boolean => (DB.drones[Number(id)] || {}).cat === 87;

/** 中文名；无则英文名；都没有返回 null。不抛异常。 */
export function zhName(typeId: unknown): string | null {
  const it = get(typeId);
  if (!it) return null;
  if (typeof it.zh === "string" && it.zh) return it.zh;
  if (typeof it.en === "string" && it.en) return it.en;
  return null;
}

/** 英文名；无则返回 null。不抛异常。 */
export function enName(typeId: unknown): string | null {
  const it = get(typeId);
  if (!it) return null;
  if (typeof it.en === "string" && it.en) return it.en;
  return null;
}

/** meta.json 内容（供 UI 展示数据来源 / 版本）。 */
export function meta(): MetaData | null {
  return DB.meta;
}

/** 条目所属分组信息。 */
export function groupOf(typeId: unknown): GroupData | null {
  const it = get(typeId);
  if (!it) return null;
  const groups = DB.groups && DB.groups.groups;
  if (!groups) return null;
  return groups[it.group] || null;
}

/** 按名称查找 typeID（中英文均可，大小写不敏感）。未命中返回 null。 */
export function findByName(name: unknown): number | null {
  if (name === null || name === undefined) return null;
  const key = String(name).toLowerCase().trim();
  if (!key) return null;
  const hit = nameMap.get(key);
  return hit === undefined ? null : hit;
}

const CJK_RE = /[\u3400-\u9fff]/;

/**
 * 名称模糊搜索，用于配置导入时的候选提示。
 *
 * 规则：查询串含中日韩字符 → 只匹配中文名；否则只匹配英文名（均大小写不敏感）。
 * 只对 index 线性扫描一次，命中即收，不做任何排序 —— 对 2.1MB 规模的 index 也足够快。
 */
export function searchName(query: unknown, limit = 40): NameHit[] {
  const raw = String(query ?? "");
  const q = raw.toLowerCase().trim();
  if (!q || limit <= 0) return [];
  const zhQuery = CJK_RE.test(raw);
  const out: NameHit[] = [];
  for (const entry of DB.index) {
    if (!entry || entry.length < 2) continue;
    const name = String(entry[0]);
    const isCjk = CJK_RE.test(name);
    if (zhQuery !== isCjk) continue;
    if (!name.toLowerCase().includes(q)) continue;
    const id = Number(entry[1]);
    const it = get(id);
    out.push({ id, name, zh: it ? it.zh : null, en: it ? it.en : null });
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ 列表 */

/** 按中文名排序的比较器。 */
const byZh = (a: TypeInfo, b: TypeInfo): number => String(a.zh).localeCompare(String(b.zh), "zh");

export interface GroupedList<T extends TypeInfo> {
  groupName: string;
  items: T[];
}

export interface SlotGroupedList<T extends TypeInfo> {
  slot: string;
  groupName: string;
  items: T[];
}

/** 列出所有可配置的舰船（按分组归类）。 */
export function listShips(): GroupedList<ShipData>[] {
  const byGroup = new Map<string, ShipData[]>();
  for (const id of Object.keys(DB.ships)) {
    const s = DB.ships[id];
    if (!s) continue;
    let arr = byGroup.get(s.groupName);
    if (!arr) byGroup.set(s.groupName, (arr = []));
    arr.push(s);
  }
  return [...byGroup.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), "zh"))
    .map(([groupName, items]) => ({ groupName, items: items.sort(byZh) }));
}

/** 列出所有可用装备（按槽位/分组归类）。 */
export function listModules(): SlotGroupedList<ModuleData>[] {
  return groupModules(DB.modules);
}

/** 建筑模块列表（按槽位/分组归类）。 */
export function listStructModules(): SlotGroupedList<ModuleData>[] {
  return groupModules(DB.structModules);
}

function groupModules(rec: Record<string, ModuleData>): SlotGroupedList<ModuleData>[] {
  const byGroup = new Map<string, { slot: string; groupName: string; items: ModuleData[] }>();
  for (const id of Object.keys(rec)) {
    const m = rec[id];
    if (!m) continue;
    const slot = m.slot || "other";
    const key = slot + "|" + m.groupName;
    let slotGroup = byGroup.get(key);
    if (!slotGroup) {
      slotGroup = { slot, groupName: m.groupName, items: [] };
      byGroup.set(key, slotGroup);
    }
    slotGroup.items.push(m);
  }
  return [...byGroup.values()].map((g) => ({ slot: g.slot, groupName: g.groupName, items: g.items.sort(byZh) }));
}

/** 无人机列表（按分组名 + 中文名排序）。 */
export function listDrones(): DroneData[] {
  return Object.values(DB.drones).sort(
    (a, b) => String(a.groupName).localeCompare(String(b.groupName), "zh") || byZh(a, b),
  );
}

/** 铁骑舰载机列表（按角色归类：轻型/重型/支援）。 */
export function listFighters(): GroupedList<DroneData>[] {
  const byRole = new Map<string, DroneData[]>();
  for (const d of Object.values(DB.drones)) {
    if (d.cat !== 87) continue;
    const a = d.a || {};
    const key =
      a.fighterSquadronIsLight
        ? "轻型铁骑"
        : a.fighterSquadronIsHeavy
          ? "重型铁骑"
          : a.fighterSquadronIsSupport
            ? "支援铁骑"
            : "其他铁骑";
    let arr = byRole.get(key);
    if (!arr) byRole.set(key, (arr = []));
    arr.push(d);
  }
  return [...byRole.entries()].map(([groupName, items]) => ({ groupName, items: items.sort(byZh) }));
}

/** 可装配的建筑列表（按分组归类）。 */
export function listStructures(): GroupedList<ShipData>[] {
  const byGroup = new Map<string, ShipData[]>();
  for (const s of Object.values(DB.structShips)) {
    let arr = byGroup.get(s.groupName);
    if (!arr) byGroup.set(s.groupName, (arr = []));
    arr.push(s);
  }
  return [...byGroup.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), "zh"))
    .map(([groupName, items]) => ({ groupName, items: items.sort(byZh) }));
}

/* ------------------------------------------------------------------ 弹药匹配 */

/** 取属性袋里的数值（无则 undefined）。 */
function numAttr(a: AttrBag | undefined, key: string): number | undefined {
  if (!a) return undefined;
  const v = a[key];
  return typeof v === "number" ? v : undefined;
}

/**
 * 为某个普通装备槽位挑选合适的弹药（依据 chargeGroup 匹配 + chargeSize 过滤）。
 * 模块或 cg 缺失时返回 []，不抛异常。
 */
export function chargesFor(moduleId: unknown): ChargeData[] {
  const m = DB.modules[Number(moduleId)];
  if (!m || !m.cg || !m.cg.length) return [];
  return matchCharges(m, true);
}

/**
 * 建筑模块的可用弹药（不按 chargeSize 过滤）。
 * 模块或 cg 缺失时返回 []，不抛异常。
 */
export function chargesForModule(moduleId: unknown): ChargeData[] {
  const m = module_(moduleId);
  if (!m || !m.cg || !m.cg.length) return [];
  return matchCharges(m, false);
}

function matchCharges(m: ModuleData, filterSize: boolean): ChargeData[] {
  const cg = m.cg;
  if (!cg || !cg.length) return [];
  const set = new Set(cg.map(Number));
  const out: ChargeData[] = [];
  for (const id of Object.keys(DB.charges)) {
    const c = DB.charges[id];
    if (!c) continue;
    if (!set.has(Number(c.group))) continue;
    if (filterSize) {
      const size = numAttr(c.a, "chargeSize");
      if (size !== undefined && m.cs !== undefined && Number(size) !== Number(m.cs)) continue;
    }
    out.push(c);
  }
  return out.sort(byZh);
}

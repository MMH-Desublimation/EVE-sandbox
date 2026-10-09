/**
 * 配装导入解析：PYFA 导出的 XML 与 EFT 剪贴板文本 → `FitEntry`。
 *
 * 说明：
 *  - 两种格式都是业界通行的「EFT/PYFA 配装」文本格式，PYFA 的「导出 → XML」与
 *    右键「复制」得到的剪贴板文本分别对应下面两个函数。
 *  - 名称统一经 SDE 解析成 typeId；解析不到的条目**不静默丢弃**，而是记进 `warnings`，
 *    由导入页原样展示给用户（宁可提示不可错算）。
 *  - 本模块只做「名字 → typeId → 配装」的结构化，不参与任何数值计算。
 *
 * 兼容性（实测踩到过的坑）：
 *  - 舰船节点可能是 `<ship type="..."/>`（PYFA）或 `<shipType value="..."/>`（EFT），两种都认。
 *  - 无人机/铁骑在部分导出里写作 `<drone bay .../>` / `<fighter bay .../>` ——
 *    元素名含空格，严格来说不是合法 XML，但在真实文件里广泛存在。
 *    这里先做一次标签名规整（`<drone bay` → `<dronebay`）再交给 DOMParser，
 *    否则整份文件会被判为"不是合法 XML"而全部丢掉。
 *  - 弹药/脚本/装料统一在 `<hardware slot="cargo" .../>` 里（不记录装到哪门炮上）：
 *    必须当成**货物**按 chargeGroup 归属，绝不能当成装备（详见 `fitRepair.ts`）。
 */
import * as sde from "../sde.ts";
import type { DroneSpec, FighterSpec, ModuleSpec } from "../../shared/protocol.ts";
import type { FitEntry, FitSource } from "./store.ts";
import { newId } from "./store.ts";
import { attachCargo, CARRY_ALL, isLogiModule } from "./fitRepair.ts";
import type { CargoItem } from "./fitRepair.ts";

export interface ParseResult {
  fits: FitEntry[];
  warnings: string[];
}

interface Ref {
  typeId: number;
  zh: string;
  kind: "ship" | "module" | "charge" | "drone" | "fighter" | "unknown";
}

/** 名称 / typeId → 类型化引用。 */
function resolveRef(raw: string | number | null | undefined): Ref | null {
  if (raw === null || raw === undefined) return null;
  let typeId: number | null = null;
  const asNum = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (typeof raw === "number" || (Number.isFinite(asNum) && String(raw).trim() !== "" && /^\d+$/.test(String(raw).trim()))) {
    typeId = asNum;
  } else {
    typeId = sde.findByName(raw);
  }
  if (typeId === null || !Number.isFinite(typeId)) return null;
  const zh = sde.zhName(typeId) ?? String(raw);
  if (sde.hull(typeId)) return { typeId, zh, kind: "ship" };
  if (sde.module_(typeId)) return { typeId, zh, kind: "module" };
  if (sde.charge(typeId)) return { typeId, zh, kind: "charge" };
  if (sde.drone(typeId)) return { typeId, zh, kind: sde.isFighter(typeId) ? "fighter" : "drone" };
  return { typeId, zh, kind: "unknown" };
}

/** XML/文本槽位名 → 引擎槽位（hi/med/lo/rig）。 */
function slotOf(raw: string | null | undefined): "hi" | "med" | "lo" | "rig" | undefined {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("hi")) return "hi";
  if (s.includes("med")) return "med";
  if (s.includes("lo")) return "lo";
  if (s.includes("rig")) return "rig";
  return undefined;
}

/**
 * 模块默认状态。
 *
 * ★ 一律 `online`（在线但不运转），**后勤除外**（`active`，保持自动运转）——
 *   这是用户的明确要求：「装备初始全部关闭，不要自动启用/自动开火；但后勤保持自动运转」。
 *
 *   · `online` 会保留装配带来的**被动**加成（附甲板、护盾扩展、损伤控制、散热槽…
 *     仍计入 EHP / 抗性），所以不会把舰船算成裸船；
 *   · 但 `online` **不会**自动触发任何"运转"语义（`assemble.ts` 里 `on = state === "active"`），
 *     因此不会自动开火、不会自动推进、不会出现跳刀空转这类问题；
 *   · 需要时由用户在沙盘中手动开启（`toggleModule → active`），届时再按 PYFA 真值生效。
 *
 * 历史背景：早期版本这里写死 `online`，导致主动模块加成完全不生效（凤凰级盾抗实测
 * online [0.70,0.56,0.42,0.35] vs active [0.339,0.271,0.203,0.170]）；中间一版为修它改成了
 * "一律 active"，副作用是**所有装备自动运转**。现在按用户决策收敛到上述规则。
 *
 * 若来源本身带 `state` 属性，则以来源为准（见 `stateOf`）。
 */
function defaultState(ref: Ref): ModuleSpec["state"] {
  return isLogiModule(ref.typeId) ? "active" : "online";
}

/** 读取来源里显式的 `state`（active/online/offline），没有则用默认值。 */
function stateOf(el: Element, ref: Ref): ModuleSpec["state"] {
  const raw = (el.getAttribute("state") ?? "").trim().toLowerCase();
  if (raw === "active" || raw === "online" || raw === "offline" || raw === "overload") {
    return raw;
  }
  return defaultState(ref);
}

/* ------------------------------------------------------------------ PYFA XML */

interface SlotBucket {
  module: ModuleSpec | null;
  charges: Ref[];
}

/**
 * 解析 PYFA / EFT 导出的 XML。
 *
 * 兼容写法：
 *  - `<fitting name="...">` 包在 `<fittings>` 里，或本身就是根节点；
 *  - 模块用 `<hardware slot="hi slot 0" type="..."/>` 或 `<module .../>`；
 *  - 弹药是**同一槽位的下一条 hardware**（EFT 约定），按「先模块后弹药」判定；
 *  - 无人机 / 铁骑用 `<drone bay .../>` 或 `<fighter bay .../>`（`qty`/`quantity` 记数量）。
 */
export function parsePyfaXml(xml: string, origin = "pyfa.xml"): ParseResult {
  const fits: FitEntry[] = [];
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(normalizeTags(xml), "application/xml");
  const perr = doc.getElementsByTagName("parsererror")[0];
  if (perr) {
    return { fits, warnings: [`XML 解析失败：${(perr.textContent ?? "文件格式不是合法 XML").slice(0, 200)}`] };
  }
  const nodes = doc.getElementsByTagName("fitting");
  const list = nodes.length > 0 ? Array.from(nodes) : [doc.documentElement];

  for (const node of list) {
    if (!node) continue;
    const name = node.getAttribute("name") || node.getAttribute("title") || "未命名配置";
    const shipRaw = shipNameOf(node);
    const ship = resolveRef(shipRaw);
    if (!ship || ship.kind !== "ship") {
      warnings.push(`「${name}」：无法识别舰船 ${shipRaw ?? "(缺失)"}`);
      continue;
    }

    const buckets = new Map<string, SlotBucket>();
    const drones: DroneSpec[] = [];
    const fighters: FighterSpec[] = [];
    const cargo: CargoItem[] = [];

    const hardware = [
      ...Array.from(node.getElementsByTagName("hardware")),
      ...Array.from(node.getElementsByTagName("module")),
    ];
    hardware.forEach((el, i) => {
      const typeAttr = el.getAttribute("type") ?? el.getAttribute("name");
      const slotAttr = el.getAttribute("slot") ?? "";
      const ref = resolveRef(typeAttr);
      if (!ref) {
        warnings.push(`「${name}」：无法识别装备 ${typeAttr ?? "(空)"}`);
        return;
      }
      // ★ 货物（PYFA/EFT 把弹药、脚本、装料统一放在 slot="cargo"）：
      //   绝不能当成"装在船上的装备"——那会产出没有槽位的模块条目，
      //   送进 PYFA 直接抛 `ValueError: Passed item is not a Module`，
      //   整份配装都算不出来（生成推演时一艘船都建不出来）。改走货物池统一归属。
      if (isCargoSlot(slotAttr)) {
        if (ref.kind === "charge") {
          cargo.push({ typeId: ref.typeId, name: ref.zh, qty: readQty(el) });
        } else if (ref.kind === "drone" || ref.kind === "fighter") {
          pushBay(ref, readQty(el), drones, fighters);
        } else if (ref.kind === "module") {
          warnings.push(`「${name}」：${ref.zh} 是在货物里的备件，未装配（已忽略）。`);
        } else {
          warnings.push(`「${name}」：货物中的 ${ref.zh} 无法归类，已忽略。`);
        }
        return;
      }
      if (ref.kind === "module") {
        const key = slotAttr || `${ref.typeId}#${i}`;
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = { module: null, charges: [] }));
        if (!b.module) {
          b.module = { slot: slotOf(slotAttr), typeId: ref.typeId, name: ref.zh, state: stateOf(el, ref) };
        } else {
          // 同一槽位出现第二个模块：另起一条（不覆盖）
          buckets.set(`${key}#${i}`, { module: { slot: slotOf(slotAttr), typeId: ref.typeId, name: ref.zh, state: stateOf(el, ref) }, charges: [] });
        }
      } else if (ref.kind === "charge") {
        const key = slotAttr || "";
        const owner = findChargeOwner(buckets, key, ref, i);
        owner.push(ref);
      } else if (ref.kind === "drone" || ref.kind === "fighter") {
        pushBay(ref, readQty(el), drones, fighters);
      } else if (ref.kind === "ship") {
        // 一个 fitting 里出现第二个 ship：忽略（以第一个为准）
      } else {
        warnings.push(`「${name}」：${ref.zh} 无法归类为装备或弹药`);
      }
    });

    // 独立的无人机 / 铁骑标签（`<drone ...>` 与规整后的 `<dronebay ...>` 都认）
    for (const tag of ["dronebay", "drone", "fighterbay", "fighter"]) {
      for (const el of Array.from(node.getElementsByTagName(tag))) {
        if (el.getAttribute("slot") === null && tag.includes("bay")) continue;
        const ref = resolveRef(el.getAttribute("type") ?? el.getAttribute("name"));
        if (!ref) continue;
        pushBay(ref, readQty(el), drones, fighters);
      }
    }

    fits.push(buildFit(name, ship, buckets, drones, fighters, cargo, "pyfa-xml", origin, warnings));
  }
  if (fits.length === 0 && warnings.length === 0) warnings.push("未在文件中找到 <fitting> 节点。");
  return { fits, warnings };
}

/** 该 slot 值是否表示"放在货舱里"（不占装配槽位）。 */
function isCargoSlot(slotAttr: string): boolean {
  return /cargo|货舱|货柜/i.test(slotAttr);
}

/**
 * 标签名规整：`<drone bay` / `<fighter bay` 里的空格不是合法 XML 元素名，
 * 但真实导出文件里大量存在；统一折叠成 `<dronebay` / `<fighterbay`。
 */
function normalizeTags(xml: string): string {
  return String(xml ?? "")
    .replace(/<\s*drone\s+bay\b/g, "<dronebay")
    .replace(/<\s*\/\s*drone\s+bay\s*>/g, "</dronebay>")
    .replace(/<\s*fighter\s+bay\b/g, "<fighterbay")
    .replace(/<\s*\/\s*fighter\s+bay\s*>/g, "</fighterbay>");
}

/** 舰船名：PYFA 用 `<ship type="..."/>`，EFT 用 `<shipType value="..."/>`。 */
function shipNameOf(node: Element): string | null {
  const ship = node.getElementsByTagName("ship")[0];
  if (ship) return ship.getAttribute("type") ?? ship.getAttribute("value");
  const shipType = node.getElementsByTagName("shipType")[0];
  if (shipType) return shipType.getAttribute("value") ?? shipType.getAttribute("type");
  return node.getAttribute("ship");
}

function readQty(el: Element): number {
  const raw = el.getAttribute("qty") ?? el.getAttribute("quantity") ?? el.getAttribute("count");
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function pushBay(ref: Ref, qty: number, drones: DroneSpec[], fighters: FighterSpec[]): void {
  if (ref.kind === "fighter") fighters.push({ typeId: ref.typeId, name: ref.zh, count: qty });
  else drones.push({ typeId: ref.typeId, name: ref.zh, count: qty });
}

/** 同槽位的弹药归到该槽位已出现的模块上；没有模块则新开一个只有弹药的桶。 */
function findChargeOwner(buckets: Map<string, SlotBucket>, key: string, ref: Ref, i: number): Ref[] {
  const b = buckets.get(key);
  if (b && b.module) return b.charges;
  if (b && !b.module) return b.charges;
  const fresh: SlotBucket = { module: null, charges: [] };
  buckets.set(key || `${ref.typeId}#${i}`, fresh);
  return fresh.charges;
}

function buildFit(
  name: string, ship: Ref, buckets: Map<string, SlotBucket>,
  drones: DroneSpec[], fighters: FighterSpec[], cargo: CargoItem[],
  source: FitSource, origin: string, warnings: string[],
): FitEntry {
  const modules: ModuleSpec[] = [];
  for (const b of buckets.values()) {
    if (!b.module) {
      // 只有弹药、没有模块的槽位：并入货物池统一归属，绝不产出"无槽位模块"
      // 该槽位没有记录携带量，按"装满相容空装备"处理（历史坑：写死 1 会只装一门炮）
      for (const c of b.charges) cargo.push({ typeId: c.typeId, name: c.zh, qty: CARRY_ALL });
      continue;
    }
    const m: ModuleSpec = { ...b.module };
    if (b.charges.length > 0) {
      m.chargeTypeId = b.charges[0].typeId;
      m.chargeName = b.charges[0].zh;
    }
    modules.push(m);
  }
  // 货物里的弹药 / 脚本 / 装料：按 chargeGroup 装到相容的空装备上（装不上只记提示）
  attachCargo(modules, cargo, name, warnings);
  return {
    id: newId("fit"),
    name,
    shipTypeId: ship.typeId,
    shipName: ship.zh,
    modules,
    drones,
    fighters,
    source,
    importedAt: Date.now(),
    origin,
    ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
  };
}

/* ------------------------------------------------------------------ EFT 剪贴板 */

const HEADER_RE = /^\[(.+?)(?:,\s*(.*))?\]\s*$/;

/**
 * 解析 EFT 风格的剪贴板文本（PYFA 右键「复制」得到的格式）。
 *
 * 形如：
 * ```
 * [Apocalypse Navy Issue, 我的配装]
 * Mega Beam Laser II, Standard L
 * Heat Sink II
 * [Empty High slot]
 * ...
 * Berserker II x5
 * ```
 * 支持一次粘贴多份（多个 `[舰船, 配置名]` 头）。
 */
export function parseClipboard(text: string, origin = "剪贴板"): ParseResult {
  const fits: FitEntry[] = [];
  const warnings: string[] = [];
  const lines = String(text ?? "").split(/\r?\n/);

  let ship: Ref | null = null;
  let name = "";
  let modules: ModuleSpec[] = [];
  const drones: DroneSpec[] = [];
  const fighters: FighterSpec[] = [];
  const lastModuleOfSlot = new Map<string, ModuleSpec>();

  const flush = (): void => {
    if (!ship) return;
    if (!name) name = ship.zh;
    fits.push({
      id: newId("fit"),
      name,
      shipTypeId: ship.typeId,
      shipName: ship.zh,
      modules,
      drones,
      fighters,
      source: "clipboard",
      importedAt: Date.now(),
      origin,
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    });
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const head = HEADER_RE.exec(line);
    if (head) {
      const headName = head[1].trim();
      if (/^empty\b/i.test(headName)) continue; // [Empty High slot]
      const ref = resolveRef(headName);
      if (ref && ref.kind === "ship") {
        flush();
        ship = ref;
        name = (head[2] ?? "").trim();
        modules = [];
        drones.length = 0;
        fighters.length = 0;
        lastModuleOfSlot.clear();
        continue;
      }
      warnings.push(`无法识别舰船：${headName}`);
      continue;
    }

    // 无人机 / 铁骑：`名称 x5` 或 `名称 x 5`
    const droneMatch = /^(.+?)\s+[x×]\s*(\d+)$/.exec(line);
    if (droneMatch) {
      const ref = resolveRef(droneMatch[1].trim());
      const qty = Number(droneMatch[2]);
      if (ref && (ref.kind === "drone" || ref.kind === "fighter")) {
        pushBay(ref, qty, drones, fighters);
        continue;
      }
    }

    // 模块[, 弹药]
    const [modPart, chargePart] = splitTop(line);
    const modRef = resolveRef(modPart);
    if (!modRef) {
      warnings.push(`无法识别装备：${modPart}`);
      continue;
    }
    if (modRef.kind === "charge") {
      // 上一行的模块吃这颗弹药
      const owner = modules[modules.length - 1];
      if (owner) {
        owner.chargeTypeId = modRef.typeId;
        owner.chargeName = modRef.zh;
      } else warnings.push(`弹药 ${modRef.zh} 没有对应模块`);
      continue;
    }
    if (modRef.kind === "drone" || modRef.kind === "fighter") {
      pushBay(modRef, 1, drones, fighters);
      continue;
    }
    if (modRef.kind !== "module") {
      warnings.push(`${modRef.zh} 无法归类为装备`);
      continue;
    }
    const mod: ModuleSpec = {
      slot: sde.module_(modRef.typeId)?.slot as ModuleSpec["slot"] ?? undefined,
      typeId: modRef.typeId,
      name: modRef.zh,
      state: defaultState(modRef),
    };
    if (chargePart) {
      const cRef = resolveRef(chargePart);
      if (cRef && cRef.kind === "charge") {
        mod.chargeTypeId = cRef.typeId;
        mod.chargeName = cRef.zh;
      } else if (cRef) {
        warnings.push(`无法识别弹药：${chargePart}`);
      }
    }
    modules.push(mod);
    if (mod.slot) lastModuleOfSlot.set(mod.slot, mod);
  }
  flush();
  if (fits.length === 0) warnings.push("未识别到任何配装（缺少 `[舰船, 配置名]` 头？）");
  return { fits, warnings };
}

/** 以第一个英文逗号切分（弹药名前可能不含逗号）。 */
function splitTop(line: string): [string, string | null] {
  const i = line.indexOf(",");
  if (i < 0) return [line.trim(), null];
  return [line.slice(0, i).trim(), line.slice(i + 1).trim() || null];
}

/** 自动判定格式：含 `<fitting` / `<?xml` 走 XML，否则走剪贴板。 */
export function parseAuto(text: string, origin = "粘贴"): ParseResult {
  if (/<\s*fittings?\b|<\?xml/i.test(text)) return parsePyfaXml(text, origin);
  return parseClipboard(text, origin);
}

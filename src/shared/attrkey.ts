/**
 * 属性缓存索引键（交接文档 §5.1）。
 *
 *   key = { fitFingerprint, stateBitmap, envKey }
 *
 * `stateBitmap` 是**核心设计**：属性表按"模块开关组合"索引，
 * 因此 siege / 抗性硬化 / 微曲等开关的效果**全部由 PYFA 在该状态下算出**，
 * 引擎不做任何叠加运算（见 docs/第4章 §4.5 D）。
 */
import type { AttrKey } from "./contract.ts";
import type { CommandLinkSpec, DroneSpec, FighterSpec, ImplantSpec, ModuleSpec } from "./protocol.ts";
import { fingerprint } from "./hash.ts";

/** 配装里除模块之外、会影响属性表的部分。 */
export interface FitExtras {
  drones?: DroneSpec[];
  /** ★ 铁骑必须进指纹：它改变属性表的 fighters 段（发射管数/型号）。 */
  fighters?: FighterSpec[];
}

/** 归一化配装内容 → 指纹（与输入顺序无关）。 */
export function fitFingerprint(
  shipTypeId: number, modules: ModuleSpec[], extras: FitExtras = {},
): string {
  const norm = modules
    .map((m) => `${m.typeId ?? m.name ?? ""}:${m.chargeTypeId ?? m.chargeName ?? ""}`)
    .slice()
    .sort();
  const drones = (extras.drones ?? [])
    .map((d) => `${d.typeId ?? d.name ?? ""}x${d.count ?? 1}`)
    .sort()
    .join(",");
  const fighters = (extras.fighters ?? [])
    .map((f) => `${f.typeId ?? f.name ?? ""}x${f.count ?? 1}`)
    .sort()
    .join(",");
  return fingerprint(`${shipTypeId}|${norm.join(",")}|d[${drones}]|f[${fighters}]`);
}

/**
 * 环境键：**脑插 + 指挥脉冲**。
 *
 * ★ 这是必须进缓存键的一环：同一套配装"有脑插"与"没脑插"算出来的属性完全不同
 *   （实测高级极乐全套 +53.6% 护盾），若不进键就会把两套结果互相串用。
 * 空配置 → `""`，也就是"没有加成"。
 */
export function envKeyOf(
  implants: ImplantSpec[] = [], commandLinks: CommandLinkSpec[] = [],
): string {
  const imp = implants
    .map((i) => `${i.typeId ?? i.name ?? ""}@${i.slot ?? "auto"}`)
    .sort()
    .join(",");
  const lnk = commandLinks
    .map((l) => `${l.linkType}:${l.strength}:${l.mindlink ? 1 : 0}`)
    .sort()
    .join(",");
  if (!imp && !lnk) return "";
  return fingerprint(`i[${imp}]|l[${lnk}]`);
}

/** 可开关模块的开/关组合编码（按给定顺序，offline/online/active/overload → 0..3）。 */
export function stateBitmap(modules: ModuleSpec[]): string {
  const code: Record<string, number> = { offline: 0, online: 1, active: 2, overload: 3 };
  let out = "";
  for (const m of modules) out += String(code[m.state ?? "online"] ?? 1);
  return out;
}

export function makeAttrKey(
  shipTypeId: number, modules: ModuleSpec[], envKey = "", extras: FitExtras = {},
): AttrKey {
  return {
    fitFingerprint: fitFingerprint(shipTypeId, modules, extras),
    stateBitmap: stateBitmap(modules),
    envKey,
  };
}

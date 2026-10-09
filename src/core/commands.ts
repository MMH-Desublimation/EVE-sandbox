/**
 * 命令系统（交接文档 §7.5、§7.6）。
 *
 * 铁律：**所有用户操作都是可序列化的命令对象**，UI 不直接改引擎状态。
 * 收益：存档 = 初始 fits + 命令列表 + 种子；回溯 = 从关键帧重放命令；
 *       撤销 = 删掉最后一条命令；重算范围 = 从命令生效 tick 开始。
 */
import type { FitStats } from "../shared/contract.ts";
import { stateBitmap } from "../shared/attrkey.ts";
import { applyStats, assembleUnit } from "./assemble.ts";
import { blobFormation, FORMATION_SPACING } from "./formation.ts";
import { jumpAllowed, warpAllowed } from "./jump.ts";
import { vec } from "./geometry.ts";
import type {
  BattleEvent, BattleState, Doctrine, ModuleState, Order, ReserveEntry, Unit, UnitBlueprint, Vec2,
} from "./state.ts";

export interface CommandTarget {
  sideId?: number;
  fleetId?: number;
  wingId?: number;
  squadId?: number;
  unitId?: string;
  /** 任选集合（地图框选后下发，UI 层最常用）。 */
  unitIds?: string[];
}

export type CommandAction =
  | "setDoctrine"
  | "setOrder"
  | "setTarget"
  | "toggleModule"
  | "toggleWeapon"
  | "setCharge"
  | "stop"
  | "warpOut"
  /** 增援入场：星门派遣（gate，需过门延迟）或旗舰跳直达（jump，瞬到）。 */
  | "reinforce"
  /** 旗舰跳撤场：**仅在允许旗舰跳时生效**（未被反跳、冷却已过、有跳跃引擎）。 */
  | "jumpOut"
  /**
   * **跃迁至**（普通跃迁）：目标距离 > 150 km 且"允许跃迁"时生效。
   * 参数：`to`（坐标）或 `targetId`（跟随该目标），`range`（落地后距目标的米数）。
   */
  | "warpTo";

export interface Command {
  /** 生效 tick（整数）。 */
  tick: number;
  target: CommandTarget;
  action: CommandAction;
  params: Record<string, unknown>;
}

/** 按 target 选择受影响的单位（势力/舰队/联队/中队/单位 五级）。 */
export function selectUnits(state: BattleState, t: CommandTarget): Unit[] {
  if (t.unitId) {
    const u = state.units.find((x) => x.id === t.unitId);
    return u ? [u] : [];
  }
  if (t.unitIds && t.unitIds.length > 0) {
    const want = new Set(t.unitIds);
    return state.units.filter((u) => want.has(u.id));
  }
  return state.units.filter((u) => {
    if (t.sideId !== undefined && u.sideId !== t.sideId) return false;
    if (t.fleetId !== undefined && u.fleetId !== t.fleetId) return false;
    if (t.wingId !== undefined && u.wingId !== t.wingId) return false;
    if (t.squadId !== undefined && u.squadId !== t.squadId) return false;
    return true;
  });
}

export interface CommandDeps {
  /**
   * 按单位当前的 moduleStates 重新解析属性表（**同步**）。
   * 由驱动器在运行前预热；缺失即抛错（保证确定性，绝不静默降级）。
   */
  resolve: (unit: Unit) => FitStats;
  /** 取一名待召增援（配装 + 已预热属性表）。 */
  reserve?: (unitId: string) => ReserveEntry | undefined;
  /** 全部待召增援的 id（**按 id 升序**，保证入场顺序确定）。 */
  reserveIds?: () => string[];
}

/** 把单位当前的 moduleStates 写回配装规格（构造下一次属性查询的输入）。 */
export function modulesWithStates(state: BattleState, u: Unit) {
  const bp = state.blueprints[u.id];
  if (!bp) return [];
  return bp.modules.map((m, i) => ({ ...m, state: u.moduleStates[i] ?? m.state ?? "online" }));
}

/** 重新计算并应用属性（状态变化后必须调用）。 */
export function refreshStats(state: BattleState, u: Unit, deps: CommandDeps): void {
  const modules = modulesWithStates(state, u);
  u.stateBitmap = stateBitmap(modules);
  applyStats(u, deps.resolve(u));
}

/**
 * 应用一条命令。返回一句可读的生效说明（写入 commandLog，供 UI 显示生效 tick，D-37）。
 */
export function applyCommand(state: BattleState, cmd: Command, deps: CommandDeps): string {
  // 「增援」不作用在既有单位上（它是把**场外的预备单位投入战场**），因此先单独处理
  if (cmd.action === "reinforce") return applyReinforce(state, cmd, deps);

  const units = selectUnits(state, cmd.target).filter((u) => u.alive && !u.evacuated);
  const p = cmd.params;
  let note = "";

  for (const u of units) {
    switch (cmd.action) {
      case "setDoctrine": {
        u.doctrine = String(p.doctrine ?? "focus") as Doctrine;
        note = `交火方式 → ${u.doctrine}（${units.length} 单位）`;
        break;
      }
      case "setOrder": {
        const type = String(p.type ?? "hold") as Order["type"];
        const order: Order = { type };
        if (p.targetId !== undefined) order.targetId = p.targetId === null ? null : String(p.targetId);
        if (p.range !== undefined) order.range = Number(p.range);
        // ★ 坐标类指令（"移动到此处" / "旗舰跳到此处"）必须带上落点，
        //   否则 approach / jump 会因为拿不到目标点而原地不动。
        if (p.to !== undefined) order.to = p.to === null ? null : (p.to as Vec2);
        u.order = order;
        note = `机动 → ${type}（${units.length} 单位）`;
        break;
      }
      case "stop": {
        // ★ "停止" = 只停机动，火力不停（交接文档 §8.4）
        u.order = { type: "stop" };
        u.vel = { x: 0, y: 0 };
        note = `停止机动（火力继续）（${units.length} 单位）`;
        break;
      }
      case "warpOut": {
        u.order = { type: "warpOut" };
        u.warpRemainingMs = 0;
        note = `撤离起跳（${units.length} 单位）`;
        break;
      }
      case "warpTo": {
        // ★ 普通跃迁「跃迁至」：**目标距离 > 150 km** 且**允许跃迁**时才生效。
        //   许可判定与旗舰跳同源：拦截力场直接禁止；扰频/扰断按"跃迁稳定系数"扣点。
        const to = (p.to as Vec2 | undefined) ?? null;
        const targetId = p.targetId === undefined || p.targetId === null ? null : String(p.targetId);
        const range = Math.max(0, Number(p.range ?? 0));
        const verdict = warpAllowed(state, u);
        if (!verdict.ok) {
          note = `跃迁被拒：${verdict.reason}（${units.length} 单位）`;
          break;
        }
        const anchor = targetId
          ? (state.units.find((x) => x.id === targetId)?.pos ?? to)
          : to;
        if (!anchor) {
          note = "跃迁失败：没有可用的目标点";
          break;
        }
        const dist = vec.dist(u.pos, anchor);
        if (dist <= 150_000) {
          note = `跃迁被拒：距离仅 ${(dist / 1000).toFixed(0)} km（≤150 km，用机动指令即可）`;
          break;
        }
        u.order = {
          type: "warp",
          ...(targetId ? { targetId } : {}),
          ...(to ? { to } : {}),
          range,
        };
        u.warpRemainingMs = 0;
        u.warpingOut = false;
        u.warpDest = null;
        u.locked = false;
        note = `跃迁至（落地距目标 ${(range / 1000).toFixed(0)} km）（${units.length} 单位）`;
        break;
      }
      case "jumpOut": {
        // 旗舰跳撤场：**只有"允许旗舰跳"时才生效**
        // （有跳跃引擎、未被反跳、冷却已过、场景允许）—— 这就是"判定允许进行旗舰跳情况下"
        const verdict = jumpAllowed(state, u);
        if (!verdict.ok) {
          note = `旗舰跳撤场被拒：${verdict.reason}`;
          break;
        }
        u.evacuated = true;
        u.warpingOut = false;
        u.warpRemainingMs = 0;
        u.locked = false;
        u.targetId = null;
        u.order = { type: "hold" };
        if (u.jump) u.jump.remainingMs = state.settings.jumpCooldownMs;
        pushEvent(state, {
          tick: state.tick, type: "jump", sideId: u.sideId,
          unitId: u.id, unitName: u.name, shipName: u.shipName, detail: "旗舰跳撤场",
        });
        note = `旗舰跳撤场（${units.length} 单位）`;
        break;
      }
      case "setTarget": {
        u.targetId = p.targetId === null ? null : String(p.targetId);
        // ★ 支持锁定"组"：铁骑纵队 / 无人机组（用户要求它们可被独立选中作为目标）
        const kind = (p.kind ?? "unit") as TargetKind;
        u.targetKind = p.targetId === null ? "unit" : kind;
        u.targetGroupId = p.targetId === null ? null : (p.groupId ? String(p.groupId) : null);
        u.locked = false;
        u.lockProgressMs = 0;
        note = u.targetGroupId
          ? `主目标 → ${u.targetGroupId}（${u.targetKind === "fighter" ? "铁骑" : "无人机"}）`
            + `（${units.length} 单位）`
          : `主目标 → ${u.targetId ?? "无"}（${units.length} 单位）`;
        break;
      }
      case "toggleModule": {
        const idx = resolveModuleIndex(state, u, p);
        if (idx < 0) break;
        const want = String(p.state ?? "online") as ModuleState;
        // ★ "本轮循环走完才停用"：目标是停用、且该实例此刻正在运转（on）时，
        //   不立刻改 moduleStates（否则增益/效果瞬间消失，也与 UI 的"停用中（淡红）"不符），
        //   只打 pendingOff；由 sim 的 phaseModuleCycles 在本轮循环结束时正式落地。
        const ai = u.activeInputIndex.indexOf(idx);
        if (want !== "active" && ai >= 0 && u.actives[ai]?.on) {
          u.actives[ai].pendingOff = true;
          note = `模块#${idx} → 停用中（本轮走完）（${units.length} 单位）`;
          break;
        }
        // ★ 跳刀：冷却未结束时**不允许**再次启用（用户明确要求：
        //   "起跳后装备进入冷却时间，需要冷却结束才能再次启用"）。
        const mjIdx = u.activeInputIndex.indexOf(idx);
        const mjd = mjIdx >= 0 ? u.actives[mjIdx] : undefined;
        if (want === "active" && mjd && mjd.kind === "microJump" && mjd.cooldownRemainingMs > 0) {
          note = `模块#${idx} 启用被拒：跳刀冷却中（剩 ${Math.ceil(mjd.cooldownRemainingMs / 1000)} s）`;
          break;
        }
        u.moduleStates[idx] = want;
        refreshStats(state, u, deps);
        // ★ 跳刀启用后立刻开始"运转倒计时"：跑完本轮才起跳（见 sim.phaseMicroJump）。
        //   refreshStats 会重建 actives 并把计时归零，所以这里显式起步。
        const mjAfter = mjIdx >= 0 ? u.actives[mjIdx] : undefined;
        if (want === "active" && mjAfter && mjAfter.kind === "microJump" && mjAfter.cooldownRemainingMs <= 0) {
          mjAfter.cycleRemainingMs = mjAfter.cycleMs;
        }
        note = `模块#${idx} → ${u.moduleStates[idx]}（${units.length} 单位）`;
        break;
      }
      case "toggleWeapon": {
        const typeId = Number(p.typeId ?? 0);
        const on = p.on === undefined ? true : Boolean(p.on);
        // ★ V0.9：武器"开火/停火" = **炮位模块的 state**（active/online），并重新解析属性。
        //
        //   为什么不能只改 `w.on`：
        //     · PYFA 的武器行只在模块 state=active 时才给出伤害 —— 实测同一门 1400mm II，
        //       online → dps=0.0，active → dps=463.9。只改 `w.on` 会让界面显示"开火"，
        //       但实际伤害为 0（数值完全错）；
        //     · `applyStats` 重建武器实例时按行状态给 `on`，所以任何一次属性重算
        //       （模块开关、进出脉冲范围…）都会把只写在实例上的开关抹掉 —— 表现为
        //       "点了开火，过一会又变停火"。写进 moduleStates 则天然跨重算保留。
        const bp = state.blueprints[u.id];
        const want: ModuleState = on ? "active" : "online";
        let n = 0;
        if (bp) {
          for (let i = 0; i < bp.modules.length; i++) {
            if (bp.modules[i].typeId !== typeId) continue;
            if (u.moduleStates[i] === "offline") continue;   // 用户手工置离线的炮位不动
            u.moduleStates[i] = want;
            n++;
          }
        }
        if (n > 0) refreshStats(state, u, deps);
        note = `武器 ${typeId} → ${on ? "开火" : "停火"}（${units.length} 单位，各 ${n} 门）`;
        break;
      }
      case "setCharge": {
        // 换弹药会改变射程/射速/伤害 → 必须重算属性（走 PYFA，不自行叠加）
        const bp = state.blueprints[u.id];
        if (!bp) break;
        let moduleIndex = resolveModuleIndex(state, u, p);
        if (moduleIndex < 0) moduleIndex = findWeaponModuleIndex(state, u, Number(p.typeId ?? 0));
        if (moduleIndex < 0) break;
        bp.modules[moduleIndex] = {
          ...bp.modules[moduleIndex],
          chargeTypeId: Number(p.chargeTypeId ?? 0),
        };
        refreshStats(state, u, deps);
        note = `换弹药 → ${p.chargeTypeId}（${units.length} 单位）`;
        break;
      }
      default:
        note = `未知 action: ${cmd.action}`;
    }
  }

  state.commandLog.push({
    tick: cmd.tick, action: cmd.action, target: JSON.stringify(cmd.target), note,
  });
  return note;
}

/** 事件入队（与 sim.ts 的 pushEvent 同语义：超过上限丢最旧的一批）。 */
function pushEvent(state: BattleState, ev: BattleEvent): void {
  state.events.push(ev);
  if (state.events.length > state.maxEvents) {
    state.events.splice(0, state.events.length - state.maxEvents);
  }
}

/**
 * 增援入场（星门派遣 / 旗舰跳直达）。
 *
 * · **星门（gate）**：先在己方星门落地，过门延迟结束后再向目标机动；
 * · **旗舰跳（jump）**：直接瞬到目标点，并计入旗舰跳冷却。
 *
 * 入场坐标用密集**圆形**阵列（用户的规则：任何入场都是密集圆阵，不是方阵）。
 * 顺序：预备单位 id 升序 → 入场顺序确定 → 重放与快照等价。
 */
function applyReinforce(state: BattleState, cmd: Command, deps: CommandDeps): string {
  const p = cmd.params;
  const mode: "gate" | "jump" = String(p.mode ?? "jump") === "gate" ? "gate" : "jump";

  // 势力：优先用指令显式指定的，否则沿用被选中单位的势力
  let sideId = cmd.target.sideId !== undefined ? Number(cmd.target.sideId) : undefined;
  if (sideId === undefined) {
    const anchor = selectUnits(state, cmd.target)[0] ?? state.units[0];
    sideId = anchor ? anchor.sideId : undefined;
  }
  if (sideId === undefined) return "增援失败：无法判定势力";

  // 运行时生成（右键对话框带入的 fit）：worker 已在命令接收时算好属性并附在 params 上
  const runtime = (p.blueprint && p.stats)
    ? { bp: p.blueprint as UnitBlueprint, stats: p.stats as FitStats }
    : null;

  const to = (p.to as Vec2 | undefined) ?? null;
  // 星门：优先"本方星门"，其次中立星门，最后退而求其次用任意星门。
  // （原先只认 本方/中立，一旦该势力没有星门就落到 (0,0) —— 离战场十万八千里，
  //   用户会以为"增援没出来"。）
  const gates = state.celestials.filter((c) => c.kind === "stargate");
  const gate = gates.find((c) => c.sideId === sideId)
    ?? gates.find((c) => c.sideId === null)
    ?? gates[0];
  // 兜底落点：本方在场的舰队形心（可见），而不是 (0,0)
  const own = state.units.filter((u) => u.sideId === sideId && !u.evacuated);
  const home: Vec2 = own.length > 0
    ? {
      x: own.reduce((s, u) => s + u.pos.x, 0) / own.length,
      y: own.reduce((s, u) => s + u.pos.y, 0) / own.length,
    }
    : { x: 0, y: 0 };
  const fallback: Vec2 = gate ? { ...gate.pos } : home;
  const dropAt: Vec2 = mode === "gate" ? fallback : (to ?? fallback);

  // 汇总待生成单位：运行时生成 或 既有预备单位
  // ★ 单次增援上限 256 个单位（用户要求）；超出部分截断。
  const MAX_REINFORCE = 256;
  const specs: Array<{ bp: UnitBlueprint; stats: FitStats }> = [];
  if (runtime) {
    const n = Math.min(MAX_REINFORCE, Math.max(1, Number(p.count ?? 1)));
    for (let i = 0; i < n; i++) specs.push(runtime);
  } else {
    const requested = p.unitIds as string[] | undefined;
    const allIds = [...(requested ?? deps.reserveIds?.() ?? [])].sort();
    // 只投入"该势力 + 尚未入场"的预备单位
    const ids = allIds.filter((id) => {
      const entry = deps.reserve?.(id);
      return !!entry && entry.bp.sideId === sideId && state.unitIndex[id] === undefined;
    }).slice(0, MAX_REINFORCE);
    if (ids.length === 0) return "增援失败：该势力没有可用的预备单位（或已全部投入）";
    for (const id of ids) specs.push(deps.reserve!(id)!);
  }

  // ★ 增援**永远新开一个舰队**，绝不并入原有舰队（用户要求）：
  //   取该势力当前最大舰队号 + 1。重放时单位与命令顺序一致 → 舰队号确定。
  let maxFleet = -1;
  for (const u of state.units) {
    if (u.sideId === sideId && u.fleetId > maxFleet) maxFleet = u.fleetId;
  }
  const fleetId = maxFleet + 1;

  const positions = blobFormation(specs.length, FORMATION_SPACING, dropAt, sideId === 1 ? Math.PI : 0);
  const spawned: Unit[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    // 运行时生成需分配确定性 unitId（命令里带 spawnId 基础，重放等价）；
    // UnitBlueprint 以 unitId 标识，预留单位则沿用其 unitId。
    const bp: UnitBlueprint = runtime
      ? { ...spec.bp, unitId: `${String(p.spawnId ?? `spawn-S${sideId}`)}-${i}`, sideId, fleetId, wingId: 0, squadId: 0 }
      : { ...spec.bp, sideId, fleetId, wingId: 0, squadId: 0 };
    const u = assembleUnit(bp, spec.stats);
    u.pos = { x: positions[i].x, y: positions[i].y };
    u.vel = { x: 0, y: 0 };
    // 组随母舰一起入场（出仓点 = 母舰落点），此后由 groupMovement 自行机动
    for (const g of [...u.fighters, ...u.drones]) {
      g.pos = { x: u.pos.x, y: u.pos.y };
      g.vel = { x: 0, y: 0 };
    }
    if (mode === "gate") {
      // 过门延迟：落地后先静默一段时间，再执行机动。
      // ★ V0.8：过门之后是**跃迁过去**（对齐 + 按 AU/s 跃迁速度旅行），
      //   而不是"以平速慢慢跑过实际 AU 距离"（用户明确要求）。
      u.arrivalDelayMs = state.settings.gateArrivalDelayMs;
      u.order = { type: "hold" };
      u.pendingOrder = to ? { type: "warp", to, range: 0 } : { type: "hold" };
    } else {
      // 旗舰跳直达：瞬到目标点，并吃一次旗舰跳冷却
      if (u.jump) u.jump.remainingMs = state.settings.jumpCooldownMs;
      u.order = to ? { type: "approach", to } : { type: "hold" };
    }
    state.units.push(u);
    state.blueprints[u.id] = bp;
    state.unitIndex[u.id] = state.units.length - 1;
    spawned.push(u);
    pushEvent(state, {
      tick: state.tick,
      type: mode === "gate" ? "reinforce" : "jump",
      sideId: u.sideId, unitId: u.id, unitName: u.name, shipName: u.shipName,
      detail: mode === "gate" ? `星门增援（${gate?.name ?? "场外"}）` : "旗舰跳增援",
    });
  }
  return mode === "gate"
    ? `星门增援 ${spawned.length} 单位 → ${gate?.name ?? "场外"}`
    : `旗舰跳增援 ${spawned.length} 单位 → (${Math.round(dropAt.x)}, ${Math.round(dropAt.y)})`;
}

/**
 * 把"kind + 实例序号"（UI 的 ①/② 标号）解析为配装模块下标。
 * ★ 上一版 C1 根因：只按 kind 判定，导致同 kind 多实例互相挤掉。
 */
export function resolveModuleIndex(state: BattleState, u: Unit, p: Record<string, unknown>): number {
  if (p.moduleIndex !== undefined) return Number(p.moduleIndex);
  if (p.kind === undefined) return -1;
  const kind = String(p.kind);
  const instanceIndex = Number(p.instanceIndex ?? 0);
  let seen = 0;
  for (let i = 0; i < u.actives.length; i++) {
    if (u.actives[i].kind !== kind) continue;
    if (seen === instanceIndex) return u.activeInputIndex[i] ?? -1;
    seen++;
  }
  return -1;
}

function findWeaponModuleIndex(state: BattleState, u: Unit, typeId: number): number {
  const bp = state.blueprints[u.id];
  if (!bp) return -1;
  return bp.modules.findIndex((m) => m.typeId === typeId);
}

/** 按 tick 归组命令（稳定排序，保证重放顺序确定）。 */
export function groupByTick(commands: Command[]): Map<number, Command[]> {
  const map = new Map<number, Command[]>();
  const sorted = commands.slice().sort((a, b) => a.tick - b.tick);
  for (const c of sorted) {
    const list = map.get(c.tick);
    if (list) list.push(c);
    else map.set(c.tick, [c]);
  }
  return map;
}

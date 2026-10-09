/**
 * 驱动器：把 StatOracle（异步）与引擎（同步 tick 循环）缝合起来。
 *
 * 设计要点：
 *  - 引擎的 `step()` 是**纯同步**的（确定性 + 可快照）。属性查询是异步的，
 *    因此**所有需要的属性组合在开跑前一次性预热**（见 #prewarm），
 *    运行期只做同步查表；缺失即抛错（绝不静默降级 —— 宁可失败也不给出错数）。
 *  - 属性组合 = (配装指纹, 状态位图, 环境键)，见契约 §5.1。
 */
import type { FitStats } from "../shared/contract.ts";
import { envKeyOf, makeAttrKey, stateBitmap } from "../shared/attrkey.ts";
import type {
  CommandLinkSpec, DroneSpec, EnvSpec, FighterSpec, ImplantSpec, ModuleSpec,
} from "../shared/protocol.ts";
import type { CommandBurstSource, LinkSourceState } from "./commandLink.ts";
import { effectiveLinks, enumerateCombos, sourceStateOf } from "./commandLink.ts";
import type { AttrCache } from "../stats/cache.ts";
import type { StatOracleClient } from "../stats/oracle/client.ts";
import { applyStats, assembleUnit } from "./assemble.ts";
import type { Command, CommandDeps } from "./commands.ts";
import { applyCommand, groupByTick, modulesWithStates, resolveModuleIndex } from "./commands.ts";
import type { SimContext } from "./sim.ts";
import { DEFAULT_PHASE_ORDER, runTicks, step } from "./sim.ts";
import type {
  BattleState, Celestial, EngineSettings, ReserveEntry, RunMode, SideId, Unit, UnitBlueprint,
} from "./state.ts";
import { DEFAULT_ENGINE_SETTINGS, emptyState } from "./state.ts";
import { KeyframeStore } from "./timeline.ts";

export interface BattleConfig {
  seed: number;
  mode: RunMode;
  blueprints: UnitBlueprint[];
  settings?: Partial<EngineSettings>;
  phaseOrder?: readonly string[];
  /** 关键帧基础间隔（tick）。 */
  keyframeBase?: number;
  /** 地物（星门 / 空间站）。 */
  celestials?: Celestial[];
  /**
   * 脑插（技能植入体）。
   * ★ 用户的规则：配置里**有**才算、**没有**就不算 —— 这里不填 = 全程不吃脑插加成。
   */
  implants?: ImplantSpec[];
  /**
   * 环境加成（指挥脉冲）——**按势力**给。
   * 实战中常堆到极限（满级技能 + 指挥舰船体加成 + 指挥脉冲脑插），
   * 这些都被 PYFA 折算进 `getLinkMultiplier(strength, mindlink)`。
   */
  envBySide?: Partial<Record<SideId, EnvSpec>>;
  /**
   * 指挥脉冲源：由某艘指挥舰开启的一路脉冲。
   *
   * 受益条件（用户规则）= **同舰队** + 在射程内 + 源可用
   * （若绑定了模块下标，还需该模块处于 active = "开启了脉冲波"）；
   * 同种脉冲多源时**取加成最高者**，并按其自身射程确定覆盖范围。
   */
  commandBurstSources?: CommandBurstSource[];
  /**
   * 增援编成（场外待召单位）。
   *
   * 它们的属性在**开跑前一次性预热**，因此运行中下达的 `reinforce` 指令是
   * 纯同步的 —— 引擎的 step() 仍然确定性、可快照、可重放。
   */
  reserves?: UnitBlueprint[];
}

/** 解析属性表时，除 (舰船, 模块) 之外还要一起进缓存键的东西。 */
export interface ResolveExtras {
  drones?: DroneSpec[];
  fighters?: FighterSpec[];
  /** 脑插：**有才算，没有就不算**。 */
  implants?: ImplantSpec[];
  /** 环境加成（指挥脉冲）。 */
  env?: EnvSpec;
}

/**
 * 解析一份属性表，走属性缓存。
 *
 * ★ 缓存键必须包含 (脑插, 指挥脉冲, 铁骑)：它们都会改变属性表，
 *   漏掉任何一个都会让"有加成"与"没加成"的结果互相串用。
 */
export async function resolveStats(
  client: StatOracleClient, cache: AttrCache, shipTypeId: number, modules: ModuleSpec[],
  extras: ResolveExtras = {},
): Promise<FitStats> {
  const key = makeAttrKey(
    shipTypeId, modules,
    envKeyOf(extras.implants, extras.env?.commandLinks),
    { drones: extras.drones, fighters: extras.fighters },
  );
  return await cache.getOrCompute(key, () =>
    client.calcFit({
      ship: { typeId: shipTypeId },
      modules,
      ...(extras.drones && extras.drones.length ? { drones: extras.drones } : {}),
      ...(extras.fighters && extras.fighters.length ? { fighters: extras.fighters } : {}),
      ...(extras.implants && extras.implants.length ? { implants: extras.implants } : {}),
      ...(extras.env && (extras.env.commandLinks?.length ?? 0) > 0 ? { env: extras.env } : {}),
    }));
}

/** 环境配置（脑插 + 按势力声明的指挥脉冲 + 指挥脉冲源），用于构造属性查询的 extras。 */
interface EnvConfig {
  implants?: ImplantSpec[];
  envBySide?: Partial<Record<SideId, EnvSpec>>;
}

/**
 * 属性表缓存的键：**必须带上 envKey**（脉冲按位置生效，同一单位可能有多套属性）。
 *
 * ★ V0.7 性能修复：键里不再放 unitId，改放「配装签名」（船型 + 模块型号 + 装料）。
 *   属性只取决于这些**内容**，与"这条船叫什么"无关 —— 200 条同配装的船共享同一份
 *   预热结果。旧实现按单位各存一份，批量操作（全舰队开关装备）会把
 *   (单位数 × 状态位图 × 脉冲组合) 直接乘成几十万次解析 → 界面整体卡死。
 */
function statsKey(fitSig: string, bitmap: string, envKey: string): string {
  return `${fitSig}|${bitmap}|${envKey}`;
}

/** 配装签名：决定属性的内容（船型 + 模块型号/装料；**不含**开关状态 —— 那在 bitmap 里）。 */
function fitSigOf(bp: UnitBlueprint): string {
  return `${bp.shipTypeId}|${bp.modules.map((m) => `${m.typeId}.${m.chargeTypeId ?? 0}`).join(",")}`;
}

/**
 * 合并"场景显式声明的环境"与"由指挥脉冲源算出的集合"。
 * 两者叠加（一般只会用其中一种）。
 */
function mergeLinks(env: EnvConfig, bp: UnitBlueprint, computed: CommandLinkSpec[]): CommandLinkSpec[] {
  const declared = env.envBySide?.[bp.sideId]?.commandLinks ?? [];
  return [...declared, ...computed];
}

/** 某个配装解析属性时要带的 extras。 */
function extrasFor(
  env: EnvConfig, bp: UnitBlueprint, links: CommandLinkSpec[],
): ResolveExtras {
  return {
    drones: bp.drones,
    fighters: bp.fighters,
    implants: env.implants,
    env: links.length > 0 ? { commandLinks: links } : undefined,
  };
}

/** 未预热组合的补算输入（见 `Battle.missing`）。 */
export interface WarmMiss {
  /** 属性缓存键 `sig|bitmap|envKey`。 */
  key: string;
  shipTypeId: number;
  /** 该组合下的模块清单（含装料与 state），可直接送 PYFA。 */
  modules: ModuleSpec[];
  /** 脑插 + 该组合对应的脉冲集合。 */
  extras: ReturnType<typeof extrasFor>;
}

export class Battle {
  readonly state: BattleState;
  readonly keyframes: KeyframeStore;
  #stats = new Map<string, FitStats>();
  #deps: CommandDeps;
  #reserves = new Map<string, ReserveEntry>();
  #env: EnvConfig;
  #sources: CommandBurstSource[];
  /**
   * 运行期出现的**未预热组合**（自愈用）。
   *
   * ★ 为什么不再"查不到就抛错"：预热是对"运行期会查哪些组合"的**预测**
   *   （配装 × 模块状态位图 × 环境键）。而这个预测依赖一些**运行期才确定**的东西
   *   （例如 `kind + 实例序号` 要按当时的 actives 解析、指挥脉冲源被开启后才会
   *   进入覆盖集合）。只要预测漏掉一个组合，旧实现就会在推演中途抛错，
   *   而推演抛错会让 worker 的帧循环停摆 —— 用户看到的就是"点一下整个界面卡死"。
   *
   *   现在改为：缺口**记录下来**（含补算所需的全部信息），本次用单位现有属性表占位
   *   继续跑完；驱动器拿 PYFA 补算后**自动重放一次**，最终结果与"一开始就预热到"
   *   完全一致（重放从 t=0 开始，确定性不变）。
   */
  readonly missing = new Map<string, WarmMiss>();
  /** 环境键 → 该键对应的脉冲集合（把缺口还原成可补算的输入）。 */
  #envByKey = new Map<string, CommandLinkSpec[]>();

  private constructor(
    state: BattleState, stats: Map<string, FitStats>, keyframeBase: number,
    reserves: Map<string, ReserveEntry>, env: EnvConfig = {},
    sources: CommandBurstSource[] = [],
  ) {
    this.state = state;
    this.#stats = stats;
    this.#reserves = reserves;
    this.#env = env;
    this.#sources = sources;
    this.keyframes = new KeyframeStore(keyframeBase);
    this.#deps = {
      resolve: (u: Unit): FitStats => {
        const modules = modulesWithStates(this.state, u);
        const kb = stateBitmap(modules);
        const bp = this.state.blueprints[u.id];
        const key = statsKey(bp ? fitSigOf(bp) : u.id, kb, u.envKey);
        const hit = this.#stats.get(key);
        if (hit) return hit;
        // 未预热 → 记录缺口（用现有属性表占位，让本次重放跑完并**收集全部**缺口）
        if (bp) {
          const links = this.#envByKey.get(u.envKey) ?? [];
          this.missing.set(key, {
            key,
            shipTypeId: bp.shipTypeId,
            modules,
            extras: extrasFor(this.#env, bp, mergeLinks(this.#env, bp, links)),
          });
        }
        return u.stats;
      },
      reserve: (id: string) => this.#reserves.get(id),
      reserveIds: () => [...this.#reserves.keys()].sort(),
    };
  }

  /**
   * 把运行期收集到的缺口交给 PYFA 补算，返回 key → 属性表。
   * （由驱动器在重放前调用；见 `Runner.#rebuild` 的自愈循环。）
   */
  static async warmMisses(
    client: StatOracleClient, cache: AttrCache, misses: readonly WarmMiss[],
  ): Promise<Map<string, FitStats>> {
    const out = new Map<string, FitStats>();
    for (const m of misses) {
      if (out.has(m.key)) continue;
      out.set(m.key, await resolveStats(client, cache, m.shipTypeId, m.modules, m.extras));
    }
    return out;
  }

  static async create(
    client: StatOracleClient, cache: AttrCache, config: BattleConfig, commands: Command[] = [],
    seed?: ReadonlyMap<string, FitStats>,
  ): Promise<Battle> {
    const stats = new Map<string, FitStats>(seed ?? []);
    const units: Unit[] = [];
    const blueprints: Record<string, UnitBlueprint> = {};

    // ★ 指挥脉冲按**位置**生效：先把所有蓝图当成候选源，算出每个单位开局实际生效的脉冲集合，
    //   再按该环境解析属性 —— 开局就在脉冲范围内的单位，一开始拿到的就是加成后的属性。
    const sources = config.commandBurstSources ?? [];
    const sourceStates = new Map<string, LinkSourceState>();
    /** 单位 id → 开局生效的脉冲集合（登记进 battle.#envByKey，供自愈还原）。 */
    const initialLinks = new Map<string, CommandLinkSpec[]>();
    for (const bp of config.blueprints) {
      sourceStates.set(bp.unitId, {
        sideId: bp.sideId, fleetId: bp.fleetId, pos: bp.pos,
        moduleStates: bp.modules.map((m) => m.state ?? "online"),
        usable: true,
      });
    }
    const lookSource = (id: string) => sourceStates.get(id);

    for (const bp of config.blueprints) {
      blueprints[bp.unitId] = structuredClone(bp);
      const links = mergeLinks(config, bp, effectiveLinks(sources, bp, lookSource));
      const s = await resolveStats(client, cache, bp.shipTypeId, bp.modules,
        extrasFor(config, bp, links)).catch((err: Error) => {
        // 属性算不出来时点名是哪艘船 —— 否则用户只看到沙盘空白 + 一句 PYFA 异常，
        // 无从知道该去改哪份配装。
        throw new Error(`单位「${bp.name}」（${bp.shipName}）的属性解析失败：${err.message}`);
      });
      const u = assembleUnit(bp, s);
      u.stateBitmap = stateBitmap(bp.modules);
      u.envKey = envKeyOf(config.implants, links);
      stats.set(statsKey(u.id, u.stateBitmap, u.envKey), s);
      initialLinks.set(u.id, links);      // 供自愈时把 envKey 还原成脉冲集合
      units.push(u);
    }

    // 增援编成：属性同样在开跑前一次性预热，因此运行期的 reinforce 指令是纯同步的
    const reserves = new Map<string, ReserveEntry>();
    for (const bp of config.reserves ?? []) {
      sourceStates.set(bp.unitId, {
        sideId: bp.sideId, fleetId: bp.fleetId, pos: bp.pos,
        moduleStates: bp.modules.map((m) => m.state ?? "online"),
        usable: true,
      });
    }
    for (const bp of config.reserves ?? []) {
      const links = mergeLinks(config, bp, effectiveLinks(sources, bp, lookSource));
      const s = await resolveStats(client, cache, bp.shipTypeId, bp.modules,
        extrasFor(config, bp, links)).catch((err: Error) => {
        throw new Error(`增援单位「${bp.name}」（${bp.shipName}）的属性解析失败：${err.message}`);
      });
      reserves.set(bp.unitId, { bp: structuredClone(bp), stats: s });
    }

    const state = emptyState({
      seed: config.seed,
      mode: config.mode,
      phaseOrder: [...(config.phaseOrder ?? DEFAULT_PHASE_ORDER)],
      units,
      blueprints,
      celestials: config.celestials ? structuredClone(config.celestials) : [],
      settings: { ...DEFAULT_ENGINE_SETTINGS, ...(config.settings ?? {}) },
    });
    state.unitIndex = {};
    state.units.forEach((u, i) => (state.unitIndex[u.id] = i));

    const battle = new Battle(state, stats, config.keyframeBase ?? 30, reserves, {
      implants: config.implants,
      envBySide: config.envBySide,
    }, sources);
    for (const u of state.units) {
      const links = initialLinks.get(u.id);
      if (links) battle.#envByKey.set(u.envKey, links);
    }
    await battle.#prewarm(client, cache, commands);
    battle.#byTick = groupByTick(commands);
    battle.keyframes.record(state);
    return battle;
  }

  #byTick = new Map<number, Command[]>();

  /**
   * 预解析**所有可能出现的属性组合**：`(单位 × 状态位图 × 环境键)`。
   *
   * 环境键 = 脑插 + **该单位此刻实际生效的指挥脉冲集合**。因为脉冲按位置生效，
   * 这里把它所在舰队的**全部子集**（去重后通常很少）逐一预热 ——
   * 运行期只需按位置查表，既保证"预热完备"，又不破坏确定性。
   */
  async #prewarm(client: StatOracleClient, cache: AttrCache, commands: Command[]): Promise<void> {
    // ① 每个单位模拟命令序列，得到它可达的 (bitmap → modules)
    const perUnit = new Map<string, Map<string, ModuleSpec[]>>();
    for (const u of this.state.units) {
      const m = new Map<string, ModuleSpec[]>();
      m.set(u.stateBitmap, modulesWithStates(this.state, u));
      perUnit.set(u.id, m);
    }

    // 每个单位的模块 state 副本，用于按 tick 顺序模拟命令效果
    const simStates = new Map<string, string[]>();
    for (const u of this.state.units) simStates.set(u.id, [...u.moduleStates]);

    for (const cmd of commands.slice().sort((a, b) => a.tick - b.tick)) {
      if (cmd.action !== "toggleModule" && cmd.action !== "setCharge" && cmd.action !== "toggleWeapon") {
        continue;
      }
      for (const u of this.state.units) {
        if (!matchesTarget(u, cmd)) continue;
        const bp = this.state.blueprints[u.id];
        if (!bp) continue;
        const states = simStates.get(u.id)!;
        // ★ 武器开关 = **该型号全部炮位**的模块状态（与 commands.toggleWeapon 一致）。
        //   炮位为 `online` 时 oracle 给 dps=0，active 才有伤害，所以这条必须一起模拟，
        //   否则"点开火"会在运行期查不到预热好的位图。
        if (cmd.action === "toggleWeapon") {
          const want = (cmd.params.on === undefined ? true : Boolean(cmd.params.on))
            ? "active" : "online";
          const typeId = Number(cmd.params.typeId ?? 0);
          let touched = false;
          for (let i = 0; i < bp.modules.length; i++) {
            if (bp.modules[i].typeId !== typeId || states[i] === "offline") continue;
            states[i] = want;
            touched = true;
          }
          if (!touched) continue;
          const mods = bp.modules.map((m, i) => ({ ...m, state: states[i] ?? m.state ?? "online" }));
          perUnit.get(u.id)?.set(stateBitmap(mods), mods);
          continue;
        }
        let idx = -1;
        if (cmd.params.moduleIndex !== undefined) {
          idx = Number(cmd.params.moduleIndex);
        } else if (cmd.params.typeId !== undefined && cmd.action === "setCharge") {
          idx = bp.modules.findIndex((m) => m.typeId === Number(cmd.params.typeId));
        } else {
          // 用单位当前的 actives 解析 kind+实例序号
          const probe = { ...u, moduleStates: states };
          idx = resolveModuleIndex(this.state, probe as Unit, cmd.params);
        }
        if (idx < 0 || idx >= bp.modules.length) continue;
        if (cmd.action === "toggleModule") {
          states[idx] = String(cmd.params.state ?? "online");
        } else {
          bp.modules[idx] = { ...bp.modules[idx], chargeTypeId: Number(cmd.params.chargeTypeId ?? 0) };
        }
        const modules = bp.modules.map((m, i) => ({ ...m, state: states[i] ?? m.state ?? "online" }));
        perUnit.get(u.id)?.set(stateBitmap(modules), modules);
      }
    }

    // ①+ ★ 按「配装签名」归并（setCharge 会改装料 → 签名必须在模拟**之后**才算）。
    //     同配装的船共享同一份 (bitmap → modules) 表，枚举与解析都只做一次。
    const variants = new Map<string, Map<string, ModuleSpec[]>>();
    const sigOf = new Map<string, string>();
    for (const u of this.state.units) {
      const bp = this.state.blueprints[u.id];
      const sig = bp ? fitSigOf(bp) : u.id;
      sigOf.set(u.id, sig);
      let m = variants.get(sig);
      if (!m) { m = new Map(); variants.set(sig, m); }
      for (const [bm, mods] of perUnit.get(u.id)!) {
        if (!m.has(bm)) m.set(bm, mods);
      }
    }

    // ①' ★ 组合枚举：命令只覆盖了"逐条累积"的位图，但"本轮循环走完才停用"
    //     会把某个实例**单独**设回 online，产生命令序列里从未出现过的位图。
    //     因此对每个被 toggleModule 触及的模块下标，枚举 online/active 的全组合，
    //     保证运行期 resolve() 一定命中（否则会抛"属性组合未预热"）。
    // ①' ★ **只对「关」类指令**做闭包枚举（不是对所有被触及下标做 2^n）。
    //
    //   为什么需要它：把正在运转的模块点"停止"时，引擎只打 `pendingOff`，
    //   **本轮循环走完**才由 stopModuleCycle 把该下标置回 online —— 这个位图
    //   在命令序列里从未出现过，必须提前预热，否则运行期 resolve 会抛"未预热"。
    //
    //   为什么不能对所有被触及下标做 2^n："给整支舰队批量开启装备"会产生几十条
    //   toggle(active) 指令、触及十几个下标 → 每份配装 2^n 个组合，直接把预热
    //   带进上万次 PYFA 求解 → 表现为长时间"重算中"卡死。而那类指令**不会产生
    //   任何额外位图**（只产生命令序列里已有的状态），枚举纯属浪费。
    const offIdxBySig = new Map<string, Set<number>>();
    const addOff = (sig: string, idx: number): void => {
      let set = offIdxBySig.get(sig);
      if (!set) { set = new Set<number>(); offIdxBySig.set(sig, set); }
      set.add(idx);
    };
    for (const cmd of commands) {
      const isOffModule = cmd.action === "toggleModule"
        && String(cmd.params.state ?? "online") !== "active";
      const isOffWeapon = cmd.action === "toggleWeapon" && cmd.params.on === false;
      if (!isOffModule && !isOffWeapon) continue;   // 只有"关/停火"才需要
      for (const u of this.state.units) {
        if (!matchesTarget(u, cmd)) continue;
        const bp = this.state.blueprints[u.id];
        if (!bp) continue;
        const sig = sigOf.get(u.id)!;
        if (isOffWeapon) {
          // 停火 = 该型号全部炮位一起置 online
          const typeId = Number(cmd.params.typeId ?? 0);
          for (let i = 0; i < bp.modules.length; i++) {
            if (bp.modules[i].typeId === typeId && u.moduleStates[i] !== "offline") addOff(sig, i);
          }
          continue;
        }
        let idx = -1;
        if (cmd.params.moduleIndex !== undefined) {
          idx = Number(cmd.params.moduleIndex);
        } else {
          const probe = { ...u, moduleStates: [...u.moduleStates] };
          idx = resolveModuleIndex(this.state, probe as Unit, cmd.params);
        }
        if (idx < 0 || idx >= bp.modules.length) continue;
        addOff(sig, idx);
      }
    }
    // 对每份配装：把这些下标逐个"置回 online"，边生成边封顶（防组合爆炸）
    const MAX_VARIANTS_PER_FIT = 256;
    for (const [sig, idxSet] of offIdxBySig) {
      const ofFit = variants.get(sig);
      if (!ofFit) continue;
      for (const idx of [...idxSet].sort((x, y) => x - y)) {
        const snapshot = [...ofFit.values()]; // 快照，避免边遍历边插入
        for (const mods of snapshot) {
          if (ofFit.size >= MAX_VARIANTS_PER_FIT) break;
          if ((mods[idx]?.state ?? "online") === "online") continue;
          const changed = mods.map((m, i) => (i === idx ? { ...m, state: "online" } : m));
          const bm = stateBitmap(changed);
          if (!ofFit.has(bm)) ofFit.set(bm, changed);
        }
        if (ofFit.size >= MAX_VARIANTS_PER_FIT) break;
      }
    }

    // ② 指挥脉冲：每个舰队的**全部可能集合**（子集枚举 + 去重）
    const fleetKey = (sideId: number, fleetId: number) => `${sideId}:${fleetId}`;
    const combosByFleet = new Map<string, CommandLinkSpec[][]>();
    for (const u of this.state.units) {
      const k = fleetKey(u.sideId, u.fleetId);
      if (combosByFleet.has(k)) continue;
      const fleetSources = this.#sources.filter((s) => {
        const h = this.state.units.find((x) => x.id === s.unitId);
        return !!h && h.sideId === u.sideId && h.fleetId === u.fleetId;
      });
      combosByFleet.set(k, enumerateCombos(fleetSources));
    }

    // ③ 逐 (配装签名 × bitmap × 脉冲集合) 解析并缓存（同配装的船自动共享）
    //
    // ★ 总预算保险：预热是"每个新组合一次 PYFA 求解"，一次几毫秒到几百毫秒。
    //   若某个会话把组合数堆到成千上万，重算就会变成**分钟级卡死**（用户报障）。
    //   这里硬性封顶：超出即停止预热并告警 —— 代价是极少数组合运行期查不到，
    //   但那会**明确报错**（且界面会显示），绝不再无声卡死。
    let warmBudget = 500;
    let warmTruncated = false;
    const warm = async (
      sig: string, bp: UnitBlueprint, bitmap: string, modules: ModuleSpec[],
      combos: CommandLinkSpec[][],
    ): Promise<void> => {
      for (const links of combos) {
        const merged = mergeLinks(this.#env, bp, links);
        const envKey = envKeyOf(this.#env.implants, merged);
        this.#envByKey.set(envKey, merged);   // 登记：自愈时按 envKey 还原脉冲集合
        const key = statsKey(sig, bitmap, envKey);
        if (this.#stats.has(key)) continue;
        if (warmBudget-- <= 0) {
          if (!warmTruncated) {
            warmTruncated = true;
            console.warn(`[engine] 属性预热达到上限，后续组合不再预热（sig=${sig}）`);
          }
          continue;
        }
        this.#stats.set(key, null as unknown as FitStats); // 占位，稍后填充
        const s = await resolveStats(client, cache, bp.shipTypeId, modules,
          extrasFor(this.#env, bp, merged));
        this.#stats.set(key, s);
      }
    };

    for (const u of this.state.units) {
      const bp = this.state.blueprints[u.id];
      if (!bp) continue;
      const sig = sigOf.get(u.id)!;
      const combos = combosByFleet.get(fleetKey(u.sideId, u.fleetId)) ?? [[]];
      for (const [bitmap, modules] of variants.get(sig) ?? []) {
        await warm(sig, bp, bitmap, modules, combos);
      }
    }
    // 预备单位（增援）入场后同样受脉冲影响 —— 也按它所属舰队的集合预热
    for (const [, entry] of this.#reserves) {
      const bp = entry.bp;
      const combos = combosByFleet.get(fleetKey(bp.sideId, bp.fleetId)) ?? [[]];
      const modules = bp.modules.map((m) => ({ ...m, state: m.state ?? "online" }));
      await warm(fitSigOf(bp), bp, stateBitmap(modules), modules, combos);
    }

    // ①-b ★★ **运行时增援的虚拟单位**（必修：增援后开装备曾抛"未预热"/长时间卡死）
    //
    //   增援单位由 `applyReinforce` **运行到那一 tick 时**才被创建，`Battle.create`
    //   期间它根本不在 `state.units` 里 —— 所以上面的 ①/①'/②/③ 全都覆盖不到它。
    //   于是用户在增援后一开装备（附甲板、索敌计算机…），新位图查不到预热 →
    //   `resolve()` 抛"属性组合未预热" → 该指令永远无法生效（界面表现为卡死）。
    //
    //   ★ 两条**硬约束**，避免把"整条会话历史"全套到它身上而被放大成分钟级卡死：
    //     ① `tick >= 增援 tick` —— 它那一刻才存在，之前的指令与它无关；
    //     ② 目标命中它（id 前缀 / 势力+舰队+联队+中队；未指定的层级按通配）。
    //   ★ 环境组合只需 `[[]]`：它落在**新开舰队**，而"指挥脉冲同势力**且同舰队**才生效"
    //     （commandLink.ts 判定第 ① 条）→ 那个新舰队没有任何脉冲源。
    //
    //   实现要点：用**本地副本**改模块，绝不改动命令里的蓝图对象（setCharge 若被误改，
    //   增援会真的带着不该有的装料入场）；配装签名随装料变化逐个生成。
    const fleetNext = new Map<number, number>();
    for (const cmd of commands) {
      if (cmd.action !== "reinforce") continue;
      const rp = cmd.params as Record<string, unknown>;
      const rbp = rp.blueprint as UnitBlueprint | undefined;
      const rst = rp.stats as FitStats | undefined;
      if (!rbp || !rst) continue;
      const rside = Number(rp.sideId ?? cmd.target.sideId ?? rbp.sideId ?? 0);
      // 与 applyReinforce 完全一致：该势力当前最大舰队号 + 1，且每条增援命令再 +1
      if (!fleetNext.has(rside)) {
        let mx = -1;
        for (const u of this.state.units) if (u.sideId === rside && u.fleetId > mx) mx = u.fleetId;
        fleetNext.set(rside, mx + 1);
      }
      const rfleet = fleetNext.get(rside)!;
      fleetNext.set(rside, rfleet + 1);
      const spawnBase = String(rp.spawnId ?? `spawn-S${rside}`);

      // resolveModuleIndex 只读 actives[i].kind 与 activeInputIndex[i]
      const rows = rst.actives ?? [];
      const probe = {
        id: `${spawnBase}-0`, sideId: rside, fleetId: rfleet, wingId: 0, squadId: 0,
        alive: true, evacuated: false,
        actives: rows.map((r) => ({ kind: r.kind })),
        activeInputIndex: rows.map((r) => r.inputIndex ?? -1),
      } as unknown as Unit;

      const modsLocal: ModuleSpec[] = rbp.modules.map((m) => ({ ...m }));
      const states: string[] = modsLocal.map((m) => m.state ?? "online");
      const sigOfMods = (mods: ModuleSpec[]): string =>
        `${rbp.shipTypeId}|${mods.map((m) => `${m.typeId}.${m.chargeTypeId ?? 0}`).join(",")}`;
      const own = new Map<string, Map<string, ModuleSpec[]>>();
      const put = (): void => {
        const modules = modsLocal.map((m, i) => ({ ...m, state: states[i] ?? m.state ?? "online" }));
        const sig = sigOfMods(modules);
        let m = own.get(sig);
        if (!m) { m = new Map(); own.set(sig, m); }
        const bm = stateBitmap(modules);
        if (!m.has(bm)) m.set(bm, modules);
      };
      put();

      const offIdx: number[] = [];
      for (const c2 of commands.slice().sort((a, b) => a.tick - b.tick)) {
        if (c2.action !== "toggleModule" && c2.action !== "setCharge" && c2.action !== "toggleWeapon") {
          continue;
        }
        if (c2.tick < cmd.tick) continue;                                  // ① 它那时还不存在
        if (!matchReinforced(c2, rside, rfleet, spawnBase)) continue;       // ② 目标命中
        if (c2.action === "toggleWeapon") {
          const want = (c2.params.on === undefined ? true : Boolean(c2.params.on)) ? "active" : "online";
          const typeId = Number(c2.params.typeId ?? 0);
          let touched = false;
          for (let i = 0; i < modsLocal.length; i++) {
            if (modsLocal[i].typeId !== typeId || states[i] === "offline") continue;
            states[i] = want;
            if (want !== "active") offIdx.push(i);
            touched = true;
          }
          if (!touched) continue;
          put();
          continue;
        }
        let idx = -1;
        if (c2.params.moduleIndex !== undefined) {
          idx = Number(c2.params.moduleIndex);
        } else if (c2.params.typeId !== undefined && c2.action === "setCharge") {
          idx = modsLocal.findIndex((m) => m.typeId === Number(c2.params.typeId));
        } else {
          idx = resolveModuleIndex(this.state, probe, c2.params);
        }
        if (idx < 0 || idx >= modsLocal.length) continue;
        if (c2.action === "toggleModule") {
          states[idx] = String(c2.params.state ?? "online");
          if (states[idx] !== "active") offIdx.push(idx);
        } else {
          modsLocal[idx] = { ...modsLocal[idx], chargeTypeId: Number(c2.params.chargeTypeId ?? 0) };
        }
        put();
      }
      // "本轮循环走完才停用" → 把"关"过的下标逐个置回 online（同步上限，防组合爆炸）
      for (const idx of [...new Set(offIdx)].sort((x, y) => x - y)) {
        for (const ofFit of own.values()) {
          const snapshot = [...ofFit.values()];
          for (const mods of snapshot) {
            if (ofFit.size >= MAX_VARIANTS_PER_FIT) break;
            if ((mods[idx]?.state ?? "online") === "online") continue;
            const changed = mods.map((m, i) => (i === idx ? { ...m, state: "online" } : m));
            const bm = stateBitmap(changed);
            if (!ofFit.has(bm)) ofFit.set(bm, changed);
          }
        }
      }

      for (const [sig, ofFit] of own) {
        let shared = variants.get(sig);
        if (!shared) { shared = new Map(); variants.set(sig, shared); }
        for (const [bm, mods] of ofFit) {
          if (!shared.has(bm)) shared.set(bm, mods);
          await warm(sig, rbp, bm, mods, [[]]);   // 新舰队无脉冲源 → 只需空组合
        }
      }
    }
  }

  #ctx(): SimContext {
    return {
      get: (id) => {
        if (!id) return undefined;
        const i = this.state.unitIndex[id];
        return i === undefined ? undefined : this.state.units[i];
      },
      applyCommands: (state) => {
        const list = this.#byTick.get(state.tick);
        if (!list || list.length === 0) return;
        for (const cmd of list) applyCommand(state, cmd, this.#deps);
      },
      /**
       * 指挥脉冲**按位置生效**：每 tick 检查每个单位实际命中的脉冲集合，
       * **只有集合变了**才切换属性表（否则每 tick 重算既慢又无意义）。
       * 切换时保留运行期状态（开火/冷却/组血量），不会"一进范围就被重置"。
       */
      applyEnv: (state) => {
        if (this.#sources.length === 0 && !this.#env.envBySide) return;
        const sourceState = (id: string) => {
          const i = state.unitIndex[id];
          const u = i === undefined ? undefined : state.units[i];
          return u ? sourceStateOf(u) : undefined;
        };
        for (const u of state.units) {
          if (!u.alive || u.evacuated) continue;
          const bp = state.blueprints[u.id];
          if (!bp) continue;
          const links = mergeLinks(
            this.#env, bp, effectiveLinks(this.#sources, u, sourceState),
          );
          const key = envKeyOf(this.#env.implants, links);
          if (key === u.envKey) continue;
          this.#envByKey.set(key, links);   // 运行期出现的新环境键 → 登记，供自愈还原
          u.envKey = key;
          applyStats(u, this.#deps.resolve(u), { preserveRuntime: true });
        }
      },
      /**
       * ★ "停用中"到期落地：把该实例对应的配装模块设回 online 并重算属性。
       *   该状态位图已在预热阶段被组合枚举覆盖（见 #prewarm ①'），因此 resolve 必定命中。
       */
      stopModuleCycle: (_state, u, ai) => {
        const a = u.actives[ai];
        if (!a) return;
        a.on = false;
        a.pendingOff = false;
        a.cycleRemainingMs = 0;
        const idx = u.activeInputIndex[ai];
        if (idx >= 0 && idx < u.moduleStates.length) u.moduleStates[idx] = "online";
        applyStats(u, this.#deps.resolve(u), { preserveRuntime: true });
      },
    };
  }

  /** 推进 n 个 tick；自动按指数稀释记录关键帧。 */
  run(n: number): void {
    const ctx = this.#ctx();
    const target = this.state.tick + n;
    while (this.state.tick < target && !this.state.finished) {
      step(this.state, ctx);
      this.keyframes.record(this.state);
    }
  }

  /** 推进到指定 tick（含）。 */
  runUntil(tick: number): void {
    if (tick > this.state.tick) this.run(tick - this.state.tick);
  }

  /** 直接跑完整场（直到结束或 maxTicks）。 */
  runToEnd(maxTicks: number): void {
    runTicks(this.state, this.#ctx(), maxTicks);
  }
}

function matchesTarget(u: Unit, cmd: Command): boolean {
  const t = cmd.target;
  if (t.unitId && u.id !== t.unitId) return false;
  if (t.unitIds && t.unitIds.length > 0 && !t.unitIds.includes(u.id)) return false;
  if (t.sideId !== undefined && u.sideId !== t.sideId) return false;
  if (t.fleetId !== undefined && u.fleetId !== t.fleetId) return false;
  if (t.wingId !== undefined && u.wingId !== t.wingId) return false;
  if (t.squadId !== undefined && u.squadId !== t.squadId) return false;
  return true;
}

/**
 * 命令是否会命中**运行时增援生成的那一批单位**（预热用，与 `selectUnits` 语义一致）。
 *
 * 与 `matchesTarget` 的差别：增援单位此刻还不存在，只能按**将要生成的 id 前缀**
 * （`${spawnId}-${i}`）判断；且它们一定是 `wingId=0 / squadId=0`（见 applyReinforce）。
 */
function matchReinforced(cmd: Command, sideId: number, fleetId: number, spawnBase: string): boolean {
  const t = cmd.target;
  if (t.unitId) return String(t.unitId).startsWith(`${spawnBase}-`);
  if (t.unitIds && t.unitIds.length > 0) {
    return t.unitIds.some((id) => String(id).startsWith(`${spawnBase}-`));
  }
  if (t.sideId !== undefined && t.sideId !== sideId) return false;
  if (t.fleetId !== undefined && t.fleetId !== fleetId) return false;
  if (t.wingId !== undefined && t.wingId !== 0) return false;
  if (t.squadId !== undefined && t.squadId !== 0) return false;
  return true;
}

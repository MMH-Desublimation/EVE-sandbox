/**
 * 引擎 Worker（§8.6 / §8.7）。
 *
 * 职责：持有 Runner（引擎），按"推演时间与真实时间解耦"的原则推进，
 * 并把引擎状态**投影成只读帧**下发给 UI。所有重算都发生在这里，UI 线程不被阻塞。
 *
 * 属性请求经主线程代理（Worker 在 WebView2 里拿不到宿主对象），
 * 因此本 Worker 只依赖 postMessage，不依赖 fetch。
 */
import type { FitStats } from "../../shared/contract.ts";
import type { StatsSource } from "../../shared/statsSource.ts";
import type { BattleConfig } from "../../core/battle.ts";
import type { Command } from "../../core/commands.ts";
import type { UnitBlueprint } from "../../core/state.ts";
import { AttrCache } from "../../stats/cache.ts";
import { Runner } from "../../core/runner.ts";
import { buildScenario } from "../../core/scenario.ts";
import { buildCelestialFrames, buildSquads, buildUnitFrames } from "../viewModel.ts";
import type { Frame, FromWorker, SavedBattle, SquadFrame, ToWorker } from "../protocol.ts";

const post = (msg: FromWorker): void => {
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);
};

/** 属性请求代理：Worker → 主线程 → 宿主桥 → StatOracle。 */
class BridgeStatsSource implements StatsSource {
  #pending = new Map<number, { resolve: (v: FitStats) => void; reject: (e: Error) => void }>();
  #nextId = 1;

  calcFit(req: Parameters<StatsSource["calcFit"]>[0]): Promise<FitStats> {
    const id = this.#nextId++;
    return new Promise<FitStats>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      post({ type: "statsRequest", id, payload: { op: "calcFit", ...req } });
    });
  }

  respond(id: number, ok: boolean, result: unknown, error?: string): void {
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    if (ok) p.resolve(result as FitStats);
    else p.reject(new Error(error ?? "属性请求失败"));
  }
}

const source = new BridgeStatsSource();
const cache = new AttrCache(8192);

let runner: Runner | null = null;
/** 运行时增援（右键对话框）的唯一序号：写入命令的 spawnId，重放等价。 */
let spawnSeq = 0;
/** init 完成前不得触碰 runner（其内部 Battle 尚未建立）。 */
let ready = false;
let scenarioId = "";
let playing = false;
let speed = 4;
let busy = false;
let busyNote = "";
/**
 * 本次"忙碌"（重算/预热）的起始时刻。
 *
 * ★ 看门狗：重算/预热是 **worker 线程里的同步长任务**，期间无法处理消息。
 *   用户看到的"卡死"往往就是它。这里在忙超过 3 s 后**每秒**更新一次提示（带已耗时），
 *   让界面能区分"在算"与"真死"，也便于把慢在哪一步直接反馈出来。
 */
let busySince = 0;
let lastRealMs = 0;
let lastFrameMs = 0;
let squadsCache: SquadFrame[] | undefined;
let lastEventCount = 0;
let frameCount = 0;
/**
 * 单位帧频率。
 *
 * ★ V0.7：12 Hz → 20 Hz。渲染层已经用速度做外推（map.ts），
 *   所以帧率不再是"运动是否连续"的决定因素，但 20 Hz 能让
 *   血条/进度条/距离读数跟着更跟手；SQUAD_EVERY 相应保持 4。
 */
const FRAME_MS = 1000 / 20;   // 单位帧 20 Hz
const SQUAD_EVERY = 4;        // 小队/战报 每 4 帧刷新一次

function buildFrame(force: boolean): Frame | null {
  if (!runner || !ready) return null;
  const state = runner.state;
  const now = performance.now();
  if (!force && now - lastFrameMs < FRAME_MS) return null;
  lastFrameMs = now;
  frameCount++;

  const fresh = force || frameCount % SQUAD_EVERY === 0;
  if (fresh) squadsCache = buildSquads(state);

  const events = state.events.slice(lastEventCount);
  lastEventCount = state.events.length;

  return {
    tick: state.tick,
    finished: state.finished,
    winnerSideId: state.winnerSideId,
    playing,
    speed,
    busy,
    busyNote,
    units: buildUnitFrames(state),
    celestials: buildCelestialFrames(state),
    ...(fresh ? { squads: squadsCache } : {}),
    ...(fresh
      ? {
          report: {
            // 泛化到任意数量势力（多势力混战）
            sides: [...new Set(state.units.map((u) => u.sideId))].sort((a, b) => a - b).map((sideId) => {
              const list = state.units.filter((u) => u.sideId === sideId);
              return {
                sideId,
                start: list.length,
                alive: list.filter((u) => u.alive && !u.evacuated).length,
                killed: list.filter((u) => !u.alive).length,
                evacuated: list.filter((u) => u.evacuated).length,
                damageDealt: Math.round(list.reduce((s, u) => s + u.damageDealt, 0)),
                damageTaken: Math.round(list.reduce((s, u) => s + u.damageTaken, 0)),
              };
            }),
            ticks: state.tick,
            finished: state.finished,
            winnerSideId: state.winnerSideId,
          },
          kills: state.kills.map((k) => ({
            tick: k.tick, sideId: k.sideId, unitName: k.unitName, shipName: k.shipName,
          })),
        }
      : {}),
    events,
    marks: [...runner.marks],
    keyframes: runner.keyframes.ticks(),
    branches: runner.branchList(),
    currentBranch: runner.currentBranchId,
    commandLog: state.commandLog.slice(-200),
  };
}

function pushFrame(force = true): void {
  const frame = buildFrame(force);
  if (frame) post({ type: "frame", frame });
}

let lastInit: { scenarioId: string; unitsPerSide?: number } | null = null;
/**
 * 最近一次实际使用的配置。
 * 内置场景由 id 重建；「战场编成」自建配置则缓存下来，
 * 这样同一标签下再走 `restore`（载入存档）时无需重建整份编成。
 */
let lastConfig: BattleConfig | null = null;
let pyfaVersion = "v2.69.0";
/** 曾经推进到过的最远 tick：用于判定"是否在编辑历史"。 */
let maxHead = 0;
/**
 * 初始化代数。构建是异步的（要问属性），若期间又来了新的 init，
 * 旧任务必须**放弃发布**，否则会把已过期的场景状态盖回去（并发初始化竞态）。
 */
let initGen = 0;

/** 统一的场景初始化（首次载入与载入存档共用）。 */
async function initScenario(
  id: string, unitsPerSide: number | undefined, commands: Command[], autoPlay: boolean,
  prebuilt?: BattleConfig,
): Promise<void> {
  const gen = ++initGen;
  const current = () => gen === initGen;

  scenarioId = id;
  lastInit = { scenarioId: id, ...(unitsPerSide !== undefined ? { unitsPerSide } : {}) };
  ready = false;
  playing = false;
  busy = true;
  post({ type: "busy", busy: true, note: "构建场景…" });

  // 自建配置（战场编成）优先；否则按内置场景 id 程序化生成
  const config = prebuilt ?? buildScenario(id, unitsPerSide !== undefined ? { unitsPerSide } : {});
  lastConfig = config;
  // 场景配置里的地物数（有的场景本就没有地物）——供自动验收判定"下发是否完整"
  const landmarksExpected = config.celestials?.length ?? 0;
  // 先构建在**局部变量**里，确认自己仍是最新一次初始化后才发布
  const candidate = new Runner(source, cache, config, {
    onBusy: (b, note) => {
      if (!current()) return;
      if (b && !busy) busySince = performance.now();
      busy = b;
      busyNote = note;
      post({ type: "busy", busy: b, note });
    },
    onError: (e) => {
      if (current()) post({ type: "error", message: String(e?.message ?? e) });
    },
  });

  await candidate.init(commands);
  if (!current()) return;          // 已被更新的一次初始化取代：丢弃本次结果

  runner = candidate;
  ready = true;
  maxHead = runner.tick;
  lastEventCount = runner.state.events.length;
  playing = autoPlay;
  tickDebt = 0;
  lastRealMs = performance.now();
  post({ type: "ready", pyfaVersion, scenarioId, landmarksExpected });
  pushFrame(true);
}

async function handle(msg: ToWorker): Promise<void> {
  try {
    switch (msg.type) {
      case "init": {
        await initScenario(msg.scenarioId, msg.unitsPerSide, [], true);
        break;
      }
      case "initConfig": {
        // 「战场编成」页自建配置：直接开局（标签仅用于存档/显示）
        await initScenario(msg.label, undefined, [], true, msg.config);
        break;
      }
      case "export": {
        if (!runner || !ready) break;
        const data: SavedBattle = {
          format: "eve-battle-sandbox",
          saveVersion: 1,
          pyfaVersion,
          scenarioId,
          ...(lastInit?.unitsPerSide !== undefined ? { unitsPerSide: lastInit.unitsPerSide } : {}),
          seed: runner.state.seed,
          mode: runner.state.mode,
          tick: runner.state.tick,
          commands: runner.commands.map((c) => structuredClone(c)),
          marks: [...runner.marks],
          savedAt: new Date().toISOString(),
        };
        post({ type: "exported", data });
        break;
      }
      case "restore": {
        const d = msg.data;
        // 同一标签的自建配置直接复用（无需重建整份编成）
        const reuse = d.scenarioId === scenarioId && lastConfig ? lastConfig : undefined;
        await initScenario(d.scenarioId, d.unitsPerSide, d.commands, false, reuse);
        runner?.restoreMarks(d.marks);
        await runner?.seek(d.tick);
        playing = false;
        pushFrame(true);
        break;
      }
      case "play":
        playing = true;
        lastRealMs = performance.now();
        pushFrame(true);
        break;
      case "pause":
        playing = false;
        pushFrame(true);
        break;
      case "setSpeed":
        speed = Math.max(0.25, Math.min(30, msg.speed));
        pushFrame(true);
        break;
      case "step": {
        playing = false;
        runner?.run(msg.ticks);
        runner?.markKeyframeIfDue();
        pushFrame(true);
        break;
      }
      case "command": {
        // 命令统一走 pump 的批量合并（见 handleCommands）；这里只兜底单条
        if (!runner) break;
        await handleCommands([msg.cmd]);
        pushFrame(true);
        break;
      }
      case "undo": {
        await runner?.undo();
        pushFrame(true);
        break;
      }
      case "mark": {
        runner?.mark();
        pushFrame(true);
        break;
      }
      case "fork": {
        await runner?.fork(msg.atTick);
        pushFrame(true);
        break;
      }
      case "switchBranch": {
        await runner?.switchBranch(msg.id);
        pushFrame(true);
        break;
      }
      case "requestFrame":
        pushFrame(true);
        break;
    }
  } catch (err) {
    post({ type: "error", message: String((err as Error).message ?? err) });
    busy = false;
    // ★ 必须补一帧：否则界面永远停留在"重算中"（busy 只随帧下发）
    pushFrame(true);
  }
}

/**
 * 右键"增援对话框"带来的 fit：在命令入队前算好属性并附到命令上，
 * 引擎据此运行时生成单位（见 commands.ts 的 applyReinforce 运行时分支）。
 * 这样用户自建战场（没有预置预备单位）也能一键增援，而非毫无反应。
 */
async function prepareReinforceSpawn(cmd: Command): Promise<void> {
  const p = cmd.params as Record<string, unknown>;
  const fit = p.fit as {
    name: string; shipName: string; shipTypeId: number;
    modules?: Array<Record<string, unknown>>;
    drones?: Array<Record<string, unknown>>;
    fighters?: Array<Record<string, unknown>>;
  } | undefined;
  if (!fit) return;
  const sideId = Number(p.sideId ?? cmd.target.sideId ?? 0);
  const modules = (fit.modules ?? []).map((m: Record<string, unknown>) => ({
    ...m, state: (m.state as string) ?? "active",
  }));
  const bp: UnitBlueprint = {
    id: "", name: fit.name, shipName: fit.shipName, shipTypeId: fit.shipTypeId,
    sideId, fleetId: 0, wingId: 0, squadId: 0, role: "line",
    modules: modules as UnitBlueprint["modules"],
    drones: (fit.drones ?? []) as UnitBlueprint["drones"],
    fighters: (fit.fighters ?? []) as UnitBlueprint["fighters"],
    fitFingerprint: `reinforce-${fit.shipTypeId}`,
    doctrine: "focus", order: { type: "hold" }, pos: { x: 0, y: 0 },
  };
  const stats = await source.calcFit({
    ship: { typeId: fit.shipTypeId, name: fit.shipName },
    modules: bp.modules, drones: bp.drones, fighters: bp.fighters,
  });
  p.blueprint = bp;
  p.stats = stats;
  p.spawnId = `spawn-S${sideId}-${++spawnSeq}`;
  delete p.fit;
}

/* ---------------- 消息串行化 ----------------
 * ★ 拖动底部时间轴时 `input` 会**每个像素**触发一次 `seek`，而向后 seek = 从关键帧
 *   **整段重算**。原先用 `void handle(data)` 并发处理，几十个重算会同时操作同一份
 *   Runner 状态（互抢 `busy`、互相覆盖、把 Oracle 请求打爆），现象就是程序长时间
 *   完全卡死、一直停在"重算中"。
 *   这里：① 消息排队**逐条串行**执行；② 队列里**连续的 seek 只保留最后一个**（拖动
 *   过程中的中间落点没有意义，跳过它们能少算几十次整段重算）。
 */
const queue: ToWorker[] = [];
let pumping = false;
/** 是否已排入一次"自愈"请求（避免每帧重复排队）。 */
let healQueued = false;
/** 连续自愈次数（防御性上限：万一某个组合补算后仍命中不了，不能无限重放）。 */
let healAttempts = 0;

function pump(): void {
  if (pumping) return;
  pumping = true;
  void (async () => {
    try {
      while (queue.length > 0) {
        const msg = queue.shift() as ToWorker;
        // ★ 单条消息失败**不能**拖垮整个泵：旧行为是错误冒泡出 pump，
        //   于是队列不再被消费、`busy` 永久停在 true —— 界面一直显示"重算中"，
        //   点暂停/播放也只是换帧、越点越乱。这里逐条兜底：报错 + 复位忙碌 + 推帧。
        try {
          if (msg.type === "seek") {
            let last = msg.tick;
            while (queue.length > 0 && queue[0].type === "seek") {
              last = (queue.shift() as { type: "seek"; tick: number }).tick;
            }
            playing = false;
            await runner?.seek(last);
            pushFrame(true);
            continue;
          }
          // ★ 批量指令合并：批量舰队操作会一口气产生几十条 command 消息，
          //   每条各自 `#rebuild`（整场从 t=0 重建 + 推进到当前 tick）就会卡死。
          //   这里把队列里**连续的 command** 一次取走，合并成一次重算。
          if (msg.type === "command") {
            const batch: Command[] = [msg.cmd];
            while (queue.length > 0 && queue[0].type === "command") {
              batch.push((queue.shift() as { cmd: Command }).cmd);
            }
            await handleCommands(batch);
            pushFrame(true);
            continue;
          }
          // ★ 自愈（worker 内部消息，不由页面下发）：推演中途遇到了"未预热"的属性组合，
          //   在这里**串行地**补算 + 重放（走队列可避免与命令处理并发抢同一个 Runner）。
          if (msg.type === "heal") {
            healQueued = false;
            await runner?.heal();
            if (runner && !runner.needsHeal) healAttempts = 0;   // 补齐成功 → 计数归零
            pushFrame(true);
            continue;
          }
          await handle(msg);
        } catch (err) {
          post({ type: "error", message: String((err as Error)?.message ?? err) });
          busy = false;
          post({ type: "busy", busy: false, note: "" });
          pushFrame(true);
        }
      }
    } finally {
      pumping = false;
    }
  })();
}

/** 应用一批命令（合并为**一次**重算）。 */
async function handleCommands(batch: Command[]): Promise<void> {
  if (!runner || batch.length === 0) return;
  const cmds: Command[] = [];
  for (const cmd of batch) {
    // 运行时增援（右键对话框带入的 fit）：入队前先算好属性并附到命令上
    if (cmd.action === "reinforce" && (cmd.params as Record<string, unknown>).fit) {
      await prepareReinforceSpawn(cmd);
    }
    cmds.push(cmd);
  }
  // ★ D-17：回溯到过去再修改 = 产生新分支（一批命令共享同一次 fork）
  const minTick = Math.min(...cmds.map((c) => c.tick));
  if (minTick < maxHead) await runner.fork(minTick);
  await runner.addCommands(cmds);
}

self.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as ToWorker & { type: string };
  // statsResponse 必须**立即**处理：`handle()` 正在 await 它，排队会死锁。
  if (data.type === "statsResponse") {
    const r = data as unknown as { id: number; ok: boolean; result?: unknown; error?: string };
    source.respond(r.id, r.ok, r.result, r.error);
    return;
  }
  queue.push(data as ToWorker);
  pump();
});

/* ---------------- 推演循环：推演时间与真实时间解耦（§6.2） ---------------- */

/** 未满一个 tick 的"欠账"，累积到 >=1 再推进；低速时也能正确前进。 */
let tickDebt = 0;

function loop(): void {
  const now = performance.now();
  // ★★★ 帧循环必须**永不中断** —— 这是"点一下整个界面永久卡死"的真正机制：
  //   旧实现里只要 `runner.run()` 或 `buildFrame()` 抛一次异常（例如某个属性组合
  //   没预热到、某个单位状态异常），函数就直接退出，末尾的 `setTimeout(loop, 16)`
  //   再也不会执行 → worker 停止推进、停止发帧 → 沙盘与状态栏定格不动，
  //   用户看到的就是"卡死"（而且点什么都不再有反应）。
  //   现在：捕获 → 暂停推演（避免每 16ms 反复抛）→ 报错（界面可见）→ **继续循环**。
  try {
    if (runner && ready && playing && !busy && !runner.finished) {
      const dtSec = Math.min(0.5, (now - lastRealMs) / 1000);
      lastRealMs = now;
      tickDebt += dtSec * speed;      // 每秒推进 speed 个 tick（1 tick = 1 秒游戏时间）
      const n = Math.floor(tickDebt);
      if (n > 0) {
        tickDebt -= n;
        runner.run(Math.min(n, 600)); // 单次上限，避免卡顿后追帧雪崩
        runner.markKeyframeIfDue();
        maxHead = Math.max(maxHead, runner.tick);
      }
    } else {
      lastRealMs = now;
      tickDebt = 0;
    }
    const frame = buildFrame(false);
    if (frame) post({ type: "frame", frame });
    // ★ 推演中途遇到未预热的属性组合 → 排队一次自愈（补算 + 重放，结果精确）。
    //   走消息队列而不是直接 await：保证与命令处理**串行**，不会并发操作同一个 Runner。
    if (runner && ready && runner.needsHeal && !healQueued) {
      if (healAttempts >= 5) {
        // 兜底：连补 5 次仍命中不了 → 停下来并明说（绝不无限重放，也绝不静默跑偏）
        if (playing) {
          playing = false;
          post({ type: "error", message: "仍有属性组合无法补齐，已暂停推演；请撤销最后一条指令后重试" });
        }
      } else {
        healAttempts++;
        healQueued = true;
        queue.push({ type: "heal" } as unknown as ToWorker);
        pump();
      }
    }
  } catch (err) {
    playing = false;                 // 先停：否则每个 tick 都会再抛一次
    tickDebt = 0;
    lastRealMs = performance.now();
    post({ type: "error", message: `推演中断：${String((err as Error)?.message ?? err)}` });
    post({ type: "busy", busy: false, note: "" });
    // 仍补一帧：界面据此把"推演中"切回"已暂停"，并保持可交互（可撤销/回溯）
    try {
      const frame = buildFrame(true);
      if (frame) post({ type: "frame", frame });
    } catch { /* 帧本身都构不出来时只能放弃这一帧，循环仍要继续 */ }
  }
  setTimeout(loop, 16);
}

post({ type: "statsReady" } as unknown as FromWorker);
setTimeout(loop, 16);

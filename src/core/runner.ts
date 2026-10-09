/**
 * 驱动器（Runner）：把「命令 → 重算 → 状态」这条链路封装起来。
 *
 * 与文档 §7.7 的对应：
 *   - 关键帧：KeyframeStore（指数稀释）在推演过程中自动记录。
 *   - 用户标记：mark() 记录"关键标记"，UI 在时间轴上显示（D-14 的交互入口）。
 *   - 分支：fork() 产生新分支，切换分支即切换到该分支的命令表（D-17）。
 *   - 编辑重算：新增/修改命令后**重算**（实现上从 t=0 重建，结果与"从关键帧重放"完全一致，
 *     且因为属性组合已缓存/预热，代价很低）。
 *
 * 铁律：命令表是时间线的唯一真源；状态 = f(初始配装, 命令, 种子)。
 */
import type { FitStats } from "../shared/contract.ts";
import type { StatsSource } from "../shared/statsSource.ts";
import type { AttrCache } from "../stats/cache.ts";
import { Battle } from "./battle.ts";
import type { BattleConfig } from "./battle.ts";
import type { Command } from "./commands.ts";
import { KeyframeStore } from "./timeline.ts";
import type { BattleState } from "./state.ts";

export interface BranchInfo {
  id: string;
  parentId: string | null;
  forkTick: number;
  commandCount: number;
}

export interface RunnerCallbacks {
  onBusy?: (busy: boolean, note: string) => void;
  onError?: (err: Error) => void;
}

interface Branch {
  id: string;
  parentId: string | null;
  forkTick: number;
  commands: Command[];
}

export class Runner {
  readonly keyframes = new KeyframeStore(30, 300);
  readonly marks: number[] = [];

  #source: StatsSource;
  #cache: AttrCache;
  #config: BattleConfig;
  #cb: RunnerCallbacks;
  #battle!: Battle;
  /**
   * 自愈补算出来的属性组合（key → 属性表），跨重算复用。
   *
   * `#prewarm` 命中即跳过，所以它同时起到"预热漏项补丁"的作用（见 `#rebuild`）。
   */
  #seed = new Map<string, FitStats>();
  #branches = new Map<string, Branch>();
  #current = "main";

  constructor(source: StatsSource, cache: AttrCache, config: BattleConfig, cb: RunnerCallbacks = {}) {
    this.#source = source;
    this.#cache = cache;
    this.#config = config;
    this.#cb = cb;
  }

  get state(): BattleState {
    return this.#battle.state;
  }

  get tick(): number {
    return this.#battle.state.tick;
  }

  get finished(): boolean {
    return this.#battle.state.finished;
  }

  /** 当前分支的完整命令表。 */
  get commands(): Command[] {
    return this.#branches.get(this.#current)?.commands ?? [];
  }

  get currentBranchId(): string {
    return this.#current;
  }

  branchList(): BranchInfo[] {
    return [...this.#branches.values()].map((b) => ({
      id: b.id, parentId: b.parentId, forkTick: b.forkTick, commandCount: b.commands.length,
    }));
  }

  async init(commands: Command[] = []): Promise<void> {
    this.#branches.set("main", { id: "main", parentId: null, forkTick: 0, commands: [...commands] });
    await this.#rebuild(0);
  }

  /** 新增/修改命令：立即重算到当前 tick（乐观响应，重算在 Worker 内完成）。 */
  async addCommand(cmd: Command): Promise<void> {
    return this.addCommands([cmd]);
  }

  /**
   * 批量新增命令：**只重算一次**。
   *
   * ★ V0.7 性能修复：批量舰队操作（给整支舰队下指令）会产生几十条命令，
   *   旧实现每条都各自 `#rebuild`（从 t=0 重建整场 + 推进到当前 tick），
   *   34 条命令就是 34 次整场重建 —— 表现为长时间"重算中"、界面整体卡死。
   *   现在把同一批命令合并进命令表后**只重建一次**。
   */
  async addCommands(cmds: Command[]): Promise<void> {
    if (cmds.length === 0) return;
    const b = this.#branches.get(this.#current)!;
    // 同 tick + 同 action + **同目标 + 同参数** 才算"覆盖"（改参/撤销），否则追加。
    //
    // ★ 去重键必须带上 target 与 params：小队/全体目标没有 unitId，
    //   旧实现只比 (tick, action, unitId)，于是同一 tick 下发的"逐实例"指令会互相覆盖——
    //   一支 6 舰小队点一次「盾全抗」本该产生 2 条指令（实例①、实例②），
    //   实际只剩最后 1 条落地，表现为"点一次只启用一半装备、要点三次才生效"。
    const keyOf = (c: Command): string => JSON.stringify([c.tick, c.action, c.target, c.params]);
    const before = b.commands;
    const replaced = new Set(cmds.map(keyOf));
    b.commands = before
      .filter((c) => !replaced.has(keyOf(c)))
      .concat(cmds)
      .sort((x, y) => x.tick - y.tick);
    try {
      await this.#rebuild(this.tick);
    } catch (err) {
      // ★ 重算失败 → 回滚命令表。否则这条"算不出来"的命令会永久留在表里，
      //   之后每一次重算都会再次失败（表现为整场再也推进不了）。
      b.commands = before;
      throw err;
    }
  }

  /** 删除最后一条命令（撤销）。 */
  async undo(): Promise<void> {
    const b = this.#branches.get(this.#current)!;
    b.commands.pop();
    await this.#rebuild(this.tick);
  }

  /** 记录关键标记（D-14 的交互入口）。 */
  mark(): number {
    const t = this.tick;
    if (!this.marks.includes(t)) this.marks.push(t);
    return t;
  }

  /** 载入存档时恢复标记。 */
  restoreMarks(marks: number[]): void {
    this.marks.length = 0;
    for (const m of marks) if (!this.marks.includes(m)) this.marks.push(m);
  }

  /** 回溯后修改 = 产生新分支（D-17）。 */
  async fork(atTick: number, id?: string): Promise<string> {
    const parent = this.#branches.get(this.#current)!;
    const branchId = id ?? `${parent.id}-b${this.#branches.size}`;
    this.#branches.set(branchId, {
      id: branchId,
      parentId: parent.id,
      forkTick: atTick,
      // ★ 保留 tick <= atTick 的命令：#rebuild(atTick) 会把 0..atTick 全部重放，
      //   本 tick 的命令本来就已作用于"tick=atTick 的状态"，用 < 会把它丢掉。
      //   后果：同一 tick 连发两条指令（如逐实例启停装备、批量换弹）时，
      //   第二条的 fork 会把第一条吃掉，表现为"点一次只生效一半、要点好几次"。
      commands: parent.commands.filter((c) => c.tick <= atTick),
    });
    this.#current = branchId;
    await this.#rebuild(atTick);
    return branchId;
  }

  async switchBranch(id: string): Promise<void> {
    if (!this.#branches.has(id)) throw new Error(`未知分支 ${id}`);
    this.#current = id;
    await this.#rebuild(this.tick);
  }

  /** 推演到指定 tick（向前或向后均可）。 */
  async seek(tick: number): Promise<void> {
    const target = Math.max(0, Math.round(tick));
    if (target < this.tick) {
      await this.#rebuild(target);
    } else if (target > this.tick) {
      this.#advance(target - this.tick);
    }
  }

  /** 连续推演 n 个 tick。 */
  run(n: number): void {
    this.#advance(n);
  }

  /**
   * 本次推演是否遇到了**未预热**的属性组合（占位属性表顶上，结果暂不精确）。
   * worker 在帧循环里发现它为真时，会排队一次 `heal()` 把缺口补齐并重放。
   */
  get needsHeal(): boolean {
    return this.#battle.missing.size > 0;
  }

  /**
   * 自愈：补齐运行期才出现的属性组合，并**从 t=0 重放**一次。
   *
   * 重放的确定性不变，因此自愈后的结果与"一开始就预热到该组合"完全一致。
   */
  async heal(): Promise<void> {
    if (!this.needsHeal) return;
    await this.#rebuild(this.tick);
  }

  #advance(n: number): void {
    this.#battle.run(n);
  }

  markKeyframeIfDue(): void {
    this.keyframes.record(this.state);
  }

  /**
   * 从 t=0 用当前分支的命令表重建，并推进到 untilTick。
   *
   * ★ V0.8 修复：**先在局部变量上构建，全部成功后才替换 `#battle`**。
   *   旧实现先把 `this.#battle` 换成新建的战场、再推进；一旦推进中途抛错
   *   （例如某个属性组合没预热到），`#battle` 就停在 t=0/半途 ——
   *   用户看到的就是"点一下暂停/播放，整个沙盘被重置了"。
   */
  async #rebuild(untilTick: number): Promise<void> {
    this.#cb.onBusy?.(true, "重算中…");
    try {
      // ★ 自愈循环：属性预热是**预测**（配装 × 状态位图 × 环境键），而它依赖一些
      //   运行期才确定的东西（`kind+实例序号` 要按当时的 actives 解析、指挥脉冲源被
      //   开启后才进入覆盖集合…）。旧实现一旦预测漏掉一个组合就在推演中途抛错，
      //   而推演抛错会让 worker 的帧循环停摆 → 用户看到"点一下整个界面卡死"。
      //   现在：漏掉的组合由引擎记录，这里用 PYFA 补算进 `#seed` 后**重放一次** ——
      //   因为重放从 t=0 开始，最终结果与"一开始就预热到"完全一致（确定性不变）。
      //   正常第 1 轮就齐；上限 3 轮只是防御性保险。
      for (let attempt = 0; ; attempt++) {
        const next = await Battle.create(
          this.#source, this.#cache, this.#config, this.commands, this.#seed,
        );
        this.keyframes.clear();
        this.keyframes.record(next.state);
        if (untilTick > 0) {
          // 分段推进并按指数稀释记录关键帧（快照是 structuredClone，安全）
          while (next.state.tick < untilTick && !next.state.finished) {
            const remain = untilTick - next.state.tick;
            const chunk = Math.min(remain, 30);
            next.run(chunk);
            this.keyframes.record(next.state);
          }
        }
        if (next.missing.size === 0 || attempt >= 2) {
          // 只有整段都成功了才切换 —— 失败时保留上一份完好战场
          this.#battle = next;
          break;
        }
        if (this.#cb.onBusy) {
          this.#cb.onBusy(true, `补齐属性组合（${next.missing.size} 项）并重放…`);
        }
        const filled = await Battle.warmMisses(
          this.#source, this.#cache, [...next.missing.values()],
        );
        for (const [k, v] of filled) this.#seed.set(k, v);
      }
    } catch (err) {
      this.#cb.onError?.(err as Error);
      throw err;
    } finally {
      this.#cb.onBusy?.(false, "");
    }
  }
}

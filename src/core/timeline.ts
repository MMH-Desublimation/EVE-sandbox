/**
 * 时间轴：关键帧、指数稀释、分支（交接文档 §7.7 / D-14~D-17）。
 *
 * - 回溯方式：**关键帧标记 + 前 3 分钟快照**，非连续回滚（D-14）。
 * - 自动检查点：存在，间隔随时间**指数稀释**（D-16）。
 * - 分支：回溯后修改产生**新分支**，UI 明确当前编辑哪条分支（D-17）。
 * - 快照实现：`structuredClone`，**禁止 JSON.stringify**（§7.7）。
 * - 关键帧必须包含 events，否则回溯丢日志 —— 我们的快照是整份 BattleState，天然包含。
 */
import type { Command } from "./commands.ts";
import type { BattleState } from "./state.ts";

/** 深拷贝快照。state 是纯数据，structuredClone 安全且快于 JSON 往返。 */
export function snapshot(state: BattleState): BattleState {
  return structuredClone(state);
}

export interface Keyframe {
  tick: number;
  snap: BattleState;
}

/** 关键帧存储，间隔随时间指数稀释（越久远越稀疏，节省内存）。 */
export class KeyframeStore {
  #keys: Keyframe[] = [];
  #base: number;
  #max: number;

  constructor(baseStepTicks = 30, maxKeys = 240) {
    this.#base = Math.max(1, baseStepTicks);
    this.#max = Math.max(8, maxKeys);
  }

  get size(): number {
    return this.#keys.length;
  }

  /** 当前 tick 处的记录间隔（指数稀释）。 */
  intervalAt(tick: number): number {
    const k = Math.max(0, Math.floor(Math.log2(tick / this.#base + 1)));
    return this.#base * 2 ** k;
  }

  shouldRecord(tick: number): boolean {
    if (tick === 0) return true;
    const step = this.intervalAt(tick);
    return tick % step === 0;
  }

  record(state: BattleState): void {
    if (!this.shouldRecord(state.tick)) return;
    this.#keys.push({ tick: state.tick, snap: snapshot(state) });
    this.#dilute();
  }

  /** 超出上限时，优先丢弃"较旧且与相邻间距过密"的关键帧。 */
  #dilute(): void {
    while (this.#keys.length > this.#max) {
      let dropAt = 1;
      let smallestGap = Infinity;
      for (let i = 1; i < this.#keys.length - 1; i++) {
        const gap = this.#keys[i + 1].tick - this.#keys[i - 1].tick;
        if (gap < smallestGap) {
          smallestGap = gap;
          dropAt = i;
        }
      }
      this.#keys.splice(dropAt, 1);
    }
  }

  /** 找到 <= tick 的最近关键帧。 */
  nearestAtOrBefore(tick: number): Keyframe | undefined {
    let best: Keyframe | undefined;
    for (const k of this.#keys) {
      if (k.tick <= tick && (!best || k.tick > best.tick)) best = k;
    }
    return best;
  }

  ticks(): number[] {
    return this.#keys.map((k) => k.tick);
  }

  clear(): void {
    this.#keys = [];
  }
}

/* -------------------------------------------------------------------------- */
/* 分支                                                                        */
/* -------------------------------------------------------------------------- */

export interface Branch {
  id: string;
  parentId: string | null;
  /** 从父分支分叉的时刻。 */
  forkTick: number;
  /** 本分支的完整命令表（= 父分支到 forkTick 的命令 + 本分支新增/替换的命令）。 */
  commands: Command[];
  createdAt: number;
}

/**
 * 时间轴管理。**命令表是时间线的唯一真源**，状态由 (初始快照 + 命令 + 种子) 重放得到。
 */
export class Timeline {
  readonly base: BattleState;
  #branches = new Map<string, Branch>();
  #current: string;

  constructor(initial: BattleState, branchId = "main") {
    this.base = snapshot(initial);
    this.#branches.set(branchId, {
      id: branchId, parentId: null, forkTick: 0, commands: [], createdAt: Date.now(),
    });
    this.#current = branchId;
  }

  get currentId(): string {
    return this.#current;
  }

  get current(): Branch {
    const b = this.#branches.get(this.#current);
    if (!b) throw new Error(`未知分支 ${this.#current}`);
    return b;
  }

  list(): Branch[] {
    return [...this.#branches.values()];
  }

  switchTo(id: string): void {
    if (!this.#branches.has(id)) throw new Error(`未知分支 ${id}`);
    this.#current = id;
  }

  /** 在当前分支追加命令（生效 tick 之前的命令保留）。 */
  addCommand(cmd: Command): void {
    const b = this.current;
    b.commands = b.commands.filter((c) => c.tick !== cmd.tick || c.action !== cmd.action).concat(cmd);
    b.commands.sort((x, y) => x.tick - y.tick);
  }

  /**
   * 回溯后修改 = 产生新分支（D-17）。
   * 新分支继承父分支在 forkTick 之前的命令，之后可写入新命令。
   */
  fork(atTick: number, newCommands: Command[] = [], id?: string): Branch {
    const parent = this.current;
    const branchId = id ?? `${parent.id}-b${this.#branches.size}`;
    const kept = parent.commands.filter((c) => c.tick < atTick);
    const branch: Branch = {
      id: branchId,
      parentId: parent.id,
      forkTick: atTick,
      commands: kept.concat(newCommands).sort((a, b) => a.tick - b.tick),
      createdAt: Date.now(),
    };
    this.#branches.set(branchId, branch);
    this.#current = branchId;
    return branch;
  }

  /** 撤销：删掉当前分支最后一条命令。 */
  undoLast(): Command | undefined {
    const b = this.current;
    return b.commands.pop();
  }
}

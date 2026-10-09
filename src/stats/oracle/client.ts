/**
 * StatOracle 客户端：常驻子进程 + JSON 行协议（契约 §4.4）。
 *
 * 职责边界：本层只负责「与 PYFA 子进程通信并拿到属性表」，不做任何 EVE 语义计算。
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FitStats } from "../../shared/contract.ts";
import type {
  CalcFitRequest,
  ResolveNamesResponse,
  OracleResponse,
} from "../../shared/protocol.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..", "..");

export interface OracleOptions {
  /** Python 3.14 解释器（必须与 PYFA 内嵌运行时同版本）。 */
  python: string;
  /** pyfa_oracle.py 路径。 */
  sidecar: string;
  /** PYFA 安装目录（含 pyfa.exe 与 app/）。 */
  pyfaDir: string;
  /** 无头核心的工作目录（提取产物缓存）。 */
  workDir: string;
  /** 处理 N 个请求后主动重启（0 = 不限制）。 */
  maxRequests?: number;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  onLog?: (line: string) => void;
}

/** 默认配置：优先取环境变量，便于迁移到其他机器。 */
export function defaultOracleOptions(): OracleOptions {
  return {
    python: process.env.PYFA_PYTHON ?? String.raw`C:\Users\admin\AppData\Local\Python\pythoncore-3.14-64\python.exe`,
    sidecar: process.env.PYFA_SIDECAR ?? resolve(PROJECT_ROOT, "sidecar", "pyfa_oracle.py"),
    pyfaDir: process.env.PYFA_DIR ?? String.raw`D:\eve  pyfa\pyfa`,
    workDir: process.env.PYFA_WORK_DIR ?? resolve(PROJECT_ROOT, ".pyfa-core"),
    maxRequests: Number(process.env.PYFA_MAX_REQUESTS ?? 0),
    readyTimeoutMs: 120_000, // 首次运行需提取核心，给足时间
    requestTimeoutMs: 30_000,
  };
}

interface Pending {
  resolve: (value: OracleResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class StatOracleClient {
  #opts: OracleOptions;
  #proc: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #pyfaVersion = "";
  #served = 0;
  #readyPromise: Promise<string> | null = null;

  constructor(options: Partial<OracleOptions> = {}) {
    this.#opts = { ...defaultOracleOptions(), ...options };
  }

  get pyfaVersion(): string {
    return this.#pyfaVersion;
  }

  get requestsServed(): number {
    return this.#served;
  }

  /** 启动子进程并等待就绪握手。 */
  async start(): Promise<string> {
    if (this.#readyPromise) return this.#readyPromise;
    this.#readyPromise = this.#spawnAndWait();
    return this.#readyPromise;
  }

  async #spawnAndWait(): Promise<string> {
    const opts = this.#opts;
    const args = [
      opts.sidecar,
      "--pyfa-dir", opts.pyfaDir,
      "--work-dir", opts.workDir,
    ];
    if (opts.maxRequests && opts.maxRequests > 0) {
      args.push("--max-requests", String(opts.maxRequests));
    }

    const proc = spawn(opts.python, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" },
    });
    this.#proc = proc;

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line: string) => this.#onLine(line));

    const errRl = createInterface({ input: proc.stderr });
    errRl.on("line", (line: string) => this.#opts.onLog?.(line));

    proc.on("exit", (code, signal) => this.#onExit(code, signal));
    proc.on("error", (err) => this.#failAll(err));

    return await new Promise<string>((resolveReady, rejectReady) => {
      const timer = setTimeout(
        () => rejectReady(new Error(`StatOracle 就绪超时（${opts.readyTimeoutMs}ms）`)),
        opts.readyTimeoutMs,
      );
      this.#onReady = (version: string) => {
        clearTimeout(timer);
        resolveReady(version);
      };
      this.#onReadyFail = (err: Error) => {
        clearTimeout(timer);
        rejectReady(err);
      };
    });
  }

  #onReady: ((version: string) => void) | null = null;
  #onReadyFail: ((err: Error) => void) | null = null;

  #onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: OracleResponse;
    try {
      msg = JSON.parse(text) as OracleResponse;
    } catch {
      this.#opts.onLog?.(`[client] 非法 JSON 行: ${text.slice(0, 200)}`);
      return;
    }

    if (msg.ready) {
      this.#pyfaVersion = msg.pyfaVersion ?? "";
      this.#onReady?.(this.#pyfaVersion);
      this.#onReady = null;
      this.#onReadyFail = null;
      return;
    }

    const id = msg.id;
    if (id === null || id === undefined) return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(msg);
  }

  #onExit(code: number | null, signal: string | null): void {
    const err = new Error(`StatOracle 子进程退出（code=${code}, signal=${signal}）`);
    if (this.#onReadyFail) {
      this.#onReadyFail(err);
      this.#onReadyFail = null;
    }
    this.#failAll(err);
  }

  #failAll(err: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }

  /** 发送一条请求并等待响应。 */
  async request<T extends OracleResponse>(payload: OraclePayload): Promise<T> {
    await this.start();
    const proc = this.#proc;
    if (!proc || proc.killed) throw new Error("StatOracle 未运行");

    const id = this.#nextId++;
    const timeoutMs = this.#opts.requestTimeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      pending?.reject(new Error(`StatOracle 请求超时（${timeoutMs}ms）`));
      // 超时视为子进程异常：重启，后续请求会重新拉起
      this.#restart();
    }, timeoutMs);

    const promise = new Promise<OracleResponse>((resolveP, rejectP) => {
      this.#pending.set(id, { resolve: resolveP, reject: rejectP, timer });
    });

    proc.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
    this.#served++;
    return (await promise) as T;
  }

  #restart(): void {
    const proc = this.#proc;
    if (!proc) return;
    this.#pyfaVersion = "";
    this.#readyPromise = null;
    proc.kill();
    this.#proc = null;
  }

  async calcFit(req: Omit<CalcFitRequest, "id" | "op">): Promise<FitStats> {
    const resp = await this.request<OracleResponse>({ op: "calcFit", ...req } as never);
    if (!resp.ok) {
      throw new Error(`calcFit 失败: ${resp.error?.code ?? "UNKNOWN"} ${resp.error?.message ?? ""}`);
    }
    const r = resp as unknown as FitStats;
    // ★ 整体透传，**不要白名单式挑字段**。
    //   白名单会静默丢掉新增字段 —— 曾经把 ship / implants / env 丢掉：
    //   吨位图标因此退回"船名正则"（恰好蒙对才没暴露），
    //   脑插与指挥脉冲的溯源信息也读不到。这里只对"可能缺失的数组"给默认值。
    return {
      ...r,
      weapons: r.weapons ?? [],
      actives: r.actives ?? [],
      passives: r.passives ?? [],
      drones: r.drones ?? [],
      fighters: r.fighters ?? [],
      unhandled: r.unhandled ?? [],
    };
  }

  /**
   * 指挥脉冲倍率表（PYFA 的 `getLinkMultiplier`）。
   * 引擎侧用自己实现的公式参与比较，这条接口用于**防漂移校验**：
   * 若 PYFA 升级后系数变了，测试会立刻发现。
   */
  async linkTable(): Promise<{ strengths: number[]; multiplier: Record<string, number> }> {
    const resp = await this.request<Record<string, unknown>>({ op: "linkTable" } as never);
    return resp as unknown as { strengths: number[]; multiplier: Record<string, number> };
  }

  async version(): Promise<string> {
    const resp = await this.request<OracleResponse>({ op: "version" } as never);
    return resp.pyfaVersion ?? "";
  }

  async ping(): Promise<boolean> {
    const resp = await this.request<OracleResponse>({ op: "ping" } as never);
    return Boolean((resp as { pong?: boolean }).pong);
  }

  async resolveNames(names: string[]): Promise<ResolveNamesResponse> {
    return await this.request<ResolveNamesResponse>({ op: "resolveNames", names } as never);
  }

  async stop(): Promise<void> {
    const proc = this.#proc;
    this.#proc = null;
    this.#readyPromise = null;
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((done) => {
      const t = setTimeout(() => {
        proc.kill();
        done();
      }, 3000);
      proc.once("exit", () => {
        clearTimeout(t);
        done();
      });
      proc.kill();
    });
  }
}

/** 请求体（不含 id，id 由客户端分配）。 */
export type OraclePayload = { op: string; [key: string]: unknown };

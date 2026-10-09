/**
 * 属性来源抽象。
 *
 * 引擎与驱动器只依赖这个最小接口，不关心底层是：
 *   - 生产环境：WebView2 宿主进程托管的 Python StatOracle 子进程；
 *   - 开发环境：Node 开发宿主的 HTTP 转发；
 *   - Worker 内部：由主线程代理的桥。
 * 这样引擎层可以原封不动地跑在 Worker / Node / 浏览器里。
 */
import type { FitStats } from "./contract.ts";
import type { CalcFitRequest } from "./protocol.ts";

export type CalcFitInput = Omit<CalcFitRequest, "id" | "op">;

export interface StatsSource {
  calcFit(req: CalcFitInput): Promise<FitStats>;
}

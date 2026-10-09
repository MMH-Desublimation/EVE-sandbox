/**
 * StatOracle 请求 / 响应协议（对应 docs/第4章-PYFA集成协议-冻结稿.md §4.4）。
 * 与 sidecar/pyfa_oracle.py 严格对应。
 */
import type { FitStats, ModuleState } from "./contract.ts";

/** 条目引用：typeId 或 name 二选一。 */
export interface ItemRef {
  typeId?: number;
  name?: string;
}

export interface ModuleSpec {
  /** 槽位提示（hi/med/lo/rig），仅用于展示；PYFA 按模块自身属性落位。 */
  slot?: "hi" | "med" | "lo" | "rig";
  typeId?: number;
  name?: string;
  state?: ModuleState;
  chargeTypeId?: number;
  chargeName?: string;
}

export interface DroneSpec {
  typeId?: number;
  name?: string;
  count?: number;
}

export interface FighterSpec {
  typeId?: number;
  name?: string;
  /** **发射管数**：一个发射管 = 一个纵队（D-27）。 */
  count?: number;
}

/**
 * 脑插（技能植入体）。
 *
 * ★ 用户的规则：**配置里有脑插才算，没有就不算**。
 *   PYFA 侧挂在 **Fit** 上（`fit.implants`，不是 Character），
 *   整套（Alpha~Omega）才会触发套装加成；只装单件只有很小加成。
 */
export interface ImplantSpec {
  typeId?: number;
  name?: string;
  /** 植入体槽位 1..6；缺省由 PYFA 依条目自判。 */
  slot?: number;
}

/**
 * 指挥脉冲（Command Burst /  Warfare Link）环境加成。
 *
 * 实战中一般堆到极限：满级技能 + 指挥舰船体加成 + 指挥脉冲脑插。
 * 这三者都被 PYFA 折算进 `getLinkMultiplier(strength, mindlink)`：
 *   · `strength` 5 = 指挥舰/T3 + 满级技能（0..5）
 *   · `mindlink` = 是否带指挥脉冲脑插
 * `linkType` 必须是 PYFA `COMMAND_LINK_DEFS` 里的合法键（如 `armor_energizing`），
 * 否则会被记为 unhandled（不静默失败）。
 */
export interface CommandLinkSpec {
  linkType: string;
  strength: number;
  mindlink: boolean;
}

export interface EnvSpec {
  /** 环境加成：指挥脉冲。为空 = 无环境加成。 */
  commandLinks?: CommandLinkSpec[];
}

export interface CalcFitRequest {
  id: number;
  op: "calcFit";
  ship: ItemRef;
  skills?: "all5";
  modules?: ModuleSpec[];
  drones?: DroneSpec[];
  fighters?: FighterSpec[];
  implants?: ImplantSpec[];
  env?: EnvSpec;
}

export interface VersionRequest {
  id: number;
  op: "version";
}

export interface PingRequest {
  id: number;
  op: "ping";
}

export interface ResolveNamesRequest {
  id: number;
  op: "resolveNames";
  names: string[];
}

export type OracleRequest =
  | CalcFitRequest
  | VersionRequest
  | PingRequest
  | ResolveNamesRequest;

export interface OracleError {
  code: string;
  message: string;
  detail?: unknown;
  traceback?: string;
}

export interface ResponseBase {
  id: number | null;
  ok: boolean;
  error?: OracleError;
  /** 子进程启动后的就绪握手行。 */
  ready?: boolean;
  pyfaVersion?: string;
}

export interface CalcFitResponse extends ResponseBase, Partial<FitStats> {
  op?: "calcFit";
}

export interface VersionResponse extends ResponseBase {
  pyfaVersion: string;
}

export interface PingResponse extends ResponseBase {
  pong: boolean;
}

export interface ResolveNamesResponse extends ResponseBase {
  resolved: Record<string, { typeId: number; groupID: number | null }>;
  missing: string[];
}

export type OracleResponse =
  | CalcFitResponse
  | VersionResponse
  | PingResponse
  | ResolveNamesResponse;

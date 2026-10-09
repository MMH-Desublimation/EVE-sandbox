/**
 * 战场沙盘（Canvas，§8.1 中央栏 / §8.4 交互）。
 *
 * 交互：**左键拖动 = 平移视野**（V0.7 起）、左键点选、Ctrl+左键框选、
 * 中键拖动平移、右键指令、滚轮缩放。
 * 但不照搬"停止"语义 —— 停止只停机动、火力继续（由指令面板用不同文案区分）。
 *
 * 性能（§8.7）：每帧重绘必要，但**图标按 key|color 缓存**（icons.ts），
 * 且只在需要时绘制文字标签。
 *
 * ★ V0.7.2 运动平滑：引擎 1 tick = 1 秒游戏时间、单位帧约 20 Hz，
 *   直接按帧坐标画就会出现"一节一节跳"。
 *
 *   上一版用**单点速度外推**（dead reckoning）：位置 = 帧坐标 + 速度 × 帧后时间。
 *   问题是引擎每个 tick 内是"加速度收敛"运动（见 geometry.stepMovement）：船在
 *   加速 / 转向时，用 tick 末速度线性延拓的轨迹与下一个 tick 的真值对不上，
 *   于是每到一个 tick 边界就被"拽"一下 —— 观感正是"一小节一小节卡过去"。
 *
 *   这一版改成**相邻两个 tick 快照之间的三次 Hermite 插值**：
 *   位置 = H(prev.x, prev.vx, cur.x, cur.vx, α)，两端既穿过真值点、切线又等
 *   于各自速度，所以跨 tick 边界不会有折角/回拉。α 由"上一 tick 帧到达 →
 *   本 tick 帧到达"这段真实时间归一化得到，倍速变化与 worker 追帧都能自动跟上。
 *
 *   代价：画面比引擎真值晚约一个 tick（4× 下 250ms）。暂停 / 重算 / 结束时不
 *   插值，直接画当前真值。
 */
import type { CelestialFrame, UnitFrame } from "../protocol.ts";
import { empireColor, ICON_TINT_MODE, iconClassOf, type IconClass } from "../../shared/hullclass.ts";
import { iconSize, tintedIcon } from "../util/icons.ts";
import { IconSeparation } from "./separation.ts";

export interface MapCallbacks {
  onSelect(ids: string[], additive: boolean): void;
  onContextMenu(screenX: number, screenY: number, unitId: string | null, world: { x: number; y: number }): void;
}

interface View {
  /** 屏幕中心对应的世界坐标（米）。 */
  cx: number;
  cy: number;
  /** 缩放：像素 / 米。 */
  scale: number;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** 沙盘叠加层开关（右上角工具条 / §8.4）。 */
export interface OverlayFlags {
  grid: boolean;
  rings: boolean;
  ewLines: boolean;
}

/**
 * 一个 tick 的运动快照（位置 + 速度），用于相邻 tick 之间的 Hermite 插值。
 *
 * 速度单位 m/s，而 1 tick = 1 秒游戏时间（core/sim.ts `TICK_MS`），
 * 所以 Hermite 切线长度正好等于速度数值本身，无需再乘时长。
 */
interface Snap {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const DEFAULT_SIDE_COLORS = ["#3aa0ff", "#ff5a4d"];
/** 势力扩展后自动补色（第 3、4… 方势力）。 */
const EXTRA_SIDE_COLORS = [
  "#54d98c", "#ffd24a", "#c9a6ff", "#ff9f45",
  "#4fd6e0", "#ff7fb0", "#a8b6c8", "#d4e157",
];

/** 电子战连线的颜色（按效果种类）。 */
function ewColor(kind: string): string {
  switch (kind) {
    case "web": return "rgba(140,224,255,0.55)";
    case "grappler": return "rgba(140,224,255,0.45)";
    case "painter": return "rgba(255,190,90,0.55)";
    case "damp": return "rgba(201,166,255,0.55)";
    case "ecm": return "rgba(255,240,120,0.55)";
    case "neut": return "rgba(255,130,190,0.55)";
    case "nos": return "rgba(190,140,255,0.5)";
    case "trackDisrupt": return "rgba(120,255,235,0.5)";
    case "guidanceDisrupt": return "rgba(120,255,235,0.4)";
    case "warpDisrupt": case "warpScramble": return "rgba(255,110,110,0.6)";
    case "bubble": return "rgba(255,90,90,0.35)";
    default: return "rgba(200,210,230,0.4)";
  }
}

/** 选中单位的环颜色：锁定 = 橙、最佳射程 = 绿、有效射程 = 浅绿虚（用户指定风格）。 */
const LOCK_RING_COLOR = "#ffa94d";
const RANGE_RING_COLOR = "#7fe08a";
const EFFECTIVE_RING_COLOR = "#b9f0c4";

/**
 * 缩放上下限。
 * 1 AU = 1.496e11 m，所以默认的 17.5 AU 星系半径是 **2.617e12 m**、直径 5.23e12 m；
 * 要在约 1000px 宽的画面里把它整个装下需要 scale ≈ 1.8e-10。
 * 早先下界写成 1e-9（注释里误把 17.5 AU 当成 2.6e9 m），比所需还大约 6 倍，
 * 于是「适应星系」永远缩不到位：星系是装下了（缩到极限），但舰队（几十 km）
 * 被压成亚像素，看起来就是"沙盘里一条船都没有"。
 */
const MIN_SCALE = 1e-12;
/**
 * 最大视距（像素/米）。
 *
 * ★ V0.9：0.05 → **1**（1 px = 1 m）。旧上限下放到最大也只有 ~20 km 视野跨度，
 *   舰队一密集就完全看不清单舰；现在可以一直放大到"看得清每一艘船"。
 */
const MAX_SCALE = 1;


function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY),
  };
}

/** 距离显示：AU / km / m 三档，避免出现 "17500000000 m" 这种读不出来的数字。 */
export function formatDist(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "0 m";
  if (m >= 1_000_000_000) return `${(m / 149_597_870_700).toFixed(2)} AU`;
  if (m >= 1_000_000) return `${(m / 1000).toFixed(0)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

export class BattleMap {
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #units: UnitFrame[] = [];
  #byId = new Map<string, UnitFrame>();
  #view: View = { cx: 0, cy: 0, scale: 0.00035 };
  #selected = new Set<string>();
  #cb: MapCallbacks;
  #dragging: { x: number; y: number; moved: boolean } | null = null;
  #boxSel: { x0: number; y0: number; x1: number; y1: number } | null = null;
  #panning = false;
  #lastPointer = { x: 0, y: 0 };
  #dpr = 1;
  /** 图标碰撞分离（纯显示层偏移，绝不改引擎坐标）。 */
  #sep = new IconSeparation();
  #celestials: CelestialFrame[] = [];
  #lastMs = 0;

  /* --- V0.7：tick 快照插值 / 势力配色 / 叠加层 / 星系边界 --- */
  /** 最近一次**帧到达**的时刻（首帧兜底用）。 */
  #frameAtMs = 0;
  /** 本 tick 帧到达的时刻：即"上一 tick 帧到达 → 本 tick 帧到达"这段区间的右端。 */
  #tickAtMs = 0;
  /** 上一 tick 帧到达的时刻：区间左端。两者之差就是一个 tick 的真实时长。 */
  #prevAtMs = 0;
  /** 一拍时长的指数滑动平均（ms）：0 = 还没样本，用 `1000/倍速` 兜底。 */
  #spanEma = 0;
  /** 上一 tick 的单位快照（含速度），渲染时在它和当前帧之间插值。 */
  #prev = new Map<string, Snap>();
  /** 上一 tick 的舰载机 / 无人机快照（它们各自机动，要独立插值）。 */
  #prevGroups = new Map<string, Snap>();
  #tick = -1;
  #speed = 0;
  #playing = false;
  #sideColors: string[] = [...DEFAULT_SIDE_COLORS];
  #overlay: OverlayFlags = { grid: true, rings: true, ewLines: false };
  #systemRadiusM = 0;

  /* --- 渲染自检计数（仅统计，不改变绘制结果；供自动验收断言） --- */
  /** 本帧实际画出的**环**数量（单选：锁定 + 最佳 + 有效 = 3；框选 0）。 */
  #ringsDrawn = 0;
  /** 本帧实际画出的**舰船名字**数量（用户要求为 0 —— 沙盘只显示图标）。 */
  #labelsDrawn = 0;
  /** 是否在图标旁写舰船名字（用户要求关闭；保留开关便于排障，见 `renderStats`）。 */
  #showUnitNames = false;

  /* -------------------------------------------------- 显示位置（含分离偏移） */

  /** 图标类别：优先用帧里由 SDE 判定的值，缺失时按船名兜底。 */
  #iconClassOf(u: UnitFrame): IconClass {
    if (u.icon && u.icon !== "unknown") return u.icon as IconClass;
    return iconClassOf(null, u.shipName);
  }

  #iconHalf(u: UnitFrame): number {
    return iconSize(this.#iconClassOf(u));
  }

  /** 图标染色：默认按本沙盒的势力，可切换到 EVE 帝国色。 */
  #colorOf(u: UnitFrame): string {
    if (ICON_TINT_MODE === "empire") return empireColor(u.empire);
    return this.#sideColor(u.sideId);
  }

  /** 势力色（支持任意多方势力：超出预设就按补色表循环）。 */
  #sideColor(sideId: number): string {
    if (sideId < this.#sideColors.length) return this.#sideColors[sideId];
    const extra = EXTRA_SIDE_COLORS;
    return extra[(sideId - this.#sideColors.length) % extra.length] ?? "#cccccc";
  }

  /**
   * 插值进度 α：把「上一 tick 帧到达 → 本 tick 帧到达」这段真实时间当作 1，
   * 当前时刻落在这一段里的比例就是 α。
   *
   * ★ 用**实测**的两拍间隔当分母（而不是 `1000/倍速` 推算）：倍速切换、
   *   worker 追帧（一次推进多个 tick）都能立刻跟上。
   * ★ α 允许略微超过 1（上限 2），超出部分由 `#trackPos` 用当前速度做短距
   *   线性延拓 —— 若死钉在 1，下一拍帧到得稍晚时画面就会"冻住半拍"，
   *   观感反而是卡顿。
   *
   * 暂停 / 重算中 / 结束 / 没有上一 tick 快照 → 返回 1，即直接画当前真值。
   */
  #interpAlpha(): number {
    if (!this.#playing || this.#speed <= 0) return 1;
    if (this.#prev.size === 0) return 1;
    const span = this.#spanMs();
    if (this.#tickAtMs <= 0 || span <= 0) return 1;
    const a = (performance.now() - this.#tickAtMs) / span;
    return a <= 0 ? 0 : a >= 1.5 ? 1.5 : a;
  }

  /**
   * 一拍（两个相邻 tick 帧之间）的真实时长，毫秒。
   *
   * 用**实测值的指数滑动平均**而不是单次实测：单次实测会被"帧格"抖动
   * （20Hz 发帧 vs 60Hz 采样，±半个帧间隔）带偏，直接用会让每帧步长忽大忽小；
   * 平均之后既贴合真实拍长，步长又稳定。倍速切换时由 `setClock` 立即重置为
   * 名义值 `1000/倍速`，不会有"分母还没适应"的过渡期。
   */
  #spanMs(): number {
    if (this.#spanEma > 0) return this.#spanEma;
    return 1000 / Math.max(0.0001, this.#speed);
  }

  /**
   * 三次 Hermite 插值：p(0)=p0、p'(0)=v0、p(1)=p1、p'(1)=v1。
   * 位置与切线都对齐两个 tick 的真值，跨 tick 边界不会出现折角。
   */
  #hermite(p0: number, v0: number, p1: number, v1: number, t: number): number {
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p0      // h00
      + (t3 - 2 * t2 + t) * v0             // h10：切线长度 = 速度 × 1 秒游戏时间
      + (-2 * t3 + 3 * t2) * p1            // h01
      + (t3 - t2) * v1;                    // h11
  }

  /**
   * 一维轨迹取值：α ≤ 1 走 Hermite（穿过前后两拍真值），
   * α > 1 沿本拍速度短距线性延拓（最多约一个帧间隔，误差可忽略）。
   */
  #trackPos(p0: number, v0: number, p1: number, v1: number, a: number): number {
    return a <= 1 ? this.#hermite(p0, v0, p1, v1, a) : p1 + v1 * (a - 1);
  }

  /** 插值后的世界坐标（未加图标分离偏移）。 */
  #posX(u: UnitFrame): number {
    const a = this.#interpAlpha();
    const p = this.#prev.get(u.id);
    return p ? this.#trackPos(p.x, p.vx, u.x, u.vx, a) : u.x;
  }

  #posY(u: UnitFrame): number {
    const a = this.#interpAlpha();
    const p = this.#prev.get(u.id);
    return p ? this.#trackPos(p.y, p.vy, u.y, u.vy, a) : u.y;
  }

  /** 显示坐标 = 插值坐标 + 分离偏移。 */
  #displayX(u: UnitFrame): number {
    return this.#posX(u) + this.#sep.offsetOf(u.id).ox;
  }

  #displayY(u: UnitFrame): number {
    return this.#posY(u) + this.#sep.offsetOf(u.id).oy;
  }

  constructor(canvas: HTMLCanvasElement, cb: MapCallbacks) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d", { alpha: false })!;
    this.#cb = cb;
    this.#bindEvents();
    this.#resize();
    const loop = () => {
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  get selected(): ReadonlySet<string> {
    return this.#selected;
  }

  setSelection(ids: Iterable<string>): void {
    this.#selected = new Set(ids);
  }

  /** 把一批单位帧压成 (id → 位置+速度) 快照。 */
  #snapshotOf(units: UnitFrame[]): Map<string, Snap> {
    const m = new Map<string, Snap>();
    for (const u of units) m.set(u.id, { x: u.x, y: u.y, vx: u.vx, vy: u.vy });
    return m;
  }

  /**
   * 组的**全局唯一键**。
   *
   * ★ 组的 id 是"母舰内局部编号"（`d:<typeId>:<序号>`），**不是全局唯一** ——
   *   12 艘船各带一组同型无人机时，组 id 全是 `d:2478:0`。若只拿它当键，
   *   插值快照会互相覆盖，渲染时就会把 A 船无人机的上一拍位置配到 B 船无人机上，
   *   视觉上就是"图标乱闪、忽聚忽散"。必须拼上母舰 id 才唯一。
   */
  #groupKey(hostId: string, groupId: string): string {
    return `${hostId}#${groupId}`;
  }

  /** 舰载机 / 无人机快照（键 = 母舰 id + 组 id，保证全局唯一，可单独成表）。 */
  #groupSnapshotOf(units: UnitFrame[]): Map<string, Snap> {
    const m = new Map<string, Snap>();
    for (const u of units) {
      for (const gl of u.groups ?? []) {
        m.set(this.#groupKey(u.id, gl.id), { x: gl.x, y: gl.y, vx: gl.vx, vy: gl.vy });
      }
    }
    return m;
  }

  /**
   * 收帧。
   *
   * ★ `tick` 用来判定引擎是否又推进了一 tick：帧以 20Hz 发出、引擎 tick 在 speed=4
   *   时只有 4Hz，同一个 tick 会重复发好几帧，**只有 tick 变化才算新的一拍**。
   *
   *   新的一拍到来时，把**当前帧**整体滚成"上一 tick 快照"，并记下上一拍的到达时刻；
   *   渲染就一直在 (上一拍 → 本拍) 之间插值，跨拍的轨迹因此连续。
   *   tick 回退（终止 / 载入 / 重算重放）时丢掉历史，直接贴真值。
   */
  setUnits(units: UnitFrame[], tick = -1): void {
    const now = performance.now();
    if (tick !== this.#tick) {
      if (tick > this.#tick) {
        this.#prev = this.#snapshotOf(this.#units);
        this.#prevGroups = this.#groupSnapshotOf(this.#units);
        this.#prevAtMs = this.#tickAtMs;
        this.#learnSpan(now - this.#tickAtMs);
      } else {
        this.#prev.clear();
        this.#prevGroups.clear();
        this.#prevAtMs = 0;
        this.#spanEma = 0;
      }
      this.#tick = tick;
      this.#tickAtMs = now;
    } else if (this.#tickAtMs === 0) {
      this.#tickAtMs = now;
    }
    this.#frameAtMs = now;
    this.#units = units;
    this.#byId.clear();
    for (const u of units) this.#byId.set(u.id, u);
  }

  /** 用刚测到的一拍时长更新滑动平均；明显是追帧/回退的离谱值直接忽略。 */
  #learnSpan(measured: number): void {
    const nominal = 1000 / Math.max(0.0001, this.#speed);
    if (!(measured > nominal * 0.25) || measured > nominal * 8) return;
    this.#spanEma = this.#spanEma > 0 ? this.#spanEma * 0.65 + measured * 0.35 : measured;
  }

  /**
   * 同步引擎时钟。
   *
   * 是否插值取决于"有没有在跑"：暂停 / 重算 / 结束一律直接画当前真值，
   * 避免把重算后的新状态跟旧快照混起来插。
   * 倍速变化时立即把拍长基准重置为名义值，免得用旧档位的拍长去插新档位。
   */
  setClock(speed: number, playing: boolean): void {
    if (speed !== this.#speed) {
      this.#spanEma = speed > 0 ? 1000 / speed : 0;
    }
    this.#speed = speed;
    this.#playing = playing;
  }

  setCelestials(list: CelestialFrame[]): void {
    this.#celestials = list;
  }

  /** 势力配色（支持新增势力：第 3 方起自动补色）。 */
  setSideColors(colors: string[]): void {
    this.#sideColors = colors.length > 0 ? [...colors] : [...DEFAULT_SIDE_COLORS];
  }

  setOverlay(flags: Partial<OverlayFlags>): void {
    this.#overlay = { ...this.#overlay, ...flags };
  }

  get overlay(): Readonly<OverlayFlags> {
    return this.#overlay;
  }

  /** 星系半径（米），0 = 不画边界圈。 */
  setSystemRadius(radiusM: number): void {
    this.#systemRadiusM = radiusM;
  }

  /**
   * 适应画面：把视野收到**所有存活单位**上。
   *
   * 地物只在"不会把视野拉得过远"时才纳入 —— 否则开局就被 17.5 AU 外的星门
   * 拽出去，舰队缩成一小团，根本看不清阵型。
   */
  fit(): void {
    const u = this.#unitBounds();
    if (!u) {
      this.fitSystem();
      return;
    }
    const b: Bounds = { ...u };
    const spanX = Math.max(1, b.maxX - b.minX);
    const spanY = Math.max(1, b.maxY - b.minY);
    for (const c of this.#celestials) {
      const nx0 = Math.min(b.minX, c.x - c.radiusM);
      const nx1 = Math.max(b.maxX, c.x + c.radiusM);
      const ny0 = Math.min(b.minY, c.y - c.radiusM);
      const ny1 = Math.max(b.maxY, c.y + c.radiusM);
      if (nx1 - nx0 <= spanX * 1.7 && ny1 - ny0 <= spanY * 1.7) {
        b.minX = nx0; b.maxX = nx1; b.minY = ny0; b.maxY = ny1;
      }
    }
    this.#fitBounds(b, 1.35);
  }

  /** 适应星系：连星门等**地物**一起收进来（右上角工具条）。 */
  fitSystem(): void {
    const u = this.#unitBounds();
    const c = this.#celestialBounds();
    this.#fitBounds(u && c ? unionBounds(u, c) : (u ?? c), 1.15);
  }

  /**
   * 聚焦选定目标（右上角工具条）：保持缩放，把选中单位挪到屏幕中心。
   * 没选中任何单位时返回 false，由调用方决定怎么提示。
   */
  focusSelection(): boolean {
    const b = this.#unitBounds(this.#selected);
    if (!b) return false;
    this.#view.cx = (b.minX + b.maxX) / 2;
    this.#view.cy = (b.minY + b.maxY) / 2;
    return true;
  }

  /** 按星系半径（米）取景：默认视野就是一个 17.5 AU 的圆。 */
  fitRadius(radiusM: number): void {
    this.#fitBounds({ minX: -radiusM, maxX: radiusM, minY: -radiusM, maxY: radiusM }, 1.06);
  }

  /** 当前视野宽度（米）——右上角显示"视野 ≈ n AU"用。 */
  viewSpanM(): number {
    return this.#canvas.clientWidth / this.#view.scale;
  }

  /**
   * 取景参数快照（只读，供自检/验收判断"拖动是否真的改变了视野"）。
   * 不暴露可变引用，避免外部绕过交互直接改视图。
   */
  viewState(): { cx: number; cy: number; scale: number } {
    return { cx: this.#view.cx, cy: this.#view.cy, scale: this.#view.scale };
  }

  /**
   * 当前**落在画布可视范围内**的存活单位数（自检/验收用）。
   * 单位数 > 0 但这里为 0，就是"数据在、画面里看不见"（取景塌陷 / 缩到亚像素）。
   */
  onScreenUnitCount(padPx = 8): number {
    const cw = this.#canvas.clientWidth;
    const ch = this.#canvas.clientHeight;
    // 画布被隐藏（不在推演页）时尺寸为 0，此时谈"看得见"没有意义，直接返回 0，
    // 免得坐标退化后算出一堆假阳性。
    if (cw <= 0 || ch <= 0) return 0;
    let n = 0;
    for (const u of this.#units) {
      if (!u.alive || u.evac) continue;
      const sx = this.#worldToScreenX(this.#displayX(u));
      const sy = this.#worldToScreenY(this.#displayY(u));
      if (sx >= -padPx && sy >= -padPx && sx <= cw + padPx && sy <= ch + padPx) n++;
    }
    return n;
  }

  /**
   * 最近一帧的**渲染自检**结果（供自动验收断言绘制行为本身，而不只是数据）。
   *
   * - `ringsDrawn`：本帧实际画出的锁定/射程环数量。单选中单位 = 2，框选 = 0。
   * - `labelsDrawn`：本帧实际画出的舰船名字数量（用户要求恒为 0）。
   * - `unitNames`：名字开关当前是否打开（默认关）。
   */
  renderStats(): { ringsDrawn: number; labelsDrawn: number; unitNames: boolean } {
    return { ringsDrawn: this.#ringsDrawn, labelsDrawn: this.#labelsDrawn, unitNames: this.#showUnitNames };
  }

  /**
   * 场上存活组（无人机 / 铁骑）的**全局唯一键**列表（`<母舰id>#<组id>`）。
   * 流畅度验收要靠它拿到"具体某一个组"的句柄，才能采样"无人机图标是否平滑移动"。
   */
  groupIds(): string[] {
    const ids: string[] = [];
    for (const u of this.#units) {
      if (!u.alive || u.evac) continue;
      for (const grp of u.groups ?? []) if (grp.alive) ids.push(this.#groupKey(u.id, grp.id));
    }
    return ids;
  }

  /**
   * 立即重算画布尺寸。
   * 分页切换后画布从 display:none 变为可见，clientWidth 由 0 变正，
   * 需要主动同步一次 backing store，否则会先闪一帧错位的画面。
   */
  resize(): void {
    this.#resize();
  }

  #unitBounds(ids?: ReadonlySet<string>): Bounds | null {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let any = false;
    for (const u of this.#units) {
      if (!u.alive || u.evac) continue;
      if (ids && !ids.has(u.id)) continue;
      any = true;
      const x = this.#posX(u), y = this.#posY(u);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return any ? { minX, maxX, minY, maxY } : null;
  }

  #celestialBounds(): Bounds | null {
    if (this.#celestials.length === 0) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of this.#celestials) {
      minX = Math.min(minX, c.x - c.radiusM); maxX = Math.max(maxX, c.x + c.radiusM);
      minY = Math.min(minY, c.y - c.radiusM); maxY = Math.max(maxY, c.y + c.radiusM);
    }
    return { minX, maxX, minY, maxY };
  }

  #fitBounds(b: Bounds | null, pad: number): void {
    if (!b || !Number.isFinite(b.minX)) return;
    const w = Math.max(20000, b.maxX - b.minX);
    const h = Math.max(20000, b.maxY - b.minY);
    const cw = this.#canvas.clientWidth;
    const ch = this.#canvas.clientHeight;
    this.#view.cx = (b.minX + b.maxX) / 2;
    this.#view.cy = (b.minY + b.maxY) / 2;
    // 下界要能装下 17.5 AU 星系（≈1.8e-10），见 MIN_SCALE 的说明
    this.#view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
      Math.min(cw / (w * pad), ch / (h * pad))));
  }

  zoomBy(factor: number, screenX?: number, screenY?: number): void {
    const before = screenX !== undefined && screenY !== undefined
      ? this.#screenToWorld(screenX, screenY)
      : null;
    this.#view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.#view.scale * factor));
    if (before && screenX !== undefined && screenY !== undefined) {
      const after = this.#screenToWorld(screenX, screenY);
      this.#view.cx += before.x - after.x;
      this.#view.cy += before.y - after.y;
    }
  }

  /* ------------------------------------------------------------ 坐标变换 */

  #screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const cw = this.#canvas.clientWidth;
    const ch = this.#canvas.clientHeight;
    return {
      x: this.#view.cx + (sx - cw / 2) / this.#view.scale,
      y: this.#view.cy + (sy - ch / 2) / this.#view.scale,
    };
  }

  #worldToScreenX(wx: number): number {
    return (wx - this.#view.cx) * this.#view.scale + this.#canvas.clientWidth / 2;
  }

  #worldToScreenY(wy: number): number {
    return (wy - this.#view.cy) * this.#view.scale + this.#canvas.clientHeight / 2;
  }

  /* -------------------------------------------------------------- 事件 */

  #bindEvents(): void {
    const c = this.#canvas;
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      // ★ V0.9：每格 1.15 → 1.30。缩放上限与下限之间跨了 12 个数量级，
      //   旧步长要 50+ 格才能从"适应全体"放到最大，手感极差。
      this.zoomBy(e.deltaY < 0 ? 1.3 : 1 / 1.3, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    c.addEventListener("mousedown", (e) => {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      if (e.button === 0) {
        if (e.ctrlKey || e.metaKey) {
          // Ctrl + 左键 = 框选（V0.7 起左键拖动改为平移，框选让位给 Ctrl）
          this.#boxSel = { x0: sx, y0: sy, x1: sx, y1: sy };
        } else {
          // 左键先当"可能是平移"处理：抬起时若一次都没移动过，才算点选。
          // 这样"拖动平移"和"点选单位"共用左键，且不会误触发点选。
          this.#dragging = { x: sx, y: sy, moved: false };
          this.#lastPointer = { x: sx, y: sy };
        }
      } else if (e.button === 1) {
        this.#panning = true;
        this.#lastPointer = { x: sx, y: sy };
        e.preventDefault();
      }
    });

    window.addEventListener("mousemove", (e) => {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      if (this.#boxSel) {
        this.#boxSel.x1 = sx;
        this.#boxSel.y1 = sy;
        return;
      }
      const btnDrag = this.#dragging;
      // ★ 只有"确实没有任何手势在做"才直接返回。
      //   曾经写成 `if (!btnDrag?.moved && !this.#panning) return;` —— 左键刚按下时
      //   `btnDrag.moved` 还是 false、中键平移也没开始，于是**每一次 mousemove 都在
      //   这里被挡掉**，下面的"超过 4px 判定 → moved=true → 平移"永远执行不到，
      //   结果就是"鼠标按着左键拖不动沙盘"（V0.7 把左键改成平移后引入的回归）。
      if (!btnDrag && !this.#panning) return;
      // 超过 4px 才算"拖动"，避免手抖把点选吃掉
      if (btnDrag && !btnDrag.moved) {
        if (Math.hypot(sx - btnDrag.x, sy - btnDrag.y) <= 4) return;
        btnDrag.moved = true;
        c.style.cursor = "grabbing";
      }
      const dx = sx - this.#lastPointer.x;
      const dy = sy - this.#lastPointer.y;
      this.#lastPointer = { x: sx, y: sy };
      this.#view.cx -= dx / this.#view.scale;
      this.#view.cy -= dy / this.#view.scale;
    });

    window.addEventListener("mouseup", (e) => {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;

      if (this.#boxSel) {
        const b = this.#boxSel;
        this.#boxSel = null;
        const ids = this.#unitsInBox(b).map((u) => u.id);
        this.#cb.onSelect(ids, true);
        return;
      }
      if (this.#panning) {
        this.#panning = false;
        c.style.cursor = "";
        return;
      }
      if (this.#dragging) {
        const moved = this.#dragging.moved;
        this.#dragging = null;
        c.style.cursor = "";
        if (!moved && e.button === 0) {
          const hit = this.#pick(sx, sy);
          this.#cb.onSelect(hit ? [hit.id] : [], false);
        }
      }
    });

    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const hit = this.#pick(sx, sy);
      this.#cb.onContextMenu(e.clientX, e.clientY, hit?.id ?? null, this.#screenToWorld(sx, sy));
    });

    window.addEventListener("resize", () => this.#resize());
  }

  #resize(): void {
    this.#dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = this.#canvas;
    c.width = Math.max(1, Math.floor(c.clientWidth * this.#dpr));
    c.height = Math.max(1, Math.floor(c.clientHeight * this.#dpr));
  }

  #unitsInBox(b: { x0: number; y0: number; x1: number; y1: number }): UnitFrame[] {
    const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
    const y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
    return this.#units.filter((u) => {
      if (!u.alive || u.evac) return false;
      // 用**显示位置**：分离后的图标在哪里，就在哪里被框到
      const sx = this.#worldToScreenX(this.#displayX(u));
      const sy = this.#worldToScreenY(this.#displayY(u));
      return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
    });
  }

  #pick(sx: number, sy: number): UnitFrame | null {
    let best: UnitFrame | null = null;
    let bestD = Infinity;
    for (const u of this.#units) {
      if (!u.alive || u.evac) continue;
      // 命中判定同样用**显示位置**，并至少给到图标本身的大小
      const dx = this.#worldToScreenX(this.#displayX(u)) - sx;
      const dy = this.#worldToScreenY(this.#displayY(u)) - sy;
      const d = Math.hypot(dx, dy);
      const hit = Math.max(10, this.#iconHalf(u) * 1.15);
      if (d <= hit && d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  /** 世界坐标 → 最近的可拾取单位 id（右键指令用）。 */
  pickAt(worldX: number, worldY: number): UnitFrame | null {
    return this.#pick(
      this.#worldToScreenX(worldX),
      this.#worldToScreenY(worldY),
    );
  }

  /** 世界坐标 → 屏幕坐标（工具条/测距标注用）。 */
  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: this.#worldToScreenX(wx), y: this.#worldToScreenY(wy) };
  }

  /**
   * 单位当前**画布内屏幕坐标**（含图标分离偏移，与实际点击命中一致）。
   * 自动验收据此把合成鼠标事件精确打在某个图标上（右键菜单 / 点选）。
   */
  unitScreenPos(id: string): { x: number; y: number } | null {
    const u = this.#byId.get(id);
    if (!u) return null;
    return { x: this.#worldToScreenX(this.#displayX(u)), y: this.#worldToScreenY(this.#displayY(u)) };
  }

  /**
   * 当前**渲染位置**（世界坐标，含 tick 间插值、**不含**图标分离偏移）。
   *
   * 流畅度自动验收在 rAF 上连续采样它：正常运动应当"每帧都在前进"，
   * 一旦出现「长时间不动 → 突然跳一大步」或「往回退」，就是插值逻辑坏了。
   * 用渲染位置而不是帧坐标，是因为帧坐标本来就是离散的 tick 采样，量不出观感。
   */
  probePos(id: string): { x: number; y: number } | null {
    const u = this.#byId.get(id);
    if (u) return { x: this.#posX(u), y: this.#posY(u) };
    // ★ 组（无人机 / 铁骑）也支持探针：它们的渲染位置是**独立于母舰**插值的，
    //   要验证"无人机图标是不是平滑移动"就必须直接采样组本身。
    return this.probeGroupPos(id);
  }

  /**
   * 组（无人机 / 铁骑）的**渲染位置**（世界坐标，含 tick 间插值、不含分离偏移）。
   *
   * 与 `probePos` 同一语义，供流畅度验收采样 —— 组在场上自主机动，
   * 若不单独探针就只能量到母舰的运动，量不出组的抖动。
   *
   * `key` 支持两种写法：`<母舰id>#<组id>`（唯一，推荐，见 `groupIds`）或裸的组 id
   * （此时取第一个匹配到的组；组 id 在母舰内才唯一，多船同型时会指到同一组，仅作兼容）。
   */
  probeGroupPos(key: string): { x: number; y: number } | null {
    const a = this.#interpAlpha();
    const hash = key.indexOf("#");
    const hostId = hash > 0 ? key.slice(0, hash) : null;
    const gid = hostId ? key.slice(hash + 1) : key;
    for (const u of this.#units) {
      if (hostId && u.id !== hostId) continue;
      const groups = u.groups;
      if (!groups || groups.length === 0) continue;
      for (const grp of groups) {
        if (grp.id !== gid) continue;
        const gp = this.#prevGroups.get(this.#groupKey(u.id, grp.id));
        return gp
          ? { x: this.#trackPos(gp.x, gp.vx, grp.x, grp.vx, a), y: this.#trackPos(gp.y, gp.vy, grp.y, grp.vy, a) }
          : { x: grp.x, y: grp.y };
      }
    }
    return null;
  }

  /** 当前生效的缩放（像素 / 米），供探针把位移换算成像素。 */
  get viewScale(): number {
    return this.#view.scale;
  }

  /* -------------------------------------------------------------- 绘制 */

  render(): void {
    const g = this.#ctx;
    const cw = this.#canvas.clientWidth;
    const chh = this.#canvas.clientHeight;
    if (this.#canvas.width !== Math.floor(cw * this.#dpr)) this.#resize();

    // 图标碰撞分离（**只在最大缩放时**启用）。
    //
    // ★ V0.9 决策（用户要求）：常规缩放下一律**允许图标重叠**，让战阵保持紧凑 ——
    //   分离是在世界空间按 `图标半宽 ÷ 缩放` 推开图标的，缩小时那个半径会变成几十 km，
    //   于是"一整个舰队看起来被摊开到几十公里"，与真实编队完全不符。
    //   只有在**放到最大**（看得清单舰）时才按原逻辑防重叠：那时图标本来就该分开看。
    const now = performance.now();
    const dt = this.#lastMs === 0 ? 16 : now - this.#lastMs;
    this.#lastMs = now;
    if (this.#view.scale >= MAX_SCALE * 0.995) {
      this.#sep.update(this.#units, this.#view.scale, dt, (u) => this.#iconHalf(u));
    } else if (this.#sep.active) {
      this.#sep.reset();   // 非最大缩放 → 偏移归零（图标紧贴真实位置）
    }

    g.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    g.fillStyle = "#05070d";
    g.fillRect(0, 0, cw, chh);

    if (this.#overlay.grid) this.#drawGrid(g, cw, chh);
    this.#drawSystemBoundary(g, cw, chh);
    // 每帧先清零自检计数，由各绘制函数累加（验收据此断言"环只在单选时画"）
    this.#ringsDrawn = 0;
    this.#labelsDrawn = 0;
    if (this.#overlay.ewLines) this.#drawEwLinks(g);
    this.#drawCelestials(g);
    if (this.#overlay.rings) this.#drawSelectionRings(g);
    this.#drawTargets(g);
    this.#drawUnits(g, cw, chh);
    this.#drawGroups(g);
    this.#drawBoxSelection(g);
    this.#drawScaleBar(g, chh);
  }

  /**
   * 铁骑 / 无人机：画出它们在**场上的实际位置**。
   *
   * ★ 它们出仓后会自主飞向目标、按最佳射程平速环绕 —— 所以位置与母舰不同。
   *   系留线让"已经出仓离开母舰"这件事一眼可见，复盘时能看清行动轨迹。
   */
  #drawGroups(g: CanvasRenderingContext2D): void {
    const cw = this.#canvas.clientWidth;
    const chh = this.#canvas.clientHeight;
    const a = this.#interpAlpha();
    for (const u of this.#units) {
      if (!u.alive || u.evac) continue;
      const groups = u.groups ?? [];
      if (groups.length === 0) continue;
      const fx = this.#worldToScreenX(this.#displayX(u));
      const fy = this.#worldToScreenY(this.#displayY(u));
      for (const grp of groups) {
        if (!grp.alive) continue;
        // 组也是插值的：它自己有机动，不能只跟着母舰的插值走。
        // 键必须拼母舰 id（组 id 只在母舰内唯一，见 #groupKey）。
        const gp = this.#prevGroups.get(this.#groupKey(u.id, grp.id));
        const gx = gp ? this.#trackPos(gp.x, gp.vx, grp.x, grp.vx, a) : grp.x;
        const gy = gp ? this.#trackPos(gp.y, gp.vy, grp.y, grp.vy, a) : grp.y;
        const sx = this.#worldToScreenX(gx);
        const sy = this.#worldToScreenY(gy);
        if (sx < -20 || sy < -20 || sx > cw + 20 || sy > chh + 20) continue;
        const isF = grp.kind === "fighter";
        // 与母舰之间的系留线（组的颜色与左侧面板一致）
        g.strokeStyle = isF ? "rgba(201,166,255,0.25)" : "rgba(127,214,176,0.25)";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(fx, fy);
        g.lineTo(sx, sy);
        g.stroke();
        // 组的标记：铁骑 = 三角，无人机 = 方块
        g.fillStyle = isF ? "#c9a6ff" : "#7fd6b0";
        g.beginPath();
        if (isF) {
          g.moveTo(sx, sy - 3.8);
          g.lineTo(sx - 3.4, sy + 2.6);
          g.lineTo(sx + 3.4, sy + 2.6);
          g.closePath();
        } else {
          g.rect(sx - 2.8, sy - 2.8, 5.6, 5.6);
        }
        g.fill();
      }
    }
  }

  /** 地物：星门 / 空间站（不可装配、不可开火、不可摧毁）。 */
  #drawCelestials(g: CanvasRenderingContext2D): void {
    for (const c of this.#celestials) {
      const sx = this.#worldToScreenX(c.x);
      const sy = this.#worldToScreenY(c.y);
      if (sx < -60 || sy < -60 || sx > this.#canvas.clientWidth + 60
        || sy > this.#canvas.clientHeight + 60) continue;
      const isGate = c.kind === "stargate";
      const r = Math.max(9, Math.min(60, c.radiusM * this.#view.scale));
      g.save();
      g.strokeStyle = isGate ? "#8fd0ff" : "#9aa8bd";
      g.lineWidth = 1.5;
      g.setLineDash(isGate ? [4, 3] : []);
      g.beginPath();
      g.arc(sx, sy, r, 0, Math.PI * 2);
      g.stroke();
      // 星门：内部画一个穿透箭头的示意
      if (isGate) {
        g.beginPath();
        g.moveTo(sx - r * 0.5, sy);
        g.lineTo(sx + r * 0.5, sy);
        g.moveTo(sx + r * 0.2, sy - r * 0.28);
        g.lineTo(sx + r * 0.5, sy);
        g.lineTo(sx + r * 0.2, sy + r * 0.28);
        g.stroke();
      } else {
        g.beginPath();
        g.rect(sx - r * 0.5, sy - r * 0.5, r, r);
        g.stroke();
      }
      g.restore();
      g.font = "10px ui-monospace, Consolas, monospace";
      g.textAlign = "center";
      g.fillStyle = "rgba(160,190,225,0.85)";
      g.fillText(c.name, sx, sy - r - 4);
    }
  }

  /**
   * 星系边界：默认沙盒是一个**圆形星系**（半径 17.5 AU，可调）。
   * 只画边界圈与中心十字，让"这是星系范围"一目了然。
   */
  #drawSystemBoundary(g: CanvasRenderingContext2D, cw: number, ch: number): void {
    const r = this.#systemRadiusM;
    if (!(r > 0)) return;
    const sx = this.#worldToScreenX(0);
    const sy = this.#worldToScreenY(0);
    const px = r * this.#view.scale;
    if (px < 8 || px > 60000) return;
    g.save();
    g.strokeStyle = "rgba(110,150,220,0.28)";
    g.lineWidth = 1;
    g.setLineDash([6, 5]);
    g.beginPath();
    g.arc(sx, sy, px, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    if (sx > -20 && sy > -20 && sx < cw + 20 && sy < ch + 20) {
      g.strokeStyle = "rgba(150,180,230,0.5)";
      g.beginPath();
      g.moveTo(sx - 6, sy); g.lineTo(sx + 6, sy);
      g.moveTo(sx, sy - 6); g.lineTo(sx, sy + 6);
      g.stroke();
    }
    g.restore();
  }

  /**
   * 电子战连线（右上角"电子战连线"开关）：谁在干扰谁。
   *
   * 选中单位的连线**优先且不封顶**，其余最多画 600 条 —— 500 艘船互相放网时
   * 全画会把画面糊死，也没法看。
   */
  #drawEwLinks(g: CanvasRenderingContext2D): void {
    const cw = this.#canvas.clientWidth;
    const chh = this.#canvas.clientHeight;
    let drawn = 0;
    g.lineWidth = 1;
    for (const u of this.#units) {
      if (!u.alive || u.evac || u.ew.length === 0) continue;
      const sx = this.#worldToScreenX(this.#displayX(u));
      const sy = this.#worldToScreenY(this.#displayY(u));
      if (sx < -40 || sy < -40 || sx > cw + 40 || sy > chh + 40) continue;
      for (const e of u.ew) {
        const src = this.#byId.get(e.from);
        if (!src || !src.alive || src.evac) continue;
        const focus = this.#selected.has(u.id) || this.#selected.has(src.id);
        if (drawn > 600 && !focus) continue;
        const ox = this.#worldToScreenX(this.#displayX(src));
        const oy = this.#worldToScreenY(this.#displayY(src));
        g.strokeStyle = ewColor(e.kind);
        g.beginPath();
        g.moveTo(ox, oy);
        g.lineTo(sx, sy);
        g.stroke();
        drawn++;
      }
    }
  }

  #drawGrid(g: CanvasRenderingContext2D, cw: number, ch: number): void {
    // 网格步长：让屏幕间距落在 50~160 px
    const target = 90;
    let step = 1000;
    while (step * this.#view.scale < target) step *= 5;
    while (step * this.#view.scale > target * 4) step /= 5;

    const tl = this.#screenToWorld(0, 0);
    const br = this.#screenToWorld(cw, ch);
    g.lineWidth = 1;
    g.strokeStyle = "rgba(70,110,170,0.16)";
    g.beginPath();
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      const sx = Math.round(this.#worldToScreenX(x)) + 0.5;
      g.moveTo(sx, 0);
      g.lineTo(sx, ch);
    }
    for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
      const sy = Math.round(this.#worldToScreenY(y)) + 0.5;
      g.moveTo(0, sy);
      g.lineTo(cw, sy);
    }
    g.stroke();
  }

  #drawScaleBar(g: CanvasRenderingContext2D, ch: number): void {
    const target = 140;
    let meters = 1000;
    while (meters * this.#view.scale < target) meters *= 5;
    const px = meters * this.#view.scale;
    const x = 16;
    const y = ch - 22;
    g.strokeStyle = "rgba(200,220,255,0.65)";
    g.fillStyle = "rgba(200,220,255,0.65)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + px, y);
    g.stroke();
    g.font = "11px ui-monospace, Consolas, monospace";
    const label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
    g.fillText(label, x, y - 5);
  }

  /**
   * 选中单位的三个环（用户指定）：
   * - **锁定距离**环：橙色 —— 能锁上谁
   * - **最佳射程**环：绿色实线 —— 命中率 100% 的范围（PYFA 的 `39km` 那一项）
   * - **有效射程**环：浅绿虚线 —— 最佳 + 失准（PYFA 的 `39km+71.7km` 里的 **110.7km**）；
   *   超出最佳后命中率按 `0.5^((d-最佳)/失准)²` 衰减，环外基本打不中
   *
   * 每个环在**上下左右四个点**标出距离数字，颜色与环一致，便于直接读数。
   */
  #drawSelectionRings(g: CanvasRenderingContext2D): void {
    // ★ 用户要求：射程环 / 锁定环**只在点选单个单位**时显示；框选（多选）不画环，
    //   否则几百个环叠在一起，反而什么都看不清。
    if (this.#selected.size !== 1) return;
    const cw = this.#canvas.clientWidth;
    const chh = this.#canvas.clientHeight;
    g.lineWidth = 1;
    g.lineJoin = "round";
    for (const id of this.#selected) {
      const u = this.#byId.get(id);
      if (!u || !u.alive || u.evac) continue;
      const sx = this.#worldToScreenX(this.#displayX(u));
      const sy = this.#worldToScreenY(this.#displayY(u));
      this.#drawRing(g, sx, sy, u.lockRange, LOCK_RING_COLOR, "锁定", cw, chh);
      this.#drawRing(g, sx, sy, u.range, RANGE_RING_COLOR, "最佳", cw, chh);
      // 有效射程只比最佳大（falloff>0）时才单独画，避免两环完全重合
      if (u.rangeEff > u.range * 1.001) {
        this.#drawRing(g, sx, sy, u.rangeEff, EFFECTIVE_RING_COLOR, "有效", cw, chh, true);
      }
    }
  }

  #drawRing(
    g: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    radiusM: number,
    color: string,
    label: string,
    cw: number,
    chh: number,
    dash = false,
  ): void {
    if (!(radiusM > 0)) return;
    const r = radiusM * this.#view.scale;
    // 太小（比图标还小）或大到离谱（远超视野）就不画
    if (r < 6 || r > 200000) return;
    this.#ringsDrawn++;
    g.strokeStyle = color;
    g.globalAlpha = dash ? 0.36 : 0.42;
    // 有效射程环画成虚线，与实线的最佳射程环一眼可分
    if (dash) g.setLineDash([7, 6]);
    g.beginPath();
    g.arc(sx, sy, r, 0, Math.PI * 2);
    g.stroke();
    if (dash) g.setLineDash([]);
    g.globalAlpha = 1;

    // 四个方位点上的距离读数（超出画布就跳过，免得在屏幕外画一堆文字）
    const text = `${label} ${formatDist(radiusM)}`;
    g.font = "10px ui-monospace, Consolas, monospace";
    g.textAlign = "center";
    g.textBaseline = "middle";
    const pts: Array<[number, number]> = [
      [sx, sy - r], [sx, sy + r], [sx - r, sy], [sx + r, sy],
    ];
    g.fillStyle = color;
    g.strokeStyle = "rgba(5,7,13,0.85)";
    g.lineWidth = 3;
    for (const [px, py] of pts) {
      if (px < -120 || py < -20 || px > cw + 120 || py > chh + 20) continue;
      // 先描一圈深色底再写字，避免压在网格/图标上看不清
      g.strokeText(text, px, py);
      g.fillText(text, px, py);
    }
    g.lineWidth = 1;
  }

  #drawTargets(g: CanvasRenderingContext2D): void {
    g.lineWidth = 1;
    for (const id of this.#selected) {
      const u = this.#byId.get(id);
      if (!u || !u.targetId) continue;
      const t = this.#byId.get(u.targetId);
      if (!t) continue;
      g.strokeStyle = "rgba(255,220,120,0.45)";
      g.beginPath();
      g.moveTo(this.#worldToScreenX(u.x), this.#worldToScreenY(u.y));
      g.lineTo(this.#worldToScreenX(t.x), this.#worldToScreenY(t.y));
      g.stroke();
    }
  }

  #drawUnits(g: CanvasRenderingContext2D, cw: number, ch: number): void {
    // ★ 用户要求：沙盘上**只显示舰船图标**，不画舰船名字 —— 数百单位时名字会糊成一片。
    //   保留开关（默认关）而不是彻底删掉绘制代码：真要排障时能一键打开，
    //   同时 `renderStats().unitNames` 让自动验收能卡住"别又给画回来"。
    g.font = "10px ui-monospace, Consolas, monospace";
    g.textAlign = "center";

    for (const u of this.#units) {
      if (!u.alive || u.evac) continue;
      // 显示位置（引擎坐标 + 图标分离偏移）
      const sx = this.#worldToScreenX(this.#displayX(u));
      const sy = this.#worldToScreenY(this.#displayY(u));
      if (sx < -40 || sy < -40 || sx > cw + 40 || sy > ch + 40) continue;

      const cls = this.#iconClassOf(u);
      const color = this.#colorOf(u);
      const icon = tintedIcon(cls, color);
      const half = iconSize(cls);
      g.drawImage(icon, sx - half, sy - half, half * 2, half * 2);

      // 按帝国色染色时，另用一圈势力色标示红/蓝（两种信息都不丢）
      if (ICON_TINT_MODE === "empire") {
        g.strokeStyle = this.#sideColor(u.sideId);
        g.lineWidth = 1;
        g.beginPath();
        g.arc(sx, sy, half * 0.92, 0, Math.PI * 2);
        g.stroke();
      }

      // 旗舰跳能力标记：可跳 = 亮色小三角，冷却中 = 暗色
      if (u.hasJump) {
        g.fillStyle = u.canJump ? "rgba(200,166,255,0.95)" : "rgba(120,110,150,0.6)";
        g.beginPath();
        g.moveTo(sx, sy - half - 3);
        g.lineTo(sx - 3.2, sy - half + 2.5);
        g.lineTo(sx + 3.2, sy - half + 2.5);
        g.closePath();
        g.fill();
      }

      if (this.#selected.has(u.id)) {
        g.strokeStyle = "#ffe36e";
        g.lineWidth = 1.5;
        g.strokeRect(sx - half - 2, sy - half - 2, half * 2 + 4, half * 2 + 4);
      }

      // 三层血条（护盾蓝 / 装甲黄 / 结构红），同条三段
      const barW = 30;
      const barY = sy + half + 3;
      const seg = (ratio: number, x: number, w: number, fill: string) => {
        g.fillStyle = "rgba(0,0,0,0.6)";
        g.fillRect(x, barY, w, 3);
        g.fillStyle = fill;
        g.fillRect(x, barY, Math.max(0, Math.min(1, ratio)) * w, 3);
      };
      const w1 = barW * 0.4, w2 = barW * 0.35, w3 = barW * 0.25;
      let x = sx - barW / 2;
      seg(u.shield, x, w1, "#4fa3ff"); x += w1;
      seg(u.armor, x, w2, "#ffd24a"); x += w2;
      seg(u.hull, x, w3, "#ff5a4d");

      // 电量条
      g.fillStyle = "rgba(0,0,0,0.6)";
      g.fillRect(sx - barW / 2, barY + 4, barW, 2);
      g.fillStyle = "#8ce0ff";
      g.fillRect(sx - barW / 2, barY + 4, u.cap * barW, 2);

      if (u.locked) {
        g.strokeStyle = "rgba(255,255,255,0.5)";
        g.lineWidth = 1;
        g.beginPath();
        g.arc(sx, sy, half + 4, 0, Math.PI * 2);
        g.stroke();
      }
      if (u.warping) {
        g.fillStyle = "#c9a6ff";
        g.fillText("跃迁", sx, sy - half - 4);
      }

      // 舰船名字：**默认关闭**（用户要求沙盘只显示图标）。开关打开时计数，
      // 供自动验收断言"名字没有被画回来"。
      if (this.#showUnitNames) {
        this.#labelsDrawn++;
        g.fillStyle = "rgba(200,215,235,0.9)";
        g.fillText(u.name, sx, sy + half + 14);
      }
    }
  }

  #drawBoxSelection(g: CanvasRenderingContext2D): void {
    if (!this.#boxSel) return;
    const b = this.#boxSel;
    g.strokeStyle = "rgba(120,200,255,0.9)";
    g.fillStyle = "rgba(120,200,255,0.12)";
    g.lineWidth = 1;
    const x = Math.min(b.x0, b.x1);
    const y = Math.min(b.y0, b.y1);
    const w = Math.abs(b.x1 - b.x0);
    const h = Math.abs(b.y1 - b.y0);
    g.fillRect(x, y, w, h);
    g.strokeRect(x + 0.5, y + 0.5, w, h);
  }
}

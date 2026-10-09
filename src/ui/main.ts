/**
 * UI 入口：装配三栏布局、Worker、宿主桥与各面板。
 *
 * 铁律（§3.1）：UI **只读帧、只发命令**；一切状态变更都经 Worker 里的引擎完成。
 * §8.6 乐观响应：点击指令立即在 UI 反映（选中/按钮态），重算在 Worker 中进行，
 * 完成后以新帧替换；期间 UI 继续渲染旧状态并显示"重算中"。
 */
import type { Command, CommandTarget } from "../core/commands.ts";
import type { ChargeOption, Frame, FromWorker, SavedBattle, ToWorker, UnitFrame } from "./protocol.ts";
import { createBridge } from "./bridge.ts";
import { el, hideContextMenu, setText, showContextMenu } from "./util/dom.ts";
import type { MenuItem } from "./util/dom.ts";
import { iconsReady, preloadIcons } from "./util/icons.ts";
import { BattleMap } from "./view/map.ts";
import { ControlPanel, EventStream, FleetList, TimelineBar } from "./view/panels.ts";
import type { PanelCallbacks, UiSelection } from "./view/panels.ts";
import { createMapToolbar } from "./view/toolbar.ts";
import { fits, getFit, getPlan, loadStore, migrateFits } from "./app/store.ts";
import type { FormationPlan } from "./app/store.ts";
import { openReinforceDialog } from "./view/reinforceDialog.ts";
import { openReportDialog, updateReportDialog } from "./view/reportDialog.ts";
import { knownSideIds, setSideMeta, sideName } from "./app/sides.ts";
import { buildBattleConfig } from "./app/battleBuilder.ts";
import { groupOf, loadSde, zhName } from "./sde.ts";
import { createImportPage } from "./pages/importPage.ts";
import { createLibraryPage } from "./pages/libraryPage.ts";
import { createFormationPage } from "./pages/formationPage.ts";

const bridge = createBridge();
const worker = new Worker(new URL("./worker/sim.worker.ts", import.meta.url), { type: "module" });

let frame: Frame | null = null;
let lastTick = 0;
/**
 * 增援下发后：等增援单位出现在帧里时**自动选中**它们（而不是自动取景）。
 * ★ 不要用 map.fit()：星门在战线外约 140 km，适应全体会把镜头拉得极远、
 *   整个战场缩成一个点（用户实测反馈）。选中只是给出"它们在哪儿"的入口，
 *   用户想看去点右上角「聚焦选中」即可，镜头不会乱动。
 */
let selectAfterReinforce = false;
const selection: UiSelection = { unitIds: new Set(), squadKeys: new Set() };
const groups = new Map<string, string[]>();

const $ = (sel: string): HTMLElement => document.querySelector(sel) as HTMLElement;

const statusBox = $("#status");
const mapCanvas = $("#map") as HTMLCanvasElement;

function send(msg: ToWorker): void {
  worker.postMessage(msg);
}

function cmdNow(
  action: Command["action"],
  params: Record<string, unknown>,
  target?: CommandTarget,
): Command {
  const t: CommandTarget = target ?? (selection.unitIds.size > 0
    ? { unitIds: [...selection.unitIds] }
    : {});
  return { tick: lastTick, target: t, action, params };
}

/**
 * 右键「增援到此处」：先弹窗让用户选势力 / 数量 / 配置（配置库里的配装），
 * 确认后下发 reinforce 命令。worker 在命令入队前算好属性并生成单位，
 * 这样**用户自建战场**（没有预置预备单位）也能一键增援，而非毫无反应。
 */
async function reinforceViaDialog(mode: "gate" | "jump", world: { x: number; y: number }): Promise<void> {
  // ★ 势力列表来自真实注册表（0=蓝方、1=红方…），值就是引擎 sideId。
  const sides = knownSideIds().map((id) => ({ id, name: sideName(id) }));
  // 默认跟着"当前选中单位"的势力走；没选中就用第一个势力
  const firstSel = frame?.units.find((u) => selection.unitIds.has(u.id));
  const defaultSide = firstSel?.sideId ?? sides[0]?.id ?? 0;
  const choice = await openReinforceDialog({ fits, mode, defaultSide, point: world, sides });
  if (!choice) return;
  const fit = getFit(choice.fitId);
  if (!fit) return;
  // 增援入场后自动**选中**新单位（不取景 —— 星门在战场外 140 km，取景会把镜头拉飞）
  selectAfterReinforce = true;
  send({
    type: "command",
    cmd: {
      tick: lastTick,
      target: { sideId: choice.sideId },
      action: "reinforce",
      params: {
        mode: choice.mode,
        to: { x: world.x, y: world.y },
        sideId: choice.sideId,
        count: choice.count,
        fit: {
          name: fit.name,
          shipName: fit.shipName,
          shipTypeId: fit.shipTypeId,
          modules: fit.modules,
          drones: fit.drones,
          fighters: fit.fighters,
        },
      },
    },
  });
}

// 预载吨位线稿（异步；加载完成前用程序化兜底形状，不影响使用）
void preloadIcons();

const map = new BattleMap(mapCanvas, {
  onSelect(ids, additive) {
    if (!additive) {
      selection.unitIds.clear();
      selection.squadKeys.clear();
    }
    for (const id of ids) selection.unitIds.add(id);
    refreshSquadSelection();
    map.setSelection(selection.unitIds);
  },
  onContextMenu(screenX, screenY, unitId, world) {
    const units = frame?.units ?? [];
    const hit = unitId ? units.find((u) => u.id === unitId) : null;
    const items: MenuItem[] = [];

    if (hit) {
      // ★ 用户要求：选中一条舰船后，可以一键把**同联队 / 同舰队**都选中，
      //   免得在几百个图标里一个个框。
      const sameWing = units
        .filter((u) => u.alive && !u.evac && u.sideId === hit.sideId
          && u.fleetId === hit.fleetId && u.wingId === hit.wingId)
        .map((u) => u.id);
      const sameFleet = units
        .filter((u) => u.alive && !u.evac && u.sideId === hit.sideId && u.fleetId === hit.fleetId)
        .map((u) => u.id);
      items.push(
        { label: "仅选中此单位", run: () => applySelection([hit.id]) },
        { label: "追加到选择", run: () => applySelection([...selection.unitIds, hit.id]) },
        { separator: true, label: "" },
        { label: `选中所属联队（${sameWing.length} 艘）`, run: () => applySelection(sameWing) },
        { label: `选中所属舰队（${sameFleet.length} 艘）`, run: () => applySelection(sameFleet) },
        { separator: true, label: "" },
        { label: "集火此目标", hint: "设为主目标", run: () => send({ type: "command", cmd: cmdNow("setTarget", { targetId: hit.id }) }) },
        { separator: true, label: "" },
      );
    }

    if (selection.unitIds.size > 0) {
      const moveTo = (type: string, label: string, range?: number): MenuItem => ({
        label,
        run: () => send({
          type: "command",
          cmd: {
            tick: lastTick,
            target: selTarget(),
            action: "setOrder",
            params: {
              type,
              targetId: hit?.id ?? null,
              // 未点中单位时，落点就是右键处（否则"移动到此处"无处可去）
              to: { x: world.x, y: world.y },
              ...(range !== undefined ? { range } : {}),
            },
          },
        }),
      });
      items.push(
        moveTo("approach", hit ? `接近 ${hit.name}` : "移动到此处"),
        moveTo("orbit", "环绕 20km", 20_000),
        moveTo("keepAtRange", "保持 20km", 20_000),
        { label: "停止机动（火力继续）", hint: "≠ 红警的停止", run: () => send({ type: "command", cmd: cmdNow("stop", {}) }) },
        { label: "对齐（起跳准备）", run: () => send({ type: "command", cmd: cmdNow("setOrder", { type: "align" }) }) },
        { label: "撤离（起跳离场）", run: () => send({ type: "command", cmd: cmdNow("warpOut", {}) }) },
        { separator: true, label: "" },
        {
          label: "旗舰跳到此处",
          hint: "与普通跃迁区分：瞬到 + 冷却",
          run: () => send({
            type: "command",
            cmd: cmdNow("setOrder", { type: "jump", to: { x: world.x, y: world.y } }),
          }),
        },
        {
          label: "旗舰跳撤场",
          hint: "被反跳 / 冷却中 / 无跳跃引擎则无效",
          run: () => send({ type: "command", cmd: cmdNow("jumpOut", {}) }),
        },
      );

      // ★ V0.8「跃迁至」（普通跃迁）：点中目标（单位 / 星门 / 建筑）+ 距离 > 150 km
      //   + **未被跃迁干扰**（不在拦截力场、稳定系数 ≥ 1）时才可用；
      //   子菜单选择"落地后距目标的距离"。
      const selUnits = units.filter((u) => u.alive && !u.evac && selection.unitIds.has(u.id));
      let anchor: { x: number; y: number } | null = hit ? { x: hit.x, y: hit.y } : null;
      if (!anchor) {
        const cel = (frame?.celestials ?? []).find((c) =>
          Math.hypot(world.x - c.x, world.y - c.y) <= (c.radiusM || 0) + 5_000);
        if (cel) anchor = { x: cel.x, y: cel.y };
      }
      if (selUnits.length > 0 && anchor) {
        const ax = anchor.x;
        const ay = anchor.y;
        const dist = Math.min(...selUnits.map((u) => Math.hypot(u.x - ax, u.y - ay)));
        const warpable = selUnits.filter((u) => u.canWarp);
        const farEnough = dist > 150_000;
        const hint = !farEnough
          ? `距离 ${(dist / 1000).toFixed(0)} km ≤ 150 km：直接用机动指令即可`
          : warpable.length === 0
            ? `不可跃迁：${selUnits[0].warpReason || "被干扰"}`
            : `${warpable.length}/${selUnits.length} 艘可跃迁`;
        items.push({ separator: true, label: "" });
        items.push({
          label: "跃迁至…",
          hint,
          disabled: !farEnough || warpable.length === 0,
          submenu: WARP_DISTANCES.map((km) => ({
            label: km === 0 ? "落点 = 目标（0 m）" : `落地距目标 ${km} km`,
            run: () => send({
              type: "command",
              cmd: {
                tick: lastTick,
                target: selTarget(),
                action: "warpTo",
                params: {
                  range: km * 1000,
                  ...(hit ? { targetId: hit.id } : { to: { x: ax, y: ay } }),
                },
              },
            }),
          })),
        });
      }
    } else {
      items.push({ label: "（未选中单位）", disabled: true });
    }

    // —— 增援：右键弹窗选势力 / 数量 / 配置 / 入场方式 ——
    items.push({ separator: true, label: "" });
    items.push({
      label: "增援：星门派遣到此处",
      hint: "弹窗选择势力/数量/配置后由星门入场（过门延迟，落地后机动）",
      run: () => void reinforceViaDialog("gate", world),
    });
    items.push({
      label: "增援：旗舰跳直达此处",
      hint: "弹窗选择势力/数量/配置后旗舰瞬到该点（密集圆阵）",
      run: () => void reinforceViaDialog("jump", world),
    });

    items.push({ separator: true, label: "" });
    items.push({
      label: `世界坐标 ${(world.x / 1000).toFixed(1)}, ${(world.y / 1000).toFixed(1)} km`,
      disabled: true,
    });
    showContextMenu(screenX, screenY, hit ? `${hit.name}（${hit.shipName}）` : "空域", items);
  },
});

/** 「跃迁至」的落地距离选项（km，距目标）。 */
const WARP_DISTANCES = [0, 10, 20, 30, 50, 70, 100];

function applySelection(ids: string[]): void {
  selection.unitIds = new Set(ids);
  refreshSquadSelection();
  map.setSelection(selection.unitIds);
}

function selTarget(): CommandTarget {
  return selection.unitIds.size > 0 ? { unitIds: [...selection.unitIds] } : {};
}

const cb: PanelCallbacks = {
  send(cmd) {
    send({ type: "command", cmd: { ...cmd, tick: cmd.tick < 0 ? lastTick : cmd.tick, target: normalize(cmd.target) } });
  },
  play() { send({ type: "play" }); },
  pause() { send({ type: "pause" }); },
  setSpeed(speed) { send({ type: "setSpeed", speed }); },
  seek(tick) { send({ type: "seek", tick }); },
  step(ticks) { send({ type: "step", ticks }); },
  mark() { send({ type: "mark" }); },
  fork(atTick) { send({ type: "fork", atTick }); },
  switchBranch(id) { send({ type: "switchBranch", id }); },
  /** 内置示例场景（调试用）；正式流程走「生成推演」。 */
  changeScenario(id) {
    selection.unitIds.clear();
    selection.squadKeys.clear();
    send({ type: "init", scenarioId: id });
    simStarted = true; // 示例场景自带单位，视作"已有推演"
  },
  /** ★ V0.7：终止推演 → 回到「战场编成」重新调整。 */
  terminate() {
    send({ type: "pause" });
    hideContextMenu();
    selection.unitIds.clear();
    selection.squadKeys.clear();
    map.setSelection(selection.unitIds);
    // 终止即作废当前战局：之后点「④ 推演」按最新编成重新生成，
    // 避免"改了编成再进推演，看到的还是旧战局"。
    simStarted = false;
    setStatusText("已终止本次推演，返回战场编成。");
    setPage("formation");
  },
  toggleSquadSelection(key) {
    if (selection.squadKeys.has(key)) selection.squadKeys.delete(key);
    else selection.squadKeys.add(key);
  },
  /** ★ 左侧「舰队 / 联队 / 小队」层级选中 —— 与沙盘框选共用同一套选择状态。 */
  selectUnits(ids) {
    applySelection(ids);
  },
  async listCharges(typeId) {
    const reply = await bridge.request({ op: "validCharges", moduleTypeId: typeId });
    return (reply as { charges?: ChargeOption[] }).charges ?? [];
  },
  save() {
    pendingExport = "local";
    send({ type: "export" });
  },
  load() {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) {
      setStatusText("本地存储中没有存档");
      return;
    }
    restoreFrom(raw);
  },
  exportFile() {
    pendingExport = "file";
    send({ type: "export" });
  },
  importFile() {
    pickFile();
  },
};

/* ---------------------------------------------------------- 存档 / 载入（D-18） */

const SAVE_KEY = "eve-sandbox-save-v1";
let pendingExport = "";
let pyfaVersion = "";
/** 当前场景配置里的地物数（自动验收据此判定"地物下发是否完整"）。 */
let landmarksExpected = 0;

function downloadJson(data: SavedBattle): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `eve战局-${data.scenarioId}-T${data.tick}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  setStatusText(`已导出（T+${data.tick}s，PYFA ${data.pyfaVersion}）`);
}

function restoreFrom(raw: string): void {
  let data: SavedBattle;
  try {
    data = JSON.parse(raw) as SavedBattle;
  } catch (err) {
    setStatusText("存档解析失败：" + (err as Error).message);
    return;
  }
  if (data.format !== "eve-battle-sandbox") {
    setStatusText("存档格式不匹配（不是本软件的存档）");
    return;
  }
  let hint = "";
  if (pyfaVersion && data.pyfaVersion && data.pyfaVersion !== pyfaVersion) {
    hint = `⚠ 存档由 PYFA ${data.pyfaVersion} 生成，当前为 ${pyfaVersion}，数值可能有差异`;
  }
  send({ type: "restore", data });
  setStatusText(hint || `正在载入存档（T+${data.tick}s）…`);
}

function pickFile(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => restoreFrom(String(reader.result));
    reader.readAsText(f);
  });
  input.click();
}

/** 空 target 表示"选中的单位"。 */
function normalize(t: CommandTarget): CommandTarget {
  if (!t.unitId && !t.unitIds && t.sideId === undefined && t.fleetId === undefined
    && t.wingId === undefined && t.squadId === undefined) {
    return selTarget();
  }
  return t;
}

const fleetList = new FleetList($("#left"), cb);
const control = new ControlPanel($("#right"), cb);
const timeline = new TimelineBar($("#timeline"), cb);
const events = new EventStream($("#events"), cb);

/* ------------------------------------------------------------------ 四页流程 */

type PageId = "import" | "library" | "formation" | "sim";
let currentPage: PageId = "import";

const pageNodes: Record<PageId, HTMLElement> = {
  import: $("#page-import"),
  library: $("#page-library"),
  formation: $("#page-formation"),
  sim: $("#layout"),
};

const importPage = createImportPage();
const libraryPage = createLibraryPage(() => formationPage.refresh());
const formationPage = createFormationPage((plan) => generateSim(plan));

$("#page-import").appendChild(importPage.root);
$("#page-library").appendChild(libraryPage.root);
$("#page-formation").appendChild(formationPage.root);

const mapToolbar = createMapToolbar(map, {
  /** 战报：先暂停，再弹当前时间点的各方战损（按吨位 `无畏舰：39（27）`）。 */
  onReport() {
    cb.pause();
    openReportDialog(frame);
  },
});
$("#map-toolbar").appendChild(mapToolbar.root);

function setPage(id: PageId): void {
  currentPage = id;
  for (const key of Object.keys(pageNodes) as PageId[]) {
    pageNodes[key].classList.toggle("active", key === id);
  }
  for (const btn of document.querySelectorAll<HTMLElement>("#nav .nav-btn")) {
    btn.classList.toggle("on", btn.dataset.page === id);
  }
  if (id === "import") importPage.refresh();
  else if (id === "library") libraryPage.refresh();
  else if (id === "formation") formationPage.refresh();
  else {
    // 画布刚由 display:none 变可见：先同步尺寸再取景，避免第一帧错位
    requestAnimationFrame(() => {
      map.resize();
      map.fit();
      mapToolbar.tick();
    });
  }
}

for (const btn of document.querySelectorAll<HTMLElement>("#nav .nav-btn")) {
  btn.addEventListener("click", () => {
    const target = btn.dataset.page as PageId | undefined;
    if (!target) return;
    // ★ 「④ 推演」不能只切页：没生成过推演时切过去就是一片空沙盘
    //   （无舰队、左侧列表空、拖动也无参照物，用户会以为"坏了"）。
    //   改走 openSim()：无推演就按当前编成当场生成。
    if (target === "sim") openSim();
    else setPage(target);
  });
}

/**
 * 是否已经给过引擎一份可推演的编成（或内置示例场景）。
 * 只有它还是 false 时，点「④ 推演」才需要即时生成，否则直接切页、不打断正在跑的推演。
 */
let simStarted = false;

/**
 * 进入「④ 推演」页。
 * - 已有推演：直接切页，不动当前战局。
 * - 尚未推演：用当前编成方案生成；编成为空时**留在「③ 战场编成」并提示**，
 *   而不是把用户丢进一个没有任何单位的空沙盘。
 */
function openSim(): void {
  if (simStarted) {
    setPage("sim");
    return;
  }
  const plan = getPlan();
  if (buildBattleConfig(plan).counts.total === 0) {
    setStatusText("编成为空：请先在「③ 战场编成」为小队指派配装（可在「① 数据导入」导入 PYFA 配装），再点「生成推演」。");
    setPage("formation");
    return;
  }
  generateSim(plan);
}

/**
 * 「生成推演」：把当前编成方案交给引擎。
 * 势力名称/颜色写入展示层注册表，随后直接给 Worker 一份自建 BattleConfig。
 */
function generateSim(plan: FormationPlan): void {
  const built = buildBattleConfig(plan);
  setSideMeta(plan.sides.map((s) => ({ name: s.name, color: s.color })));
  map.setSideColors(plan.sides.map((s) => s.color));
  map.setSystemRadius(built.radiusM);
  landmarksExpected = built.landmarks;
  selection.unitIds.clear();
  selection.squadKeys.clear();
  map.setSelection(selection.unitIds);
  setPage("sim");
  send({ type: "initConfig", config: built.config, label: plan.label });
  simStarted = true;
  setStatusText(built.counts.total > 0
    ? `正在生成推演：${plan.sides.length} 势力 / ${built.counts.total} 艘${built.warnings.length ? `（${built.warnings.length} 条提示）` : ""}`
    : "编成为空");
  // 等引擎把单位下发后再取景。★ 这里必须用 fit()（收到**舰队**上）而不是
  // fitSystem()（连 0.55~0.92R 的星门一起收）：星系半径默认 17.5 AU = 2.6e12 m，
  // 而舰队交战尺度只有几十 km，一起收会把舰队压成亚像素 —— 用户看到的就是
  // "沙盘里没有任何舰队"。想看整个星系请点右上角工具条的「适应星系」。
  setTimeout(() => {
    map.resize();
    map.fit();
    mapToolbar.tick();
  }, 600);
  for (const w of built.warnings.slice(0, 3)) console.warn("[编成]", w);
}

function refreshSquadSelection(): void {
  selection.squadKeys.clear();
  const units = frame?.units ?? [];
  for (const u of units) {
    if (!selection.unitIds.has(u.id)) continue;
    selection.squadKeys.add(squadKeyOf(u));
  }
}

/** 单位 → 小队键（单位帧直接带层级字段，无需反查）。 */
function squadKeyOf(u: UnitFrame): string {
  return `${u.sideId}:${u.fleetId}:${u.wingId}:${u.squadId}`;
}

const msgCounts: Record<string, number> = {};
const bridgeErrors: string[] = [];
/** 引擎/指令执行失败的信息（★ 旧版界面**完全忽略** worker 的 error 消息，
 *  于是失败表现为"点一下没反应/像卡死"，排查全靠猜）。 */
const runErrors: string[] = [];
/**
 * 主线程看门狗状态：worker 若陷在同步长任务（重算 / 属性预热）里，它**无法**发帧、
 * 也无法响应用户任何操作 —— 用户看到的就是"卡死"。worker 自己起的定时器同样不会触发，
 * 所以看门狗必须在主线程：帧/busy 消息只要停发超过 3 s，就在状态栏显示已耗时，
 * 让用户能区分"在算"还是"真死"，也方便把卡在哪一步直接反馈。
 */
let engineBusy = false;
let lastWorkerMsgAt = 0;

worker.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as FromWorker & { type: string; id?: number; payload?: unknown };
  msgCounts[msg.type] = (msgCounts[msg.type] ?? 0) + 1;
  if (msg.type === "error") {
    // 收集 + 工具条醒目提示 + 控制台；**不 return** —— 下面既有的状态栏分支也要照常显示。
    const text = String((msg as { message?: string }).message ?? "");
    runErrors.push(text);
    console.error("[引擎]", text);
    mapToolbar.notify(`指令未生效：${text}`);
  }
  if (msg.type === "statsRequest") {
    const id = (msg as { id: number }).id;
    const payload = (msg as { payload: { op: string } }).payload;
    bridge
      .request(payload)
      .then((reply) => worker.postMessage({ type: "statsResponse", id, ok: reply.ok, result: reply, error: reply.error?.message }))
      .catch((err: Error) => {
        bridgeErrors.push(err.message);
        worker.postMessage({ type: "statsResponse", id, ok: false, error: err.message });
      });
    return;
  }
  if (msg.type === "frame") {
    frame = (msg as { frame: Frame }).frame;
    lastTick = frame.tick;
    engineBusy = frame.busy;
    lastWorkerMsgAt = performance.now();
    // 先同步时钟再给单位：渲染层用「是否在跑」决定要不要在相邻 tick 快照之间插值。
    // 重算中 / 已结束 / 暂停 → 一律不插值，直接把帧坐标画出来。
    map.setClock(frame.speed, frame.playing && !frame.busy && !frame.finished);
    map.setUnits(frame.units, frame.tick);
    if (frame.celestials) map.setCelestials(frame.celestials);
    fleetList.update(frame, selection);
    control.update(frame, selection);
    timeline.update(frame);
    // 战报窗口开着时跟着刷新（暂停后仍可能收到收尾帧，保证数字是当前的）
    updateReportDialog(frame);
    // 增援刚入场 → 自动选中它们（右侧指令面板随即可见；要看去点「聚焦选中」）
    if (selectAfterReinforce) {
      const fresh = frame.units.filter((u) => u.id.startsWith("spawn-")).map((u) => u.id);
      if (fresh.length > 0) {
        selectAfterReinforce = false;
        applySelection(fresh);
      }
    }
    events.updateCommandLog(frame);
    if (frame.events.length > 0) events.push(frame.events);
    setStatus(frame);
  } else if (msg.type === "busy") {
    const m = msg as { busy: boolean; note: string };
    statusBox.dataset.busy = m.busy ? "1" : "0";
    statusBox.textContent = m.busy ? m.note : "";
    engineBusy = m.busy;
    lastWorkerMsgAt = performance.now();
  } else if (msg.type === "ready") {
    pyfaVersion = (msg as { pyfaVersion?: string }).pyfaVersion ?? pyfaVersion;
    landmarksExpected = (msg as { landmarksExpected?: number }).landmarksExpected ?? 0;
    setStatusText("");
  } else if (msg.type === "exported") {
    const data = (msg as { data: SavedBattle }).data;
    if (pendingExport === "file") downloadJson(data);
    else if (pendingExport === "local") {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(data));
        setStatusText(`已保存到本地存储（T+${data.tick}s，PYFA ${data.pyfaVersion}）`);
      } catch (err) {
        setStatusText("保存失败：" + (err as Error).message);
      }
    }
    pendingExport = "";
  } else if (msg.type === "error") {
    const m = msg as { message: string };
    statusBox.textContent = "错误：" + m.message;
    statusBox.dataset.busy = "0";
    statusBox.classList.add("error");
  }
});

function setStatus(f: Frame): void {
  // 多势力：按实际出现的 sideId 汇总存活数，名称取自「战场编成」的势力命名
  const alive = new Map<number, number>();
  for (const u of f.units) {
    if (u.alive && !u.evac) alive.set(u.sideId, (alive.get(u.sideId) ?? 0) + 1);
  }
  const ids = [...alive.keys()].sort((a, b) => a - b);
  const summary = ids.map((id) => `${sideName(id)} ${alive.get(id)}`).join(" / ");
  setStatusText(`T+${f.tick}s｜${summary}｜${f.playing ? "推演中" : "已暂停"}｜${f.busy ? f.busyNote : ""}`);
}

let lastStatus = "";
function setStatusText(text: string): void {
  if (text === lastStatus) return;
  lastStatus = text;
  const box = $("#ticker");
  box.textContent = text;
}

/* ------------------------------------------------------------ 键盘快捷键 */

window.addEventListener("keydown", (e) => {
  const tag = (document.activeElement as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.code === "Space") {
    e.preventDefault();
    if (frame?.playing) cb.pause(); else cb.play();
    return;
  }
  if (e.key === "Escape") {
    hideContextMenu();
    selection.unitIds.clear();
    selection.squadKeys.clear();
    map.setSelection(selection.unitIds);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key >= "1" && e.key <= "8") {
    groups.set(e.key, [...selection.unitIds]);
    return;
  }
  if (e.key >= "1" && e.key <= "8") {
    const g = groups.get(e.key);
    if (g) {
      selection.unitIds = new Set(g);
      refreshSquadSelection();
      map.setSelection(selection.unitIds);
    }
  }
});

/* ------------------------------------------------------------------ 诊断 */

const diag = $("#diag");
const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => errors.push(String((e as PromiseRejectionEvent).reason)));
worker.addEventListener("error", (e) => errors.push("worker: " + String((e as ErrorEvent).message)));

let fpsFrames = 0;
let fpsSince = performance.now();
let fps = 0;
let lastFrameAt = 0;
const frameIntervals: number[] = [];

function diagTick(): void {
  const now = performance.now();
  fpsFrames++;
  if (now - fpsSince >= 1000) {
    fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
    fpsFrames = 0;
    fpsSince = now;
  }
  if (frame !== null && frame.tick !== lastTickDiag) {
    lastTickDiag = frame.tick;
    const t = performance.now();
    if (lastFrameAt > 0) {
      frameIntervals.push(t - lastFrameAt);
      if (frameIntervals.length > 120) frameIntervals.shift();
    }
    lastFrameAt = t;
  }
  const sorted = [...frameIntervals].sort((a, b) => a - b);
  const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;
  // ★ 卡死看门狗：worker 在同步长任务里 → 任何消息都停发。这里每秒刷新"已耗时"，
  //   用户就不会把"在算"误判成"死了"，也能把耗时直接告诉我定位慢在哪。
  if (engineBusy && lastWorkerMsgAt > 0) {
    const silent = Math.round((now - lastWorkerMsgAt) / 1000);
    if (silent >= 3) {
      setStatusText(`引擎正在计算（已 ${silent}s，期间界面会不动）——若是长时间卡住请把这句话告诉我`);
    }
  }
  const units = frame?.units.length ?? 0;
  const alive = frame?.units.filter((u) => u.alive && !u.evac).length ?? 0;
  if (currentPage === "sim") mapToolbar.tick();
  setText(diagRaw, `${JSON.stringify({
    fps, units, alive, tick: lastTick, playing: frame?.playing ?? false,
    busy: frame?.busy ?? false, frameP95ms: Math.round(p95 * 10) / 10,
    squads: frame?.squads?.length ?? 0, events: frame?.events.length ?? 0,
    page: currentPage,
    msgs: msgCounts, bridgeErrors: bridgeErrors.slice(-2),
    runErrors: runErrors.slice(-3),
    errors: errors.slice(-3),
  })}`);
  requestAnimationFrame(diagTick);
}
const diagRaw = el("span", "hidden");
$("#diag").appendChild(diagRaw);
let lastTickDiag = -1;

/* ------------------------------------------------------------------ 启动 */

/**
 * ★ V0.7 启动流程改变：**不再**一进来就初始化示例场景。
 *   顺序：载入本地配置库/编成 → 水合 SDE 数据 → 停在「① 数据导入」页。
 *   只有用户在「战场编成」点「生成推演」后，才会把自建配置交给引擎。
 */
requestAnimationFrame(diagTick);
window.addEventListener("resize", () => {
  map.resize();
  mapToolbar.tick();
});
document.title = "EVE 战局沙盒推演";

void (async () => {
  loadStore();
  let sdeOk = false;
  try {
    await loadSde();
    sdeOk = true;
  } catch (err) {
    setStatusText("SDE 数据加载失败：" + (err as Error).message);
  }
  // ★ 配装历史数据修补必须等 SDE 就绪：`repairFitModules` 靠 SDE 判断条目
  //   "是不是装备"，SDE 未就绪时会把查不到的装备误当"非装备"删掉。
  if (sdeOk) migrateFits();
  importPage.refresh();
  libraryPage.refresh();
  formationPage.refresh();
  setPage("import");
  setStatusText("请先导入 PYFA 配装数据 → 配置库 → 战场编成 → 生成推演。");
})();

window.addEventListener("load", () => {
  $("#diag").dataset.ready = "1";
});

/** 调试 / 自动化验收钩子（与 UI 走完全相同的通路，不绕过引擎）。 */
(globalThis as { __ui?: unknown }).__ui = {
  send,
  /** 载入指定示例场景（可指定每方单位数）。 */
  loadScenario: (scenarioId: string, unitsPerSide?: number) =>
    send({ type: "init", scenarioId, ...(unitsPerSide !== undefined ? { unitsPerSide } : {}) }),
  select: (ids: string[]) => applySelection(ids),
  fit: () => map.fit(),
  play: () => cb.play(),
  pause: () => cb.pause(),
  speed: (v: number) => cb.setSpeed(v),
  frame: () => frame,
  /** 图标加载情况（供渲染自检）。 */
  icons: () => iconsReady(),
  /** 布局与 DPI 度量（供双屏 / 高 DPI 验收）。 */
  metrics: () => {
    const cv = mapCanvas;
    return {
      dpr: window.devicePixelRatio,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      canvasCssW: cv.clientWidth,
      canvasCssH: cv.clientHeight,
      canvasBackingW: cv.width,
      canvasBackingH: cv.height,
      // 画布后备分辨率必须等于 CSS 尺寸 × dpr，否则高 DPI 下会发虚
      canvasCrisp: cv.width === Math.floor(cv.clientWidth * Math.min(2, window.devicePixelRatio || 1)),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      overflowY: document.documentElement.scrollHeight > window.innerHeight,
      icons: iconsReady(),
      units: frame?.units.length ?? 0,
      // 落在可视范围内的单位数：>0 才说明"舰队真的看得见"（取景没塌陷成亚像素）
      unitsOnScreen: map.onScreenUnitCount(),
      celestials: frame?.celestials?.length ?? 0,
      // 场景配置里的地物数（判定"下发是否完整"的基准，见 protocol.ts）
      landmarksExpected,
    };
  },
  /** 存档 / 载入（与界面按钮同一条通路）。 */
  save: () => cb.save(),
  loadSave: () => cb.load(),
  status: () => $("#ticker").textContent,
  /** ★ V0.7 四页流程钩子（无头验收用，走与界面完全相同的通路）。 */
  page: (id?: PageId) => {
    if (id) setPage(id);
    return currentPage;
  },
  importText: (text: string) => importPage.importText(text),
  libraryCount: () => fits.length,
  libraryIds: () => fits.map((f) => f.id),
  /** 配置库内容快照（诊断导入/解析问题用）。 */
  fits: () => fits.map((f) => ({
    name: f.name, shipName: f.shipName, shipTypeId: f.shipTypeId,
    mods: f.modules.map((m) => ({ typeId: m.typeId, name: m.name, charge: m.chargeName })),
    drones: f.drones.length, warnings: f.warnings,
  })),
  plan: () => getPlan(),
  generate: () => generateSim(getPlan()),
  terminate: () => cb.terminate(),
  /** 当前取景参数（只读）：验证"左键拖动沙盘"确实改变了视野。 */
  view: () => map.viewState(),
  /** 点导航栏某个标签页（与用户点击同一条通路）。 */
  nav: (id: PageId) => {
    const btn = document.querySelector<HTMLElement>(`#nav .nav-btn[data-page="${id}"]`);
    btn?.click();
  },
  /** 诊断：SDE 中文名 / 分组名，以及当前小队装备行（排查简写问题用）。 */
  zh: (id: number) => zhName(id),
  groupName: (id: number) => groupOf(id)?.name ?? "",
  squadModules: () => frame?.squads?.[0]?.modules?.map((m) => ({
    typeId: m.typeId, label: m.label, perShip: m.perShip, owned: m.owned, on: m.on,
  })) ?? [],
  /** 当前选中单位的锁定 / 最佳射程 / 有效射程环数据（验证 V7-5）。 */
  rings: () => frame?.units
    .filter((u) => selection.unitIds.has(u.id))
    .map((u) => ({
      id: u.id, lockRange: u.lockRange, range: u.range, rangeEff: u.rangeEff,
    })) ?? [],
  /** 本帧绘制自检：实际画出的环数 / 舰船名字数（验证"环只在单选、名字不画"）。 */
  renderStats: () => map.renderStats(),
  /** 场上存活组（无人机 / 铁骑）id，供"无人机图标平滑"流畅度采样。 */
  groupIds: () => map.groupIds(),
  /** 单位当前画布内屏幕坐标（合成鼠标事件用）。 */
  unitScreen: (id: string) => map.unitScreenPos(id),
  /** 当前选中的单位 id 列表（验证左侧选中 / 右键菜单选中）。 */
  selectedIds: () => [...selection.unitIds],
  /**
   * ★ 渲染流畅度采样（V0.7.1，V0.7.2 增补分位数）。
   *
   * 在 rAF 上连续采集某个单位的**渲染位置**（含插值），把每帧位移投影到
   * 整体运动方向上得到"有符号步长"，据此判定：
   *   - `frozenRatio`：位移≈0 的帧占比（卡住不动）
   *   - `backwardRatio`：回退的帧占比（被新一拍拽回来 = 抖动）
   *   - `jumpRatio`：**最大**步长 / 中位步长 —— 单帧 GC / 布局抖动就能把它顶起来，
   *     只适合当"有没有离谱跳变"的粗筛
   *   - `jumpP95Ratio`：**95 分位**步长 / 中位步长 —— 衡量"持续的一节一节感"，
   *     不受个别帧拖累，才是判定平滑度的主指标
   *   - `bigStepRatio`：步长 > 2× 中位值的帧占比
   */
  smoothness: (unitId: string, ms = 1600) => new Promise<{
    frames: number; fps: number; ticks: number; medianM: number;
    frozenRatio: number; backwardRatio: number; jumpRatio: number;
    jumpP95Ratio: number; bigStepRatio: number; moving: boolean;
  }>((resolve) => {
    // 以**世界米**为单位度量：比值与缩放无关，任何取景下都能判定连续性
    const tick0 = frame?.tick ?? 0;
    const pts: Array<{ x: number; y: number }> = [];
    const t0 = performance.now();
    const sample = (): void => {
      const p = map.probePos(unitId);
      if (p) pts.push(p);
      if (performance.now() - t0 < ms) {
        requestAnimationFrame(sample);
        return;
      }
      const steps: Array<{ x: number; y: number }> = [];
      for (let i = 1; i < pts.length; i++) {
        steps.push({ x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y });
      }
      // 整体运动方向（首点到末点）：把每步投影到它上面，才能分辨"前进/回退"
      const first = pts[0];
      const last = pts[pts.length - 1];
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      const len = Math.hypot(dx, dy);
      const ux = len > 1e-9 ? dx / len : 0;
      const uy = len > 1e-9 ? dy / len : 0;
      const signed = steps.map((s) => s.x * ux + s.y * uy);
      const abs = signed.map(Math.abs).sort((a, b) => a - b);
      const med = abs.length > 0 ? abs[abs.length >> 1] : 0;
      const moving = len > 1 && med > 1e-6;
      const thr = Math.max(1e-9, med * 0.15);
      let frozen = 0;
      let backward = 0;
      let maxStep = 0;
      let big = 0;
      for (const s of signed) {
        if (Math.abs(s) < thr) frozen++;
        if (s < -thr) backward++;
        if (Math.abs(s) > maxStep) maxStep = Math.abs(s);
        if (Math.abs(s) > med * 2) big++;
      }
      // 95 分位：比 max 稳，又比中位值更能反映"时不时来一下"
      const p95 = abs.length > 0 ? abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))] : 0;
      const elapsed = Math.max(1, performance.now() - t0);
      const ratio = (v: number): number => (med > 1e-6 ? Math.round((v / med) * 100) / 100 : 0);
      resolve({
        frames: pts.length,
        fps: Math.round((pts.length * 1000) / elapsed),
        ticks: (frame?.tick ?? 0) - tick0,
        medianM: Math.round(med * 1000) / 1000,
        frozenRatio: signed.length > 0 ? frozen / signed.length : 1,
        backwardRatio: signed.length > 0 ? backward / signed.length : 0,
        jumpRatio: ratio(maxStep),
        jumpP95Ratio: ratio(p95),
        bigStepRatio: signed.length > 0 ? Math.round((big / signed.length) * 1000) / 1000 : 0,
        moving,
      });
    };
    requestAnimationFrame(sample);
  }),
};

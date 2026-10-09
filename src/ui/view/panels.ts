/**
 * 左侧舰队列表 / 右侧战场控制 / 底部时间轴与事件流（§8.1、§8.2、§8.3、§8.5、§8.7）。
 *
 * ★ 三处针对上一版根因的结构性防护：
 *   - C1：模块按钮的身份是 **(kind, instanceIndex)**，命令也带着这个二元组下发；
 *         引擎侧再按"每条船自己的配装"解析成模块下标（B3），因此混编小队不会串味。
 *   - C2：换弹后**立即**用新弹药名刷新按钮脚标（脚标文本走变更检测，不依赖下一帧）。
 *   - C3/B5：列表**按签名增量重建**（结构不变则只更新数值），且整体 300~400ms 节流。
 */
import type { Command, CommandTarget } from "../../core/commands.ts";
import type { ChargeOption, Frame, ModuleRow, SquadFrame, WeaponRow } from "../protocol.ts";
import { clear, el, setClass, setText, setWidth, showContextMenu, throttle } from "../util/dom.ts";
import type { MenuItem } from "../util/dom.ts";
import { kindAbbr } from "../viewModel.ts";
import { sideColor, sideName } from "../app/sides.ts";
import { moduleLabelOf, weaponLabelOf } from "../util/labels.ts";
import { zhName } from "../sde.ts";

/**
 * 装备/武器按钮的内部分片（V0.7）：
 * `<button><i class="cyc"></i><span class="lbl"></span></button>`
 * —— `cyc` 是循环进度条（淡绿运转 / 淡红待停 / 武器绿色开火填充），`lbl` 是文字。
 * 用 WeakMap 缓存，避免每帧 querySelector（C3 禁项）。
 */
interface BtnParts { cyc: HTMLElement; lbl: HTMLElement }
const btnParts = new WeakMap<HTMLElement, BtnParts>();

/**
 * ★ 修复"第二次点击失效"：按钮是**增量复用**的（结构签名不变则只更新数值），
 * 但 click 回调若捕获建行时的 `m`/`w`，读到的就是**旧值**（如首帧的 on=0），
 * 于是"停用"永远算出 turnOn=true、被再次启用。
 * 这里把每行**最新**数据绑定到按钮节点上，click/右键一律读最新值。
 */
const moduleRowOf = new WeakMap<HTMLElement, ModuleRow>();
const weaponRowOf = new WeakMap<HTMLElement, WeaponRow>();

function makeActionButton(cls: string): HTMLElement {
  const b = el("button", cls);
  const cyc = el("i", "cyc");
  const lbl = el("span", "lbl");
  b.append(cyc, lbl);
  btnParts.set(b, { cyc, lbl });
  return b;
}

function partsOf(node: HTMLElement): BtnParts {
  let p = btnParts.get(node);
  if (!p) {
    p = { cyc: el("i", "cyc"), lbl: el("span", "lbl") };
    node.append(p.cyc, p.lbl);
    btnParts.set(node, p);
  }
  return p;
}

/** 进度条填充（0..1），写入前比较，避免每帧写样式。 */
const cycCache = new WeakMap<HTMLElement, number>();
function setCycle(node: HTMLElement, v: number): void {
  const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
  if (cycCache.get(node) === pct) return;
  cycCache.set(node, pct);
  node.style.setProperty("--cyc", `${pct}%`);
}

/** 武器按钮的右键菜单：换弹药（§8.3）。 */
async function ammoMenu(
  ev: MouseEvent, w: WeaponRow, target: CommandTarget, tick: number,
  cb: PanelCallbacks,
): Promise<void> {
  ev.preventDefault();
  const charges = await cb.listCharges(w.typeId);
  const items: MenuItem[] = charges.length === 0
    ? [{ label: "（该型号无可用弹药）", disabled: true }]
    : charges.map((c) => {
        // ★ 弹药名中文化：宿主桥返回的是 SDE 英文名，界面一律显示中文
        //   （zhName 取不到中文时回退英文名，绝不显示空白/typeId）。
        const zh = zhName(c.typeId) ?? c.name;
        return {
          label: zh,
          // 当前弹药以两种名字都比对（引擎侧用的是 PYFA 的项名，中英都有可能）
          hint: (w.chargeName && (w.chargeName === c.name || w.chargeName === zh)) ? "当前" : undefined,
          run: () => cb.send({
            tick, target, action: "setCharge",
            params: { typeId: w.typeId, chargeTypeId: c.typeId },
          }),
        };
      });
  showContextMenu(ev.clientX, ev.clientY, `${w.name} · 换弹药（当前 ${w.chargeName ?? "未装填"}）`, items);
}

/** 模块（如指挥脉冲波 / 电容注电器）的右键换弹：一行覆盖的实例一起换。 */
async function moduleAmmoMenu(
  ev: MouseEvent, m: ModuleRow, target: CommandTarget, tick: number,
  cb: PanelCallbacks,
): Promise<void> {
  ev.preventDefault();
  const charges = await cb.listCharges(m.typeId);
  const items: MenuItem[] = charges.length === 0
    ? [{ label: "（该型号无可用弹药 / 无需换弹）", disabled: true }]
    : charges.map((c) => {
        // ★ 弹药名中文化（同武器菜单）
        const zh = zhName(c.typeId) ?? c.name;
        return {
          label: zh,
          hint: (m.chargeName && (m.chargeName === c.name || m.chargeName === zh)) ? "当前" : undefined,
          run: () => {
            for (const inst of m.instances) {
              cb.send({
                tick, target, action: "setCharge",
                params: { kind: inst.kind, instanceIndex: inst.instanceIndex, typeId: m.typeId, chargeTypeId: c.typeId },
              });
            }
          },
        };
      });
  showContextMenu(ev.clientX, ev.clientY, `${moduleLabelOf(m.typeId, m.label)} · 换弹药（当前 ${m.chargeName ?? "未装填"}）`, items);
}

export type { ChargeOption };

export interface PanelCallbacks {
  send(cmd: Command): void;
  play(): void;
  pause(): void;
  setSpeed(speed: number): void;
  seek(tick: number): void;
  step(ticks: number): void;
  mark(): void;
  fork(atTick: number): void;
  switchBranch(id: string): void;
  changeScenario(id: string, unitsPerSide?: number): void;
  toggleSquadSelection(key: string): void;
  /** ★ 按「舰队 / 联队」层级选中：把该层级的全部存活单位交给沙盘高亮。 */
  selectUnits(ids: string[]): void;
  /** 查询某型号武器可装弹药（右键换弹）。 */
  listCharges(typeId: number): Promise<ChargeOption[]>;
  save(): void;
  load(): void;
  exportFile(): void;
  importFile(): void;
  /** 终止本次推演并返回「战场编成」页（V0.7）。 */
  terminate(): void;
}

export interface UiSelection {
  unitIds: Set<string>;
  squadKeys: Set<string>;
}

/* ------------------------------------------------------------------ 通用小组件 */

function barRow(cls: string): { root: HTMLElement; shield: HTMLElement; armor: HTMLElement; hull: HTMLElement } {
  const root = el("div", cls);
  const shield = el("i", "hp shield");
  const armor = el("i", "hp armor");
  const hull = el("i", "hp hull");
  root.append(shield, armor, hull);
  return { root, shield, armor, hull };
}

function setHpTriple(
  refs: { shield: HTMLElement; armor: HTMLElement; hull: HTMLElement },
  s: number, a: number, h: number,
): void {
  // 三段各自占容器 1/3 宽，用"填充比例"表示（避免布局变化）
  setStyleWidth(refs.shield, `--fill:${(Math.max(0, Math.min(1, s)) * 100).toFixed(1)}%`);
  setStyleWidth(refs.armor, `--fill:${(Math.max(0, Math.min(1, a)) * 100).toFixed(1)}%`);
  setStyleWidth(refs.hull, `--fill:${(Math.max(0, Math.min(1, h)) * 100).toFixed(1)}%`);
}

const styleCache = new WeakMap<HTMLElement, string>();
function setStyleWidth(node: HTMLElement, value: string): void {
  if (styleCache.get(node) === value) return;
  styleCache.set(node, value);
  node.style.setProperty("--fill", value.split(":")[1] ?? "0%");
}

/* ------------------------------------------------------------------ 左侧舰队列表 */

interface SquadRowRefs {
  root: HTMLElement;
  head: HTMLElement;
  title: HTMLElement;
  count: HTMLElement;
  stats: HTMLElement;
  bars: { shield: HTMLElement; armor: HTMLElement; hull: HTMLElement };
  moduleBox: HTMLElement;
  weaponBox: HTMLElement;
  /** 挂载的组（铁骑/无人机）——**独立显示**在交火列表里。 */
  groupBox: HTMLElement;
  moduleSig: string;
  weaponSig: string;
  collapsed: boolean;
}

export class FleetList {
  #root: HTMLElement;
  #cb: PanelCallbacks;
  #rows = new Map<string, SquadRowRefs>();
  #collapsedSides = new Set<number>();
  #signature = "";
  /** 最近一帧 —— 「舰队 / 联队 / 小队」层级选中要靠它筛出成员单位。 */
  #frame: Frame | null = null;

  constructor(root: HTMLElement, cb: PanelCallbacks) {
    this.#root = root;
    this.#cb = cb;
  }

  update(frame: Frame, selection: UiSelection): void {
    const squads = frame.squads;
    if (!squads) return;
    this.#frame = frame;
    const sig = `${squads.map((s) => s.key).join(",")}|${[...this.#collapsedSides].join(",")}`;
    if (sig !== this.#signature) {
      this.#signature = sig;
      this.#rebuild(squads);
    }
    for (const s of squads) this.#updateRow(s, frame, selection);
  }

  #rebuild(squads: SquadFrame[]): void {
    clear(this.#root);
    this.#rows.clear();

    const bySide = new Map<number, SquadFrame[]>();
    for (const s of squads) {
      const list = bySide.get(s.sideId);
      if (list) list.push(s);
      else bySide.set(s.sideId, [s]);
    }

    for (const sideId of [...bySide.keys()].sort()) {
      const head = el("div", "side-head");
      const dot = el("i", `dot side${sideId}`);
      // 多势力：颜色由「战场编成」决定（内置蓝/红之外的势力也能正确染色）
      dot.style.background = sideColor(sideId);
      const name = el("span", "side-name", sideName(sideId));
      const toggle = el("span", "collapse", "▾");
      head.append(dot, name, toggle);
      head.addEventListener("click", () => {
        if (this.#collapsedSides.has(sideId)) this.#collapsedSides.delete(sideId);
        else this.#collapsedSides.add(sideId);
        this.#signature = "";
      });
      this.#root.appendChild(head);

      const body = el("div", "side-body");
      if (this.#collapsedSides.has(sideId)) body.classList.add("hidden");
      setText(toggle, this.#collapsedSides.has(sideId) ? "▸" : "▾");
      this.#root.appendChild(body);

      // ★ 舰队 → 联队 → 小队 三级结构：每一级都能「选中」。
      //   用户要求：战场里单位一多，靠点沙盘图标很难选中整支部队，
      //   从左侧 UI 点一下就能把对应层级全部单位高亮出来。
      const byFleet = new Map<number, Map<number, SquadFrame[]>>();
      for (const s of bySide.get(sideId)!) {
        let wings = byFleet.get(s.fleetId);
        if (!wings) { wings = new Map(); byFleet.set(s.fleetId, wings); }
        const arr = wings.get(s.wingId);
        if (arr) arr.push(s);
        else wings.set(s.wingId, [s]);
      }
      for (const fleetId of [...byFleet.keys()].sort((a, b) => a - b)) {
        const wings = byFleet.get(fleetId)!;
        // ★ 增援部队**永远新开一个舰队**（不并入原舰队）—— 全增援的舰队单独标注，
        //   用户在左侧树里一眼就能认出哪些是后续增援进来的部队。
        const allReinforce = [...wings.values()].flat().every((s) => s.reinforce === true);
        const fleetLabel = allReinforce ? `增援舰队 ${fleetId + 1}` : `舰队 ${fleetId + 1}`;
        body.appendChild(this.#buildOrgRow("fleet", fleetLabel, { sideId, fleetId }));
        for (const wingId of [...wings.keys()].sort((a, b) => a - b)) {
          body.appendChild(this.#buildOrgRow("wing", `联队 ${wingId + 1}`, { sideId, fleetId, wingId }));
          for (const s of wings.get(wingId)!) body.appendChild(this.#buildRow(s));
        }
      }
    }
  }

  #buildRow(s: SquadFrame): HTMLElement {
    const root = el("div", "squad");
    const head = el("div", "squad-head");
    const toggle = el("span", "collapse", "▾");
    const title = el("span", "squad-title", s.shipName);
    const count = el("span", "squad-count num", `${s.alive}/${s.total}`);
    head.append(toggle, title, count);

    const stats = el("div", "squad-stats num");
    const bars = barRow("squad-bars");

    const moduleBox = el("div", "module-box");
    const weaponBox = el("div", "weapon-box");
    // 铁骑 / 无人机：与舰船分开、独立成块显示
    const groupBox = el("div", "group-box hidden");
    const body = el("div", "squad-body");
    body.append(stats, bars.root, groupBox, weaponBox, moduleBox);

    root.append(head, body);
    const refs: SquadRowRefs = {
      root, head, title, count, stats, bars, moduleBox, weaponBox, groupBox,
      moduleSig: "", weaponSig: "", collapsed: false,
    };

    head.title = "点击 = 在沙盘中选中该小队；点 ▾ = 展开 / 收起";
    // 点「▾」= 展开 / 收起；点标题或行的其余部分 = **选中该小队**（便于在杂乱战场中定位）
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      refs.collapsed = !refs.collapsed;
      body.classList.toggle("hidden", refs.collapsed);
      setText(toggle, refs.collapsed ? "▸" : "▾");
    });
    head.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains("module") || t.classList.contains("weapon")) return;
      this.#selectLevel({ sideId: s.sideId, fleetId: s.fleetId, wingId: s.wingId, squadId: s.squadId });
    });

    this.#rows.set(s.key, refs);
    return root;
  }

  /** 舰队 / 联队层级的「选中」行（点整行即选中该层级的全部存活单位）。 */
  #buildOrgRow(
    kind: "fleet" | "wing",
    label: string,
    at: { sideId: number; fleetId: number; wingId?: number },
  ): HTMLElement {
    const row = el("div", `org-row org-${kind}`);
    row.title = `选中${label}的全部单位`;
    row.append(el("span", "org-name", label), el("span", "org-pick", "选中"));
    row.addEventListener("click", () => this.#selectLevel(at));
    return row;
  }

  /**
   * 按层级筛选**存活**单位并交给上层选定。
   *
   * 只给 `sideId`+`fleetId` = 整支舰队；再加 `wingId` = 该联队；再加 `squadId` = 该小队。
   */
  #selectLevel(at: { sideId: number; fleetId: number; wingId?: number; squadId?: number }): void {
    const units = this.#frame?.units ?? [];
    const ids = units
      .filter((u) =>
        u.alive && !u.evac
        && u.sideId === at.sideId && u.fleetId === at.fleetId
        && (at.wingId === undefined || u.wingId === at.wingId)
        && (at.squadId === undefined || u.squadId === at.squadId))
      .map((u) => u.id);
    if (ids.length > 0) this.#cb.selectUnits(ids);
  }

  /**
   * 渲染小队挂载的「组」（铁骑纵队 / 无人机组）。
   *
   * ★ 用户要求：它们属于**实体**，要在舰队交火列表里**独立显示**。
   * 点击一行 = 把这组设为选中单位的主目标（`setTarget` + kind/groupId）——
   * 铁骑/无人机因此可以被独立攻击，而不是只能打母舰。
   */
  #renderGroups(box: HTMLElement, s: SquadFrame, frame: Frame, selection: UiSelection): void {
    const units = frame.units.filter(
      (u) => u.alive && u.sideId === s.sideId && u.fleetId === s.fleetId
        && u.wingId === s.wingId && u.squadId === s.squadId,
    );
    interface Agg {
      kind: "fighter" | "drone";
      name: string;
      groupId: string;
      hostId: string;
      hpSum: number;
      samples: number;
      total: number;
      targeted: boolean;
    }
    const agg = new Map<string, Agg>();
    for (const u of units) {
      for (const g of u.groups) {
        if (!g.alive) continue;
        const key = `${g.kind}|${g.name}`;
        const cur = agg.get(key);
        if (cur) {
          cur.hpSum += g.hp; cur.samples++; cur.total += g.tubes;
          cur.targeted = cur.targeted || g.targeted;
        } else {
          agg.set(key, {
            kind: g.kind, name: g.name, groupId: g.id, hostId: u.id,
            hpSum: g.hp, samples: 1, total: g.tubes, targeted: g.targeted,
          });
        }
      }
    }

    const sig = [...agg.entries()]
      .map(([k, v]) => `${k}#${v.total}:${Math.round((v.hpSum / v.samples) * 100)}:${v.targeted ? 1 : 0}`)
      .join(",") + `|${selection.unitIds.size}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;

    clear(box);
    if (agg.size === 0) {
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    for (const v of agg.values()) {
      const row = el("div", `group-row ${v.kind}`);
      const tag = el("span", "group-tag", v.kind === "fighter" ? "铁骑" : "无人机");
      const nm = el("span", "group-name", v.name);
      const cnt = el("span", "group-count num", `×${v.total}`);
      const bar = el("span", "group-hp");
      const fill = el("i");
      fill.style.width = `${Math.round((v.hpSum / v.samples) * 100)}%`;
      bar.appendChild(fill);
      row.append(tag, nm, cnt, bar);
      if (v.targeted) row.classList.add("targeted");
      row.title = "点击：把该组设为选中单位的主目标（铁骑/无人机是实体，可被独立攻击）";
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        if (selection.unitIds.size === 0) return;
        this.#cb.send({
          tick: -1,
          target: { unitIds: [...selection.unitIds] },
          action: "setTarget",
          params: { targetId: v.hostId, kind: v.kind, groupId: v.groupId },
        });
      });
      box.appendChild(row);
    }
  }

  #updateRow(s: SquadFrame, frame: Frame, selection: UiSelection): void {
    const r = this.#rows.get(s.key);
    if (!r) return;

    this.#renderGroups(r.groupBox, s, frame, selection);

    const tick = frame.tick;
    const target = { sideId: s.sideId, squadId: s.squadId } as const;

    setText(r.count, `${s.alive}/${s.total}`);
    setText(r.stats,
      `单舰 ${s.dpsSingle.toFixed(0)} DPS · 全队 ${s.dpsTotal.toFixed(0)} · ${(s.velocity).toFixed(0)} m/s`);
    setHpTriple(r.bars, s.shield, s.armor, s.hull);
    setClass(r.root, "sel", selection.squadKeys.has(s.key));
    setClass(r.root, "dead", s.alive === 0);

    // 武器行（按型号 typeId）
    const wsig = s.weapons.map((w) => w.typeId).join(",");
    if (wsig !== r.weaponSig) {
      r.weaponSig = wsig;
      clear(r.weaponBox);
      for (const w of s.weapons) r.weaponBox.appendChild(this.#buildWeaponButton(w, s, tick));
    } else {
      const nodes = r.weaponBox.children;
      for (let i = 0; i < s.weapons.length && i < nodes.length; i++) {
        this.#updateWeaponButton(nodes[i] as HTMLElement, s.weapons[i], s, tick);
      }
    }

    // 模块行（按**型号 typeId** 聚合，V0.7 中文简写）
    const msig = s.modules.map((m) => String(m.typeId)).join(",");
    if (msig !== r.moduleSig) {
      r.moduleSig = msig;
      clear(r.moduleBox);
      for (const m of s.modules) r.moduleBox.appendChild(this.#buildModuleButton(m, s, tick));
    } else {
      const nodes = r.moduleBox.children;
      for (let i = 0; i < s.modules.length && i < nodes.length; i++) {
        this.#updateModuleButton(nodes[i] as HTMLElement, s.modules[i], s, tick);
      }
    }
  }

  #buildWeaponButton(w: WeaponRow, s: SquadFrame, tick: number): HTMLElement {
    void tick;
    const n = makeActionButton("weapon");
    weaponRowOf.set(n, w);
    const target: CommandTarget = { sideId: s.sideId, squadId: s.squadId };
    n.addEventListener("click", () => {
      // ★ 读**最新**行数据（增量复用下闭包里的 w 会过期）；tick 用 -1 = 当前 tick，
      //   避免带回建行时的旧 tick 而在事后被误判为"回溯"、生成多余分支。
      const cur = weaponRowOf.get(n);
      if (!cur) return;
      this.#cb.send({
        tick: -1, target, action: "toggleWeapon",
        // ★ 用 total（门数）判断"是否全在打"；owned 是"船数"，两者单位不同
        params: { typeId: cur.typeId, on: !(cur.total > 0 && cur.on >= cur.total) },
      });
    });
    n.addEventListener("contextmenu", (ev) => {
      const cur = weaponRowOf.get(n) ?? w;
      void ammoMenu(ev, cur, target, -1, this.#cb);
    });
    return n;
  }

  #updateWeaponButton(n: HTMLElement, w: WeaponRow, s: SquadFrame, tick: number): void {
    weaponRowOf.set(n, w);
    // ★ 用 total（门数）；「停火」只在**一门都没在打**时显示（部分开火用 mixed 样式）
    const onAll = w.total > 0 && w.on >= w.total;
    const silent = w.on <= 0;
    const p = partsOf(n);
    const wname = weaponLabelOf(w.typeId, w.name);
    setText(p.lbl, `${wname} ×${w.owned}${silent ? " 停火" : ""}`);
    // 武器开火循环：绿色填充
    setCycle(p.cyc, w.cycle);
    setClass(n, "on", onAll);
    setClass(n, "mixed", w.on > 0 && !onAll);
    n.title = `${wname}｜弹药 ${w.chargeName ?? "未装填"}`
      + `\n射程 ${(w.range / 1000).toFixed(1)}km+${(w.falloff / 1000).toFixed(1)}km`
      + `（最佳 ${(w.range / 1000).toFixed(1)} km／有效 ${((w.range + w.falloff) / 1000).toFixed(1)} km）`
      + ` · 循环 ${(w.rof / 1000).toFixed(2)} s`
      + `\n开火状态：${w.on}/${w.total} 门在打`
      + `\n左键：全队开/停火　右键：换弹药`;
    void s;
    void tick;
  }

  #buildModuleButton(m: ModuleRow, s: SquadFrame, tick: number): HTMLElement {
    void tick;
    const n = makeActionButton("module");
    n.dataset.key = String(m.typeId); // 便于自动化验收按型号定位（不改变语义）
    moduleRowOf.set(n, m);
    n.addEventListener("click", () => {
      // 一行 = 该**型号**的全部实例（A/C 两舰各装 2 个 → 一起启停）。
      // ★ 身份仍是 (kind, instanceIndex) 二元组，逐条下发（C1）。
      //   实例列表是按舰累积的（6 舰 × 2 = 12 条），同序号只需下发一次。
      // ★ 读**最新**行数据：增量复用下闭包里的 m 会过期，否则"停用"会被算成"启用"。
      const cur = moduleRowOf.get(n);
      if (!cur) return;
      const turnOn = !(cur.owned > 0 && cur.on >= cur.owned);
      const target: CommandTarget = { sideId: s.sideId, squadId: s.squadId };
      const sent = new Set<number>();
      for (const inst of cur.instances) {
        if (sent.has(inst.instanceIndex)) continue;
        sent.add(inst.instanceIndex);
        this.#cb.send({
          tick: -1, target, action: "toggleModule",
          params: { kind: inst.kind, instanceIndex: inst.instanceIndex, state: turnOn ? "active" : "online" },
        });
      }
    });
    n.addEventListener("contextmenu", (ev) => {
      const cur = moduleRowOf.get(n) ?? m;
      void moduleAmmoMenu(ev, cur, { sideId: s.sideId, squadId: s.squadId }, -1, this.#cb);
    });
    return n;
  }

  #updateModuleButton(n: HTMLElement, m: ModuleRow, s: SquadFrame, tick: number): void {
    moduleRowOf.set(n, m);
    const onAll = m.owned > 0 && m.on >= m.owned;
    const pending = m.pendingOff > 0;
    const p = partsOf(n);
    // ★ V0.7：中文简写 + 每船数量 ×N + (运行/总数)
    setText(p.lbl, `${moduleLabelOf(m.typeId, m.label)} ×${m.perShip} (${m.on}/${m.owned})${pending ? " 停用中" : ""}`);
    setCycle(p.cyc, m.cycle);
    setClass(n, "on", onAll);
    setClass(n, "mixed", m.on > 0 && !onAll);
    setClass(n, "pending", pending);
    n.title = `${kindAbbr(m.kind)}｜${m.label}`
      + `\n每船 ${m.perShip} 个 · 本小队共 ${m.owned} 个，${m.on} 个运转中${pending ? "，其余本轮走完即停" : ""}`
      + (m.chargeName ? `\n弹药：${m.chargeName}` : "")
      + `\n左键：该型号全部启停`
      + `\n右键：更换弹药`;
    void s;
    void tick;
  }
}

/* ------------------------------------------------------------------ 右侧战场控制 */

export class ControlPanel {
  #root: HTMLElement;
  #cb: PanelCallbacks;
  #scenarioSelect!: HTMLSelectElement;
  #playBtn!: HTMLButtonElement;
  #speedSel!: HTMLSelectElement;
  #orderBox!: HTMLElement;
  #moduleBox!: HTMLElement;
  #weaponBox!: HTMLElement;
  #reportBox!: HTMLElement;
  #tickLabel!: HTMLElement;
  #moduleSig = "";
  #weaponSig = "";
  /** 交火模式按钮（用于高亮当前模式：永远显示四种模式之一）。 */
  #doctrineBtns = new Map<string, HTMLElement>();

  constructor(root: HTMLElement, cb: PanelCallbacks) {
    this.#root = root;
    this.#cb = cb;
    this.#build();
  }

  #build(): void {
    const root = this.#root;
    clear(root);

    /* 场景 */
    const sc = el("section", "panel");
    sc.appendChild(el("h3", undefined, "场景"));
    const scRow = el("div", "row");
    this.#scenarioSelect = el("select");
    for (const s of [
      ["duel", "单挑靶船"], ["line-brawl", "战列线对决"], ["logi-line", "后勤掩护线"],
      ["tackle-line", "网船压制"], ["stress", "压力测试（200 单位）"],
    ]) {
      const o = el("option", undefined, s[1]);
      o.value = s[0];
      this.#scenarioSelect.appendChild(o);
    }
    this.#scenarioSelect.value = "line-brawl";
    const loadBtn = el("button", "primary", "载入");
    loadBtn.addEventListener("click", () =>
      this.#cb.changeScenario(this.#scenarioSelect.value));
    scRow.append(this.#scenarioSelect, loadBtn);
    sc.appendChild(scRow);

    /* 推演控制 */
    const play = el("section", "panel");
    play.appendChild(el("h3", undefined, "推演控制"));
    const row1 = el("div", "row");
    this.#playBtn = el("button", "primary");
    setText(this.#playBtn, "▶ 播放");
    this.#playBtn.addEventListener("click", () => {
      if (this.#playBtn.dataset.playing === "1") this.#cb.pause();
      else this.#cb.play();
    });
    const stepBtn = el("button", undefined, "单步 1s");
    stepBtn.addEventListener("click", () => this.#cb.step(1));
    const step10 = el("button", undefined, "单步 10s");
    step10.addEventListener("click", () => this.#cb.step(10));
    row1.append(this.#playBtn, stepBtn, step10);
    play.appendChild(row1);

    const row2 = el("div", "row");
    this.#speedSel = el("select");
    for (const v of [0.25, 1, 2, 4, 8, 15, 30]) {
      const o = el("option", undefined, `${v}×`);
      o.value = String(v);
      this.#speedSel.appendChild(o);
    }
    this.#speedSel.value = "4";
    this.#speedSel.addEventListener("change", () => this.#cb.setSpeed(Number(this.#speedSel.value)));
    const markBtn = el("button", undefined, "⚑ 关键标记");
    markBtn.addEventListener("click", () => this.#cb.mark());
    this.#tickLabel = el("span", "num muted");
    row2.append(el("span", "muted", "倍速"), this.#speedSel, markBtn, this.#tickLabel);
    play.appendChild(row2);
    root.appendChild(play);

    /* 舰队指令 */
    const orders = el("section", "panel");
    orders.appendChild(el("h3", undefined, "舰队指令（作用于选中单位）"));
    const docRow = el("div", "row btns");
    // ★ V0.8：交火模式固定为这**四种**，且**永远处于其中之一**（不再有"不载入模式"）。
    //   默认 = 自动攻击（见 store.makeSquad）。
    const doctrines: Array<[string, string, string]> = [
      ["focus", "集中火力", "保持主目标（无则取最近）"],
      ["free", "自由开火", "各自打最近的敌人"],
      ["auto", "自动攻击", "自动接敌并保持主目标（默认）"],
      ["antiFighter", "集火舰载机",
        "优先打射程内的敌方铁骑纵队；射程内没有敌铁骑时，才回退到普通优先级（打单位）"],
    ];
    for (const [d, label, hint] of doctrines) {
      const b = el("button", undefined, label);
      b.title = hint;
      b.addEventListener("click", () =>
        this.#cb.send({ tick: -1, target: {}, action: "setDoctrine", params: { doctrine: d } }));
      docRow.appendChild(b);
      this.#doctrineBtns.set(d, b);
    }
    orders.appendChild(docRow);

    const moveRow = el("div", "row btns");
    const moves: Array<[string, string, string]> = [
      ["hold", "待命", "原地不动，按交火方式接敌"],
      ["approach", "接近", "向主目标接近至约 80% 射程"],
      ["orbit", "环绕", "以主目标为中心环绕 20km"],
      ["keepAtRange", "保持距离", "与主目标保持 20km"],
      ["stop", "停止", "只停机动，火力继续（与红警不同）"],
      ["align", "对齐", "仅朝向，为起跳做准备"],
      ["warpOut", "撤离", "起跳离场（受扰断影响）"],
    ];
    for (const [type, label, hint] of moves) {
      const b = el("button", undefined, label);
      b.title = hint;
      if (type === "stop") b.classList.add("warn");
      b.addEventListener("click", () => {
        const params: Record<string, unknown> = { type };
        if (type === "orbit") params.range = 20_000;
        if (type === "keepAtRange") params.range = 20_000;
        this.#cb.send({ tick: -1, target: {}, action: "setOrder", params });
      });
      moveRow.appendChild(b);
    }
    orders.appendChild(moveRow);
    this.#orderBox = orders;
    root.appendChild(orders);

    /* 装备与火力 */
    const mod = el("section", "panel");
    mod.appendChild(el("h3", undefined, "装备与火力"));
    this.#moduleBox = el("div", "module-box");
    this.#weaponBox = el("div", "weapon-box");
    mod.append(this.#weaponBox, this.#moduleBox);
    root.appendChild(mod);

    /* 战报 */
    const rep = el("section", "panel");
    rep.appendChild(el("h3", undefined, "战报"));
    this.#reportBox = el("div", "report");
    rep.appendChild(this.#reportBox);
    root.appendChild(rep);

    /* 存档 / 载入（D-18：JSON，写入 PYFA 版本号） */
    const save = el("section", "panel");
    save.appendChild(el("h3", undefined, "存档 / 载入"));
    const srow = el("div", "row btns");
    const mk = (label: string, hint: string, run: () => void): HTMLButtonElement => {
      const b = el("button", undefined, label);
      b.title = hint;
      b.addEventListener("click", run);
      return b;
    };
    srow.append(
      mk("保存", "保存到浏览器本地存储", () => this.#cb.save()),
      mk("载入", "从本地存储载入", () => this.#cb.load()),
      mk("导出 .json", "导出为存档文件", () => this.#cb.exportFile()),
      mk("导入 .json", "从存档文件载入", () => this.#cb.importFile()),
    );
    save.appendChild(srow);
    // ★ V0.7：终止推演（紧挨保存/载入）
    const trow = el("div", "row btns");
    const term = el("button", "terminate", "■ 终止推演") as HTMLButtonElement;
    term.title = "结束本次推演并返回「战场编成」，可重新调整编成后再生成";
    term.addEventListener("click", () => this.#cb.terminate());
    trow.appendChild(term);
    save.appendChild(trow);
    save.appendChild(el("div", "muted",
      "存档只记「场景 + 命令表 + 种子 + PYFA 版本」；状态由重放得到（D-18）。"));
    root.appendChild(save);
  }

  update(frame: Frame, selection: UiSelection): void {
    const playing = frame.playing;
    this.#playBtn.dataset.playing = playing ? "1" : "0";
    setText(this.#playBtn, playing ? "⏸ 暂停" : "▶ 播放");
    if (document.activeElement !== this.#speedSel) this.#speedSel.value = String(frame.speed);
    setText(this.#tickLabel, `T+${frame.tick}s${frame.busy ? ` · ${frame.busyNote}` : ""}`);

    // ★ 交火模式高亮：**永远显示当前模式**（选中单位一致时用它们的模式；
    //   未选中 / 混合 / 未知（如旧数据里的 passive）一律按「自动攻击」显示）。
    {
      const sel = selection.unitIds.size > 0
        ? frame.units.filter((u) => selection.unitIds.has(u.id))
        : [];
      const modes = new Set(sel.map((u) => u.doctrine));
      const only = modes.size === 1 ? [...modes][0] : null;
      const cur = only && this.#doctrineBtns.has(only) ? only : "auto";
      for (const [d, b] of this.#doctrineBtns) setClass(b, "on", d === cur);
    }

    const squads = frame.squads;
    if (squads && squads.length > 0) {
      const active = selection.squadKeys.size > 0
        ? squads.filter((s) => selection.squadKeys.has(s.key))
        : squads;
      const modules = mergeModules(active);
      const weapons = mergeWeapons(active);
      const msig = modules.map((m) => String(m.typeId)).join(",");
      const wsig = weapons.map((w) => w.typeId).join(",");
      if (msig !== this.#moduleSig || wsig !== this.#weaponSig) {
        this.#moduleSig = msig;
        this.#weaponSig = wsig;
        this.#rebuildModuleRows(modules, frame.tick);
        this.#rebuildWeaponRows(weapons, frame.tick);
      } else {
        this.#refreshModuleRows(modules, frame.tick);
        this.#refreshWeaponRows(weapons, frame.tick);
      }
    }

    if (frame.report) {
      clear(this.#reportBox);
      for (const s of frame.report.sides) {
        const b = el("div", `rep-side side${s.sideId} num`);
        b.append(
          el("div", "rep-title", sideName(s.sideId)),
          el("div", undefined, `参战 ${s.start} → 存活 ${s.alive}｜损毁 ${s.killed}｜撤离 ${s.evacuated}`),
          el("div", undefined, `造成伤害 ${s.damageDealt.toLocaleString()}｜承受 ${s.damageTaken.toLocaleString()}`),
        );
        this.#reportBox.appendChild(b);
      }
      const w = frame.report;
      this.#reportBox.appendChild(el("div", "muted",
        w.finished ? `已结束｜${
          w.winnerSideId === null ? "同归于尽" : `${sideName(w.winnerSideId)}获胜`
        }｜时长 T+${w.ticks}s` : `进行中｜T+${w.ticks}s`));
    }
  }

  /** 装备行：按**型号 typeId** 聚合（一行 = 该型号的全部实例）。 */
  #rebuildModuleRows(rows: ModuleRow[], tick: number): void {
    clear(this.#moduleBox);
    for (const m of rows) {
      const b = makeActionButton("module");
      b.dataset.key = String(m.typeId);
      moduleRowOf.set(b, m);
      b.addEventListener("click", () => {
        // ★ 读最新行数据（增量刷新下闭包会过期，否则"停用"会被算成"启用"）；
        //   tick 用 -1 = 当前 tick，避免带回旧 tick 被误判为"回溯"。
        const cur = moduleRowOf.get(b);
        if (!cur) return;
        const turnOn = !(cur.owned > 0 && cur.on >= cur.owned);
        const sent = new Set<number>();
        for (const inst of cur.instances) {
          if (sent.has(inst.instanceIndex)) continue;
          sent.add(inst.instanceIndex);
          this.#cb.send({
            tick: -1, target: {}, action: "toggleModule",
            params: { kind: inst.kind, instanceIndex: inst.instanceIndex, state: turnOn ? "active" : "online" },
          });
        }
      });
      b.addEventListener("contextmenu", (ev) => {
        const cur = moduleRowOf.get(b) ?? m;
        void moduleAmmoMenu(ev, cur, {}, -1, this.#cb);
      });
      this.#moduleBox.appendChild(b);
    }
    this.#refreshModuleRows(rows, tick);
  }

  #refreshModuleRows(rows: ModuleRow[], tick: number): void {
    const nodes = this.#moduleBox.children;
    for (let i = 0; i < rows.length && i < nodes.length; i++) {
      const m = rows[i];
      const n = nodes[i] as HTMLElement;
      moduleRowOf.set(n, m);
      const onAll = m.owned > 0 && m.on >= m.owned;
      const p = partsOf(n);
      const label = moduleLabelOf(m.typeId, m.label);
      // ★ V0.7 中文简写 + ×每船数量 + (运行/总数)
      setText(p.lbl, `${label} ×${m.perShip} (${m.on}/${m.owned})${m.pendingOff > 0 ? " 停用中" : ""}`);
      setCycle(p.cyc, m.cycle);
      setClass(n, "on", onAll);
      setClass(n, "mixed", m.on > 0 && !onAll);
      setClass(n, "pending", m.pendingOff > 0);
      const isBurst = m.kind === "commandBurst";
      n.title = `${kindAbbr(m.kind)}｜${label}｜每船 ${m.perShip} 个`
        + `\n全队 ${m.owned} 个，${m.on} 个运转中${m.pendingOff > 0 ? "，" + m.pendingOff + " 个本轮走完即停" : ""}`
        + (isBurst ? `\n弹药：${m.chargeName ?? "未装填"}` : "")
        + "\n左键：该型号全部启停（只影响真装了的船）"
        + "\n右键：更换弹药";
    }
    void tick;
  }

  #rebuildWeaponRows(rows: WeaponRow[], tick: number): void {
    clear(this.#weaponBox);
    for (const w of rows) {
      const b = makeActionButton("weapon");
      b.dataset.typeId = String(w.typeId);
      weaponRowOf.set(b, w);
      b.addEventListener("click", () => {
        const cur = weaponRowOf.get(b);
        if (!cur) return;
        const onAll = cur.total > 0 && cur.on >= cur.total;
        this.#cb.send({ tick: -1, target: {}, action: "toggleWeapon", params: { typeId: cur.typeId, on: !onAll } });
      });
      b.addEventListener("contextmenu", (ev) => {
        const cur = weaponRowOf.get(b) ?? w;
        void ammoMenu(ev, cur, {}, -1, this.#cb);
      });
      this.#weaponBox.appendChild(b);
    }
    this.#refreshWeaponRows(rows, tick);
  }

  #refreshWeaponRows(rows: WeaponRow[], tick: number): void {
    const nodes = this.#weaponBox.children;
    for (let i = 0; i < rows.length && i < nodes.length; i++) {
      const w = rows[i];
      const n = nodes[i] as HTMLElement;
      weaponRowOf.set(n, w);
      const onAll = w.total > 0 && w.on >= w.total;
      const silent = w.on <= 0;
      const p = partsOf(n);
      const wname = weaponLabelOf(w.typeId, w.name);
      // ★ C2：文字（弹药名）随数据刷新，换弹后无需等下一帧
      setText(p.lbl, `${wname} ×${w.owned}｜${w.chargeName ?? "未装填"}${silent ? " 停火" : ""}`);
      // 武器开火循环：绿色填充
      setCycle(p.cyc, w.cycle);
      setClass(n, "on", onAll);
      setClass(n, "mixed", w.on > 0 && !onAll);
      n.title = `${wname}\n射程 ${(w.range / 1000).toFixed(1)}km+${(w.falloff / 1000).toFixed(1)}km`
        + `（最佳 ${(w.range / 1000).toFixed(1)} km／有效 ${((w.range + w.falloff) / 1000).toFixed(1)} km）`
        + `｜循环 ${(w.rof / 1000).toFixed(2)} s\n弹药：${w.chargeName ?? "未装填"}`;
    }
    void tick;
  }

  get scenarioId(): string {
    return this.#scenarioSelect.value;
  }
}

function mergeModules(squads: SquadFrame[]): ModuleRow[] {
  const map = new Map<number, ModuleRow>();
  for (const s of squads) {
    for (const m of s.modules) {
      const hit = map.get(m.typeId);
      if (hit) {
        hit.owned += m.owned;
        hit.on += m.on;
        hit.pendingOff += m.pendingOff;
        hit.cycle = Math.max(hit.cycle, m.cycle);
        for (const inst of m.instances) hit.instances.push(inst);
      } else {
        map.set(m.typeId, { ...m, instances: [...m.instances] });
      }
    }
  }
  return [...map.values()];
}

function mergeWeapons(squads: SquadFrame[]): WeaponRow[] {
  const map = new Map<number, WeaponRow>();
  for (const s of squads) {
    for (const w of s.weapons) {
      const hit = map.get(w.typeId);
      if (hit) {
        hit.owned += w.owned;
        hit.on += w.on;
        if (w.chargeName) hit.chargeName = w.chargeName;
      } else {
        map.set(w.typeId, { ...w });
      }
    }
  }
  return [...map.values()];
}

/* ------------------------------------------------------------------ 底部时间轴 */

export class TimelineBar {
  #root: HTMLElement;
  #cb: PanelCallbacks;
  #range!: HTMLInputElement;
  #marks!: HTMLElement;
  #branchSel!: HTMLSelectElement;
  #label!: HTMLElement;
  #sig = "";

  constructor(root: HTMLElement, cb: PanelCallbacks) {
    this.#root = root;
    this.#cb = cb;
    this.#build();
  }

  #build(): void {
    clear(this.#root);
    const top = el("div", "tl-top");
    this.#label = el("span", "num", "T+0s");
    this.#branchSel = el("select");
    this.#branchSel.addEventListener("change", () => this.#cb.switchBranch(this.#branchSel.value));
    const forkBtn = el("button", undefined, "⑂ 从此处分支");
    forkBtn.title = "回溯后修改会生成新分支（时间线不会覆盖）";
    forkBtn.addEventListener("click", () => this.#cb.fork(Number(this.#range.value)));
    top.append(this.#label, el("span", "muted", "分支"), this.#branchSel, forkBtn);
    this.#root.appendChild(top);

    const track = el("div", "tl-track");
    this.#range = el("input", "tl-range") as HTMLInputElement;
    this.#range.type = "range";
    this.#range.min = "0";
    this.#range.max = "600";
    this.#range.step = "1";
    // ★ 拖动时间轴时 `input` 会每个像素触发一次；每次都发 seek 会让 Worker 排上
    //   一长串"从关键帧整段重算"的任务（拖一次能排几十条），表现为程序卡死。
    //   这里做节流：拖动中最快每 120ms 发一次，松手（change）时一定补发最终值。
    let seekTimer: number | null = null;
    let sentTick = Number(this.#range.value);
    const fireSeek = (): void => {
      const t = Number(this.#range.value);
      if (t === sentTick) return;
      sentTick = t;
      this.#cb.seek(t);
    };
    this.#range.addEventListener("input", () => {
      if (seekTimer !== null) return;
      seekTimer = window.setTimeout(() => { seekTimer = null; fireSeek(); }, 120);
    });
    this.#range.addEventListener("change", () => {
      if (seekTimer !== null) { window.clearTimeout(seekTimer); seekTimer = null; }
      fireSeek();
    });
    this.#marks = el("div", "tl-marks");
    track.append(this.#range, this.#marks);
    this.#root.appendChild(track);
  }

  update(frame: Frame): void {
    const max = Math.max(600, Math.ceil((frame.tick + 1) / 600) * 600);
    if (this.#range.max !== String(max)) this.#range.max = String(max);
    if (document.activeElement !== this.#range) this.#range.value = String(frame.tick);
    setText(this.#label, `T+${frame.tick}s`);

    const sig = `${frame.marks.join(",")}|${frame.keyframes.length}|${frame.branches.map((b) => b.id).join(",")}|${max}|${frame.currentBranch}`;
    if (sig !== this.#sig) {
      this.#sig = sig;
      clear(this.#marks);
      for (const k of frame.keyframes) {
        const d = el("i", "kf");
        d.style.left = `${(k / max) * 100}%`;
        d.title = `自动关键帧 T+${k}s`;
        this.#marks.appendChild(d);
      }
      for (const m of frame.marks) {
        const d = el("i", "mk");
        d.style.left = `${(m / max) * 100}%`;
        d.title = `关键标记 T+${m}s`;
        this.#marks.appendChild(d);
      }
      clear(this.#branchSel);
      for (const b of frame.branches) {
        const o = el("option", undefined, `${b.id}（${b.commandCount} 条命令）`);
        o.value = b.id;
        this.#branchSel.appendChild(o);
      }
      this.#branchSel.value = frame.currentBranch;
    }
  }
}

/* ------------------------------------------------------------------ 事件流 */

export class EventStream {
  #root: HTMLElement;
  #list!: HTMLElement;
  #killOnly = false;
  #buf: Frame["events"] = [];
  #flush: () => void;
  #cmdLog!: HTMLElement;

  constructor(root: HTMLElement, _cb: PanelCallbacks) {
    this.#root = root;
    this.#flush = throttle(() => this.#render(), 350);
    this.#build();
  }

  #build(): void {
    clear(this.#root);
    const head = el("div", "ev-head");
    const title = el("span", undefined, "事件流");
    const label = el("label", "chk");
    const cb = el("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.addEventListener("change", () => {
      this.#killOnly = cb.checked;
      this.#render();
    });
    label.append(cb, el("span", undefined, "只看击毁"));
    head.append(title, label);
    this.#root.appendChild(head);

    this.#list = el("div", "ev-list");
    this.#root.appendChild(this.#list);

    this.#cmdLog = el("div", "cmd-log");
    this.#root.appendChild(this.#cmdLog);
  }

  push(events: Frame["events"]): void {
    if (events.length === 0) return;
    this.#buf.push(...events);
    if (this.#buf.length > 400) this.#buf.splice(0, this.#buf.length - 400);
    this.#flush();
  }

  updateCommandLog(frame: Frame): void {
    const last = frame.commandLog.slice(-6).reverse();
    clear(this.#cmdLog);
    for (const c of last) {
      const row = el("div", "cmd-row");
      row.append(
        el("span", "cmd-tick num", `T+${c.tick}s`),
        el("span", "cmd-note", c.note ?? c.action),
      );
      this.#cmdLog.appendChild(row);
    }
  }

  #render(): void {
    const items = this.#killOnly ? this.#buf.filter((e) => e.type === "kill") : this.#buf;
    const view = items.slice(-160);
    clear(this.#list);
    for (const e of view) {
      const row = el("div", `ev ev-${e.type}`);
      row.append(el("span", "ev-tick num", `T+${e.tick}`));
      const side = e.sideId === undefined ? "" : `${sideName(e.sideId)} `;
      row.append(el("span", "ev-text", `${side}${describe(e)}`));
      this.#list.appendChild(row);
    }
    this.#list.scrollTop = this.#list.scrollHeight;
  }
}

function describe(e: Frame["events"][number]): string {
  const who = e.unitName ?? e.unitId ?? "";
  const tgt = e.targetName ?? e.targetId ?? "";
  switch (e.type) {
    case "kill": return `${who}（${e.shipName ?? ""}）被击毁`;
    case "lock": return `${who} 锁定 ${tgt}`;
    case "logi": return `${who} 维修 ${tgt} +${Math.round(e.amount ?? 0)}`;
    case "capTransfer": return `${who} 传电 → ${tgt} +${Math.round(e.amount ?? 0)}`;
    case "neut": return `${who} 毁电 → ${tgt} -${Math.round(e.amount ?? 0)}`;
    case "nos": return `${who} 吸电 → ${tgt} ${Math.round(e.amount ?? 0)}`;
    case "ewar": return `${who} ${e.detail ?? "电子战"} → ${tgt}`;
    case "warp": return `${who} 起跳`;
    case "evacuate": return `${who} 已撤离战场`;
    case "fire": return `${who} 开火 → ${tgt}`;
    case "hit": return `${who} 命中 ${tgt} -${Math.round(e.amount ?? 0)}`;
    case "miss": return `${who} 未命中 ${tgt}`;
    default: return `${who} ${e.type}`;
  }
}

/* 供外部使用（保持 setWidth 引用，避免被裁剪） */
export { setWidth };

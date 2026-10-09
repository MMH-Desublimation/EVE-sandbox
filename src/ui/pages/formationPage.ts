/**
 * ③ 战场编成页。
 *
 * 用户可自由调整：势力数量（不止红蓝）与颜色 → 舰队 → 联队 → 小队 → 每小队舰船数量与属性。
 * 「后勤传电链」按角色自动编成：勾了「自动后勤链」且配置确实带遥修/传电模块的小队，
 * 会被编入本舰队后勤并按需维护目标链（链本身由引擎在运行期自动构建）。
 * 编成只描述**编成**，确认后点「生成推演」交给引擎。
 */
import { el } from "../util/dom.ts";
import { fits, getPlan, SIDE_PALETTE, makeFleet, makeSquad, makeSide, makeWing, mutatePlan } from "../app/store.ts";
import type { FormationPlan, SquadDoctrine, SquadPlan, SquadRole } from "../app/store.ts";

export interface FormationPage {
  root: HTMLElement;
  refresh(): void;
}

const ROLE_LABEL: Record<SquadRole, string> = {
  line: "主力", logi: "后勤", capital: "旗舰", structure: "建筑/结构",
};
const DOCTRINE_LABEL: Record<SquadDoctrine, string> = {
  focus: "集火", free: "自由开火", auto: "自动", antiFighter: "反铁骑", passive: "被动待命",
};

export function createFormationPage(onGenerate: (plan: FormationPlan) => void): FormationPage {
  const root = el("section", "page-inner formation-page");

  const head = el("div", "page-head");
  head.append(
    el("h2", "page-title", "③ 战场编成"),
    el("span", "page-hint", "调势力 / 舰队 / 联队 / 小队与数量，确认后生成推演。"),
  );
  root.append(head);

  /* ---------------------------------------------------------- 星系参数 */

  const labelInput = el("input", "inp") as HTMLInputElement;
  const labelInputWrap = el("label", "field", "编成标签");

  const radiusInput = el("input", "inp num") as HTMLInputElement;
  radiusInput.type = "number";
  radiusInput.min = "1";
  radiusInput.step = "0.5";
  const radiusField = el("label", "field", "星系半径 (AU)");

  const gateSelect = el("select", "inp") as HTMLSelectElement;
  for (const n of [1, 2, 3]) {
    const o = el("option", "", `${n} 个`) as HTMLOptionElement;
    o.value = String(n);
    gateSelect.append(o);
  }
  const gateField = el("label", "field", "星门数量（随机分布中/外圈）");

  const seedInput = el("input", "inp num") as HTMLInputElement;
  seedInput.type = "number";
  const seedField = el("label", "field", "随机种子");

  labelInputWrap.append(labelInput);
  radiusField.append(radiusInput);
  gateField.append(gateSelect);
  seedField.append(seedInput);

  const sysBar = el("div", "card sys-bar");
  sysBar.append(
    el("h3", "card-title", "星系与推演参数"),
    labelInputWrap, radiusField, gateField, seedField,
    el("p", "page-hint", "半径只影响星系圆边界与星门分布；舰队在星系中心按交战尺度展开（否则射程外永远打不起来）。"),
  );
  root.append(sysBar);

  /* ---------------------------------------------------------- 势力树 */

  const tree = el("div", "formation-tree");
  root.append(tree);

  const addSideBtn = el("button", "btn", "＋ 新增势力") as HTMLButtonElement;
  root.append(addSideBtn);

  /* ---------------------------------------------------------- 底部 */

  const stats = el("div", "formation-stats");
  const genBtn = el("button", "btn primary big", "生成推演 ▶") as HTMLButtonElement;
  const wWarn = el("div", "formation-warn");
  const footer = el("div", "formation-footer");
  footer.append(stats, genBtn);
  root.append(footer, wWarn);

  /* ---------------------------------------------------------- 绑定 */

  labelInput.addEventListener("change", () => mutatePlan((p) => { p.label = labelInput.value.trim() || "自定义编成"; }));
  radiusInput.addEventListener("change", () => {
    mutatePlan((p) => { p.radiusAU = Math.max(1, Number(radiusInput.value) || p.radiusAU); });
    updateStats();
  });
  gateSelect.addEventListener("change", () => mutatePlan((p) => { p.gateCount = Number(gateSelect.value) || 1; }));
  seedInput.addEventListener("change", () => mutatePlan((p) => { p.seed = Math.floor(Number(seedInput.value) || 0); }));

  addSideBtn.addEventListener("click", () => {
    mutatePlan((p) => {
      const side = makeSide(p.sides.length, fits[0]?.id ?? null);
      // 用调色板里还没用过的颜色
      const used = new Set(p.sides.map((s) => s.color));
      side.color = SIDE_PALETTE.find((c) => !used.has(c)) ?? SIDE_PALETTE[p.sides.length % SIDE_PALETTE.length];
      p.sides.push(side);
    });
    renderTree();
    updateStats();
  });

  genBtn.addEventListener("click", () => onGenerate(currentPlan()));

  /* ---------------------------------------------------------- 渲染 */

  function renderTree(): void {
    const p = currentPlan();
    labelInput.value = p.label;
    radiusInput.value = String(p.radiusAU);
    gateSelect.value = String(Math.min(3, Math.max(1, p.gateCount)));
    seedInput.value = String(p.seed);

    tree.replaceChildren();
    p.sides.forEach((side, si) => {
      const card = el("div", "card side-card");
      card.style.borderLeftColor = side.color;

      // —— 势力头
      const color = el("input", "color-inp") as HTMLInputElement;
      color.type = "color";
      color.value = side.color;
      color.addEventListener("change", () => {
        mutatePlan((pl) => { const s = pl.sides[si]; if (s) s.color = color.value; });
        card.style.borderLeftColor = color.value;
      });

      const name = el("input", "inp side-name") as HTMLInputElement;
      name.value = side.name;
      name.addEventListener("change", () => { mutatePlan((pl) => { const s = pl.sides[si]; if (s) s.name = name.value.trim() || s.name; }); updateStats(); });

      const shipsBadge = el("span", "side-ships num");

      const delSide = el("button", "btn danger small", "删除势力") as HTMLButtonElement;
      delSide.addEventListener("click", () => {
        if (p.sides.length <= 1) return;
        mutatePlan((pl) => pl.sides.splice(si, 1));
        renderTree();
        updateStats();
      });

      const sideHead = el("div", "side-head");
      sideHead.append(color, el("span", "side-tag", `势力 ${si + 1}`), name, shipsBadge, delSide);
      card.append(sideHead);

      // —— 舰队
      for (const [fi, fleet] of side.fleets.entries()) {
        const fCard = el("div", "fleet-card");
        const fName = el("input", "inp fleet-name") as HTMLInputElement;
        fName.value = fleet.name;
        fName.addEventListener("change", () => mutatePlan((pl) => { const f = pl.sides[si]?.fleets[fi]; if (f) f.name = fName.value.trim() || f.name; }));

        const delFleet = el("button", "btn danger tiny", "删舰队") as HTMLButtonElement;
        delFleet.addEventListener("click", () => {
          mutatePlan((pl) => pl.sides[si]?.fleets.splice(fi, 1));
          renderTree(); updateStats();
        });
        const fHead = el("div", "fleet-head");
        fHead.append(el("span", "mini-tag", "舰队"), fName, delFleet);
        fCard.append(fHead);

        for (const [wi, wing] of fleet.wings.entries()) {
          const wCard = el("div", "wing-card");
          const wName = el("input", "inp wing-name") as HTMLInputElement;
          wName.value = wing.name;
          wName.addEventListener("change", () => mutatePlan((pl) => { const w = pl.sides[si]?.fleets[fi]?.wings[wi]; if (w) w.name = wName.value.trim() || w.name; }));

          const delWing = el("button", "btn danger tiny", "删联队") as HTMLButtonElement;
          delWing.addEventListener("click", () => {
            mutatePlan((pl) => pl.sides[si]?.fleets[fi]?.wings.splice(wi, 1));
            renderTree(); updateStats();
          });

          const wHead = el("div", "wing-head");
          wHead.append(el("span", "mini-tag", "联队"), wName, delWing);
          wCard.append(wHead);

          // —— 小队
          const table = el("div", "squad-table");
          wing.squads.forEach((squad, qi) => {
            table.append(squadRow(si, fi, wi, qi, squad));
          });
          wCard.append(table);

          const addSquad = el("button", "btn tiny", "＋ 小队") as HTMLButtonElement;
          addSquad.addEventListener("click", () => {
            mutatePlan((pl) => pl.sides[si]?.fleets[fi]?.wings[wi]?.squads.push(makeSquad(`小队 ${(pl.sides[si]?.fleets[fi]?.wings[wi]?.squads.length ?? 0) + 1}`, fits[0]?.id ?? null)));
            renderTree(); updateStats();
          });
          wCard.append(addSquad);
          fCard.append(wCard);
        }

        const addWing = el("button", "btn tiny", "＋ 联队") as HTMLButtonElement;
        addWing.addEventListener("click", () => {
          mutatePlan((pl) => pl.sides[si]?.fleets[fi]?.wings.push(makeWing(`联队 ${(pl.sides[si]?.fleets[fi]?.wings.length ?? 0) + 1}`, fits[0]?.id ?? null)));
          renderTree(); updateStats();
        });
        fCard.append(addWing);
        card.append(fCard);
      }

      const addFleet = el("button", "btn tiny", "＋ 舰队") as HTMLButtonElement;
      addFleet.addEventListener("click", () => {
        mutatePlan((pl) => pl.sides[si]?.fleets.push(makeFleet(`舰队 ${(pl.sides[si]?.fleets.length ?? 0) + 1}`, fits[0]?.id ?? null)));
        renderTree(); updateStats();
      });
      card.append(addFleet);
      cards.set(si, shipsBadge);
      tree.append(card);
    });
    updateStats();
  }

  /** 记录每个势力的舰船数徽标，供 updateStats 更新。 */
  const cards = new Map<number, HTMLElement>();

  function squadRow(si: number, fi: number, wi: number, qi: number, squad: SquadPlan): HTMLElement {
    const row = el("div", "squad-row");

    const name = el("input", "inp squad-name") as HTMLInputElement;
    name.value = squad.name;
    name.addEventListener("change", () => mutatePlan((pl) => { const q = pl.sides[si]?.fleets[fi]?.wings[wi]?.squads[qi]; if (q) q.name = name.value.trim() || q.name; }));

    const fitSel = el("select", "inp squad-fit") as HTMLSelectElement;
    const empty = el("option", "", "（空编）") as HTMLOptionElement;
    empty.value = "";
    fitSel.append(empty);
    for (const f of fits) {
      const o = el("option", "", `${f.name} · ${f.shipName}`) as HTMLOptionElement;
      o.value = f.id;
      fitSel.append(o);
    }
    fitSel.value = squad.fitId ?? "";
    fitSel.addEventListener("change", () => {
      mutatePlan((pl) => { const q = pl.sides[si]?.fleets[fi]?.wings[wi]?.squads[qi]; if (q) q.fitId = fitSel.value || null; });
      updateStats();
    });

    const count = el("input", "inp num squad-count") as HTMLInputElement;
    count.type = "number";
    count.min = "0";
    count.value = String(squad.count);
    count.addEventListener("change", () => {
      mutatePlan((pl) => { const q = pl.sides[si]?.fleets[fi]?.wings[wi]?.squads[qi]; if (q) q.count = Math.max(0, Math.floor(Number(count.value) || 0)); });
      updateStats();
    });

    const role = el("select", "inp squad-role") as HTMLSelectElement;
    for (const [v, t] of Object.entries(ROLE_LABEL)) {
      const o = el("option", "", t) as HTMLOptionElement;
      o.value = v;
      role.append(o);
    }
    role.value = squad.role;
    role.addEventListener("change", () => mutatePlan((pl) => { const q = pl.sides[si]?.fleets[fi]?.wings[wi]?.squads[qi]; if (q) q.role = role.value as SquadRole; }));

    const doctrine = el("select", "inp squad-doctrine") as HTMLSelectElement;
    for (const [v, t] of Object.entries(DOCTRINE_LABEL)) {
      const o = el("option", "", t) as HTMLOptionElement;
      o.value = v;
      doctrine.append(o);
    }
    doctrine.value = squad.doctrine;
    doctrine.addEventListener("change", () => mutatePlan((pl) => { const q = pl.sides[si]?.fleets[fi]?.wings[wi]?.squads[qi]; if (q) q.doctrine = doctrine.value as SquadDoctrine; }));

    const logiWrap = el("label", "chk");
    const logi = el("input") as HTMLInputElement;
    logi.type = "checkbox";
    logi.checked = squad.autoLogi;
    logi.addEventListener("change", () => mutatePlan((pl) => { const q = pl.sides[si]?.fleets[fi]?.wings[wi]?.squads[qi]; if (q) q.autoLogi = logi.checked; }));
    logiWrap.append(logi, el("span", "", "自动后勤链"));

    const del = el("button", "btn danger tiny", "✕") as HTMLButtonElement;
    del.addEventListener("click", () => {
      mutatePlan((pl) => pl.sides[si]?.fleets[fi]?.wings[wi]?.squads.splice(qi, 1));
      renderTree(); updateStats();
    });

    row.append(name, fitSel, count, role, doctrine, logiWrap, del);
    return row;
  }

  function currentPlan(): FormationPlan {
    return getPlan();
  }

  function updateStats(): void {
    const p = getPlan();
    const perSide = p.sides.map((side) =>
      side.fleets.reduce((a, f) => a + f.wings.reduce((b, w) => b + w.squads.reduce((c, q) => c + (q.fitId ? Math.max(0, q.count) : 0), 0), 0), 0));
    perSide.forEach((n, i) => {
      const badge = cards.get(i);
      if (badge) badge.textContent = `${n} 艘`;
    });
    const total = perSide.reduce((a, b) => a + b, 0);
    stats.textContent = `共 ${p.sides.length} 势力 · ${total} 艘舰船（${perSide.join(" / ")}）· 半径 ${p.radiusAU} AU · ${p.gateCount} 星门`;
    const empty = total === 0;
    genBtn.disabled = empty;
    wWarn.textContent = empty ? "编成为空：请至少给一个小队指定配置与数量。" : "";
  }

  function refresh(): void {
    renderTree();
  }

  refresh();
  return { root, refresh };
}

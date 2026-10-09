/**
 * ② 配置库页。
 *
 * 列表 + 修改 + 重命名 + 删除 + 新建；右侧是**无图标纯文字版配船编辑器**
 * （对齐 PYFA 的文字配装习惯：一行一个装备，逗号后跟弹药，无人机写 `名称 x数量`）。
 * 只做结构编辑（装的是什么、装几门），数值一律由引擎 / PYFA oracle 决定。
 */
import { el } from "../util/dom.ts";
import { fits, getFit, newId, removeFit, updateFit, onStoreChange } from "../app/store.ts";
import type { FitEntry } from "../app/store.ts";
import { parseClipboard } from "../app/fitIO.ts";
import * as sde from "../sde.ts";

export interface LibraryPage {
  root: HTMLElement;
  refresh(): void;
  /** 供「战场编成」跳转过来时高亮某份配置。 */
  select(id: string | null): void;
}

export function createLibraryPage(onChanged: () => void): LibraryPage {
  const root = el("section", "page-inner library-page");

  const head = el("div", "page-head");
  head.append(
    el("h2", "page-title", "② 配置库"),
    el("span", "page-hint", "配置即「舰船 + 装备 + 弹药」的清单，可被任意数量的舰船套用。"),
  );
  root.append(head);

  const search = el("input", "search-box") as HTMLInputElement;
  search.placeholder = "搜索配置名 / 舰船…";
  const newBtn = el("button", "btn", "＋ 新建空白配置") as HTMLButtonElement;
  const toolbar = el("div", "lib-toolbar");
  toolbar.append(search, newBtn);

  const listWrap = el("div", "lib-list");
  const editor = el("div", "lib-editor");
  const body = el("div", "lib-body");
  body.append(listWrap, editor);

  const footer = el("div", "lib-footer");
  root.append(toolbar, body, footer);

  let selectedId: string | null = null;

  /* ----------------------------------------------------------- 列表 */

  function renderList(): void {
    listWrap.replaceChildren();
    const q = search.value.trim().toLowerCase();
    const list = fits.filter((f) =>
      !q || f.name.toLowerCase().includes(q) || f.shipName.toLowerCase().includes(q));
    if (list.length === 0) {
      listWrap.append(el("div", "muted", fits.length === 0
        ? "配置库是空的 —— 先去「数据导入」把 PYFA 配装导进来。"
        : "没有匹配的配置。"));
      return;
    }
    for (const f of list) {
      const row = el("div", "lib-row" + (f.id === selectedId ? " active" : ""));
      row.append(
        el("span", "lib-row-name", f.name),
        el("span", "lib-row-ship", f.shipName),
        el("span", "lib-row-meta num", `${f.modules.length} 件`),
      );
      if (f.warnings?.length) row.append(el("span", "fit-warn", "⚠"));
      row.addEventListener("click", () => {
        selectedId = f.id;
        renderList();
        renderEditor();
      });
      listWrap.append(row);
    }
  }

  /* ----------------------------------------------------------- 编辑器 */

  function renderEditor(): void {
    editor.replaceChildren();
    const fit = getFit(selectedId);
    if (!fit) {
      editor.append(el("div", "muted", "选择左侧一份配置开始编辑。"));
      return;
    }

    const nameInput = el("input", "edit-name") as HTMLInputElement;
    nameInput.value = fit.name;
    nameInput.placeholder = "配置名";

    const shipInput = el("input", "edit-ship-search") as HTMLInputElement;
    shipInput.placeholder = "搜索舰船（中文 / 英文名）…";
    const shipNow = el("div", "edit-ship-now", `当前舰船：${fit.shipName} (typeId ${fit.shipTypeId})`);
    const shipHits = el("div", "ship-hits");

    const text = el("textarea", "fit-text") as HTMLTextAreaElement;
    text.spellcheck = false;
    text.value = fitToText(fit);

    const saveBtn = el("button", "btn primary", "保存修改") as HTMLButtonElement;
    const dupBtn = el("button", "btn", "复制一份") as HTMLButtonElement;
    const delBtn = el("button", "btn danger", "删除") as HTMLButtonElement;
    const status = el("span", "edit-status");

    const actions = el("div", "row");
    actions.append(saveBtn, dupBtn, delBtn, status);

    editor.append(
      el("div", "edit-field", ), nameInput,
      el("div", "edit-legend", "舰船"),
      shipNow, shipInput, shipHits,
      el("div", "edit-legend", "配装文本（一行一件：`装备名, 弹药名`；无人机写 `名称 x数量`）"),
      text, actions,
    );

    // —— 舰船搜索
    shipInput.addEventListener("input", () => {
      const q = shipInput.value.trim();
      shipHits.replaceChildren();
      if (q.length < 2) return;
      const hits = sde.searchName(q, 24).filter((h) => sde.hull(h.id));
      for (const h of hits.slice(0, 12)) {
        const item = el("div", "ship-hit");
        item.append(el("span", "", h.zh ?? h.name ?? String(h.id)), el("span", "num muted", `#${h.id}`));
        item.addEventListener("click", () => {
          updateFit(fit.id, { shipTypeId: h.id, shipName: h.zh ?? h.name ?? String(h.id) });
          shipHits.replaceChildren();
          shipInput.value = "";
          renderList();
          renderEditor();
          onChanged();
        });
        shipHits.append(item);
      }
    });

    // —— 保存
    saveBtn.addEventListener("click", () => {
      const name = nameInput.value.trim() || fit.name;
      const parsed = parseClipboard(text.value, "手工编辑");
      const first = parsed.fits[0];
      if (!first) {
        status.textContent = "解析失败：请确认首行是 `[舰船名, 配置名]` 或至少有一件装备。";
        status.className = "edit-status warn";
        return;
      }
      // 舰船以编辑器里选定的为准（除非文本里换了船）
      const shipChanged = first.shipTypeId !== fit.shipTypeId;
      updateFit(fit.id, {
        name,
        shipTypeId: shipChanged ? first.shipTypeId : fit.shipTypeId,
        shipName: shipChanged ? first.shipName : fit.shipName,
        modules: first.modules,
        drones: first.drones,
        fighters: first.fighters,
        warnings: parsed.warnings.length ? parsed.warnings : undefined,
        source: "manual",
      });
      status.textContent = `已保存：${first.modules.length} 件装备` + (parsed.warnings.length ? `（${parsed.warnings.length} 条提示）` : "");
      status.className = "edit-status ok";
      renderList();
      renderEditor();
      onChanged();
    });

    // —— 复制
    dupBtn.addEventListener("click", () => {
      const copy: FitEntry = { ...fit, id: newId("fit"), name: `${fit.name} 副本`, importedAt: Date.now() };
      fits.push(copy);
      selectedId = copy.id;
      onChanged();
      renderList();
      renderEditor();
    });

    // —— 删除
    delBtn.addEventListener("click", () => {
      removeFit(fit.id);
      selectedId = null;
      renderList();
      renderEditor();
      onChanged();
    });
  }

  /* ----------------------------------------------------------- 事件 */

  search.addEventListener("input", renderList);

  newBtn.addEventListener("click", () => {
    const blank: FitEntry = {
      id: newId("fit"),
      name: `新配置 ${fits.length + 1}`,
      shipTypeId: 0,
      shipName: "（未选舰船）",
      modules: [],
      drones: [],
      fighters: [],
      source: "manual",
      importedAt: Date.now(),
    };
    fits.push(blank);
    selectedId = blank.id;
    onChanged();
    renderList();
    renderEditor();
  });

  const unsub = onStoreChange(() => {
    renderList();
  });

  function refresh(): void {
    renderList();
    renderEditor();
  }

  function select(id: string | null): void {
    selectedId = id;
    renderList();
    renderEditor();
  }

  refresh();
  void unsub;

  return { root, refresh, select };
}

/** FitEntry → 纯文字配装文本（可直接回贴到编辑器 / PYFA）。 */
export function fitToText(fit: FitEntry): string {
  const lines: string[] = [];
  lines.push(`[${fit.shipName}, ${fit.name}]`);
  for (const m of fit.modules) {
    const name = m.name ?? (m.typeId !== undefined ? sde.zhName(m.typeId) ?? `#${m.typeId}` : "?");
    const charge = m.chargeName ? `, ${m.chargeName}` : "";
    lines.push(`${name}${charge}`);
  }
  for (const d of fit.drones) {
    const name = d.name ?? (d.typeId !== undefined ? sde.zhName(d.typeId) ?? `#${d.typeId}` : "?");
    lines.push(`${name} x${d.count ?? 1}`);
  }
  for (const f of fit.fighters) {
    const name = f.name ?? (f.typeId !== undefined ? sde.zhName(f.typeId) ?? `#${f.typeId}` : "?");
    lines.push(`${name} x${f.count ?? 1}`);
  }
  return lines.join("\n");
}

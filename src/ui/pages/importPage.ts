/**
 * ① 数据导入页。
 *
 * 用途：把 PYFA 的配装数据喂进「配置库」。
 *  - 剪贴板 / 文本框：粘贴 EFT 文本（PYFA 右键「复制」的格式），一键解析入库；
 *  - 文件：单个或批量拖入/选择 PYFA 导出的 XML，逐份解析入库。
 * 识别成功后**自动入库**（用户要求），并列出本次入库名单，可一键撤销。
 */
import { el } from "../util/dom.ts";
import { addFits, fits, removeFit } from "../app/store.ts";
import type { FitEntry } from "../app/store.ts";
import { parseAuto, parsePyfaXml } from "../app/fitIO.ts";

export interface ImportPage {
  root: HTMLElement;
  refresh(): void;
  /** 以编程方式导入一段文本/XML（供自动化验收走与界面相同的通路）。 */
  importText(text: string, origin?: string): number;
}

export function createImportPage(): ImportPage {
  const root = el("section", "page-inner import-page");

  root.appendChild(el("h2", "page-title", "① 数据导入"));
  root.appendChild(el("p", "page-hint",
    "把 PYFA 导出的配装 XML 拖进来，或直接粘贴 EFT 文本（PYFA 里右键配置 →「复制」）。识别成功即自动进入「配置库」。",
  ));

  /* ---------------- 粘贴区 ---------------- */
  const paste = el("textarea", "paste-box") as HTMLTextAreaElement;
  paste.placeholder = "[Apocalypse Navy Issue, 我的配装]\nMega Beam Laser II, Standard L\nHeat Sink II\n...";
  paste.spellcheck = false;

  const readClip = el("button", "btn", "读剪贴板") as HTMLButtonElement;
  const parseBtn = el("button", "btn primary", "解析并入库") as HTMLButtonElement;
  const pasteRow = el("div", "row");
  pasteRow.append(readClip, parseBtn);

  const pasteCard = el("div", "card");
  pasteCard.append(el("h3", "card-title", "从剪贴板 / 文本粘贴"), paste, pasteRow);

  /* ---------------- 文件区 ---------------- */
  const fileInput = el("input", "file-input") as HTMLInputElement;
  fileInput.type = "file";
  fileInput.accept = ".xml,text/xml,application/xml";
  fileInput.multiple = true;

  const drop = el("div", "drop-zone");
  drop.append(el("div", "drop-hint", "把 PYFA 导出的 XML 文件拖到这里（支持多份）"), fileInput);

  const fileCard = el("div", "card");
  fileCard.append(el("h3", "card-title", "导入 PYFA XML 文件"), drop);

  const grid = el("div", "import-grid");
  grid.append(pasteCard, fileCard);

  /* ---------------- 结果区 ---------------- */
  const resultTitle = el("h3", "card-title", "本次导入");
  const resultList = el("div", "import-result");
  const undoBtn = el("button", "btn", "撤销本次导入") as HTMLButtonElement;
  undoBtn.disabled = true;
  const resultCard = el("div", "card");
  resultCard.append(resultTitle, resultList, undoBtn);

  /* ---------------- 统计 ---------------- */
  const stat = el("div", "import-stat");

  root.append(grid, stat, resultCard);

  let lastIds: string[] = [];

  function showResult(added: FitEntry[], warnings: string[]): void {
    resultList.replaceChildren();
    for (const f of added) {
      const row = el("div", "import-row");
      row.append(
        el("span", "fit-name", f.name),
        el("span", "fit-ship", f.shipName),
        el("span", "fit-meta num", `${f.modules.length} 装备 · ${f.drones.length} 无人机 · ${f.fighters.length} 铁骑`),
        el("span", "fit-src", srcLabel(f.source)),
      );
      if (f.warnings?.length) row.append(el("span", "fit-warn", `⚠ ${f.warnings.join("；")}`));
      resultList.append(row);
    }
    for (const w of warnings) resultList.append(el("div", "import-warn", `⚠ ${w}`));
    if (added.length === 0 && warnings.length === 0) {
      resultList.append(el("div", "muted", "暂无导入记录。"));
    }
    undoBtn.disabled = added.length === 0;
    lastIds = added.map((f) => f.id);
  }

  function commit(fits_parsed: FitEntry[], warnings: string[]): void {
    const added = addFits(fits_parsed);
    showResult(added, warnings);
    refresh();
  }

  /* ---------------- 事件 ---------------- */
  readClip.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setStat("剪贴板为空。", true);
        return;
      }
      paste.value = text;
      setStat("已读入剪贴板，请点「解析并入库」。");
    } catch (e) {
      setStat(`读取剪贴板失败：${(e as Error).message}（可手动粘贴到文本框）`, true);
    }
  });

  parseBtn.addEventListener("click", () => {
    const text = paste.value.trim();
    if (!text) {
      setStat("文本框为空。", true);
      return;
    }
    const r = parseAuto(text, "剪贴板");
    commit(r.fits, r.warnings);
    setStat(r.fits.length > 0
      ? `已解析 ${r.fits.length} 份并入库。`
      : "未能解析出配装，请检查格式。", r.fits.length === 0);
  });

  const consumeFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    let total = 0;
    const warns: string[] = [];
    const collected: FitEntry[] = [];
    for (const file of list) {
      try {
        const text = await file.text();
        const r = parsePyfaXml(text, file.name);
        collected.push(...r.fits);
        warns.push(...r.warnings.map((w) => `${file.name}: ${w}`));
        total += r.fits.length;
      } catch (e) {
        warns.push(`${file.name}: 读取失败 ${(e as Error).message}`);
      }
    }
    commit(collected, warns);
    setStat(total > 0 ? `已从 ${list.length} 个文件解析 ${total} 份并入库。` : "文件中未识别到配装。", total === 0);
  };

  fileInput.addEventListener("change", () => {
    if (fileInput.files) void consumeFiles(fileInput.files);
    fileInput.value = "";
  });

  for (const ev of ["dragenter", "dragover"] as const) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
  }
  for (const ev of ["dragleave", "drop"] as const) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("over");
    });
  }
  drop.addEventListener("drop", (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.files?.length) void consumeFiles(dt.files);
  });

  undoBtn.addEventListener("click", () => {
    for (const id of lastIds) removeFit(id);
    showResult([], []);
    setStat(`已撤销 ${lastIds.length} 份导入。`);
    refresh();
  });

  function setStat(text: string, warn = false): void {
    stat.textContent = text;
    stat.classList.toggle("warn", warn);
  }

  function refresh(): void {
    stat.textContent = `配置库现有 ${fits.length} 份配置。`;
    stat.classList.remove("warn");
  }

  /** 编程式导入：与「解析并入库」按钮同一条解析/入库通路。 */
  function importText(text: string, origin = "程序导入"): number {
    const r = parseAuto(text, origin);
    commit(r.fits, r.warnings);
    setStat(r.fits.length > 0 ? `已解析 ${r.fits.length} 份并入库。` : "未能解析出配装。", r.fits.length === 0);
    paste.value = text;
    return r.fits.length;
  }

  refresh();
  showResult([], []);

  return { root, refresh, importText };
}

function srcLabel(src: FitEntry["source"]): string {
  return src === "pyfa-xml" ? "XML" : src === "clipboard" ? "剪贴板" : "手工";
}

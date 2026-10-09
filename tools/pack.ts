/**
 * 打包（阶段 4）。
 *
 * 产出 dist/ ：
 *   EveSandbox.exe      宿主（自包含 .NET + WebView2，双击即用）
 *   ui/                 界面产物（由 build-ui 生成）
 *   sidecar/            StatOracle 脚本（**不含 PYFA 代码**）
 *   compliance/         合规说明与 GPLv3 文本
 *   README.txt          快速开始
 *
 * ★ 发行包内**不含任何 PYFA 代码**：PYFA 由用户自行安装，
 *   程序在用户机器上运行时现场提取（见 compliance/NOTICE.md）。
 *
 * 用法： node tools/pack.ts [--skip-publish]
 */
import { copyFile, cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const BUILD = join(ROOT, "build", "host");

/** 发行版本名（同时作为可执行文件名与说明书名）。 */
const APP_NAME = "EVE战局沙盘推演 V0.8";
/** 说明书（若已生成则一并放进发行包）。 */
const MANUAL = `${APP_NAME.replace("EVE战局沙盘推演", "程序使用说明")}.docx`;

const skipPublish = process.argv.includes("--skip-publish");

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else total += (await stat(p)).size;
  }
  return total;
}

function human(bytes: number): string {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function run(cmd: string, args: string[], cwd = ROOT): void {
  console.log(`[pack] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: false });
}

const README = `EVE战局沙盘推演 V0.8 —— 快速开始
======================================

完整说明见同目录的《程序使用说明 V0.8》（Word 文档）。

1) 前置：本机已安装 PYFA（https://github.com/pyfa-org/PyFA）与 Python 3.14.x。
   本软件**不包含** PYFA 的代码，用到的是你自己安装的 PYFA。

2) 双击「EVE战局沙盘推演 V0.8.exe」。
   首次运行会弹出设置向导：选择 PYFA 安装目录（含 pyfa.exe 的那个文件夹）
   与 Python 3.14 解释器。程序会先做一次核心提取（约 1 分钟），之后启动只需数百毫秒。

3) 阅读并同意免责声明后即可使用。

★ 核心原则：所有属性数据都以你自己的 PYFA 实算为准（不查表、不估算）。
  属性缓存键 = 配装指纹 + 模块开关状态 + 环境键（脑插与指挥脉冲）。

操作
----
左键选择 · Ctrl+左键框选 · 中键拖拽平移 · 滚轮缩放 · 右键指令
空格播放/暂停 · Ctrl+1~8 编组、1~8 选组 · Esc 取消选择
装备/武器按钮：左键开停，右键换弹药（中文菜单）
右上角「战报」：先暂停推演，再按吨位列出各方「参战总数（已击毁）」

V0.8 要点
--------
· 增援按你选的**真实势力**入场（不再错显成「3号势力」），并**永远新开一个舰队**
  「增援舰队 N」；单次上限 256 艘；入场后会自动选中新部队（不再自动拉远镜头）
· **批量舰队操作不再卡死**：同一批命令只重算一次；属性按配装共享；
  预热的组合枚举只对"关闭装备"这类指令做（原先批量"开启装备"会组合爆炸）
· 重建失败不再破坏当前战场（不会出现"点暂停/播放后整个沙盘被重置"）；
  任何异常都会立即报错并复位，不会一直停在"重算中"
· 交火模式默认「自动攻击」，且**永远是四种模式之一**（右侧高亮当前模式）；
  走位与交火模式**解耦**：交火模式只决定打谁，舰船不会自己朝敌人移动
· 右键目标（舰船/星门/建筑）→「跃迁至…」→ 选落地距离（0/10/20/30/50/70/100 km）：
  先起跳（对齐）再按跃迁速度旅行，落地 = 目标偏移所选距离；距离需 > 150 km，
  且未被跃迁干扰（拦截力场禁止；扰频-2/扰断-1 扣跃迁稳定系数，≥1 才允许）。
  星门增援过门后同样是**跃迁过去**，不再是平速慢跑
· V0.7：装备初始「在线但不运转」（后勤例外自动运转）、舰船「被动待命」、
  跳刀（运转→瞬移 100km→冷却）、缩放拉远不再做图标避让

完全离线
--------
本软件不联网，也没有自动更新检查。
「更新 PYFA」= 在「设置 → 统计核心与目录」中指向你本机的新目录。

合规
----
详见 compliance/NOTICE.md（含 PYFA 的 GPLv3 许可文本与源码获取途径）。
`;

async function main(): Promise<void> {
  // 1) UI 构建
  run(process.execPath, [join(ROOT, "tools", "build-ui.ts")]);

  // 2) 宿主发布（自包含，双击即用）
  // 注意：不做整目录删除（部分环境有批量删除防护，且 dotnet publish 会覆盖）
  if (!skipPublish) {
    run("dotnet", [
      "publish", join("host", "EveSandbox.Host.csproj"),
      "-c", "Release",
      "-r", "win-x64",
      "--self-contained", "true",
      "-p:PublishSingleFile=true",
      "-p:IncludeNativeLibrariesForSelfExtract=true",
      "-p:DebugType=none",
      "-v", "quiet",
      "--nologo",
      "-o", BUILD,
    ]);
  }

  const exeSrc = join(BUILD, "EveSandbox.exe");
  if (!existsSync(exeSrc)) throw new Error("发布失败：找不到 " + exeSrc);

  // 3) 组装发行包（合并覆盖，不删目录）
  await mkdir(DIST, { recursive: true });
  // ★ 宿主 exe 没变（同名同大小）就**跳过复制**：一是省 100 MB 的重复写入，
  //   二是某些环境对"覆盖/删除同名大文件"会走回收站并失败，导致打包中断。
  const exeDest = join(DIST, `${APP_NAME}.exe`);
  let exeSame = false;
  try {
    exeSame = existsSync(exeDest)
      && (await stat(exeDest)).size === (await stat(exeSrc)).size;
  } catch {
    exeSame = false;
  }
  if (exeSame) {
    console.log(`[pack] 宿主 exe 未变化（同名同大小），跳过复制：${APP_NAME}.exe`);
  } else {
    await copyFile(exeSrc, exeDest);
  }

  // 说明书：存在就带上（用 Word 生成，随包分发）
  for (const cand of [
    join(ROOT, "docs", MANUAL),
    join(ROOT, MANUAL),
  ]) {
    if (existsSync(cand)) {
      // 用 copyFile（原地覆盖），不要走"先删后拷贝"的路径
      await copyFile(cand, join(DIST, MANUAL));
      console.log(`[pack] 已带上说明书：${MANUAL}`);
      break;
    }
  }

  // sidecar：只带运行时必需的两个脚本（不带开发期自检/探针）
  await mkdir(join(DIST, "sidecar"), { recursive: true });
  for (const f of ["pyfa_core.py", "pyfa_oracle.py"]) {
    await cp(join(ROOT, "sidecar", f), join(DIST, "sidecar", f));
  }

  await cp(join(ROOT, "compliance"), join(DIST, "compliance"), { recursive: true });
  await writeFile(join(DIST, "README.txt"), README, "utf8");

  // 4) 报告
  console.log("\n[pack] === 发行包 dist/ ===");
  const entries = await readdir(DIST, { withFileTypes: true });
  let total = 0;
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(DIST, e.name);
    const size = e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
    total += size;
    console.log(`  ${e.isDirectory() ? "[dir] " : "      "}${e.name.padEnd(24)} ${human(size)}`);
  }
  console.log(`  ${"".padEnd(6)}${"总计".padEnd(22)} ${human(total)}`);
  if (total > 1024 * 1024 * 1024) console.error("[pack] ✗ 超过 1GB 上限");
  else console.log("[pack] ✓ 体积在 1GB 以内（验收标准 §10.5）");

  const rel = relative(ROOT, DIST);
  console.log(`[pack] 完成：${rel}\\${APP_NAME}.exe`);
}

main().catch((err) => {
  console.error("[pack]", err);
  process.exit(1);
});

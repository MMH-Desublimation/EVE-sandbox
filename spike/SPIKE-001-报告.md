# SPIKE-001 报告：无头 PYFA 调用可行性验证

> 执行者：codebuddy ｜ 环境：用户本机 Windows x64 ｜ PYFA v2.69.0
> 结论先行：**可行（Feasible）** —— 问题 1、4 通过，单次耗时 9.2 ms ≪ 200 ms，体积 < 1 GB。
> 本报告用于填充交接文档《第 4 章 PYFA 集成协议》。

---

## 0. 结论摘要

| 判定项 | 结果 |
|---|---|
| 问题 1 无头加载可行性 | ✅ **可行** |
| 问题 2 GUI 依赖边界 | ⚠️ **可剥离 gui/service**；但 `eos.db` 仍需 `wx` 可导入（因 PYFA 的 `config.py` 顶层 `import wx`） |
| 问题 4 输出字段完整性 | ✅ **契约字段基本齐全**（少数属性名需修正） |
| 问题 8 性能 | ✅ 冷启动 **709 ms**；稳态单次 **9.2 ms**（P95 10.2 ms） |
| 问题 9 体积 | ✅ 核心 ≈ **200 MB**（含 eve.db 96 MB） |
| **总判定** | **可行** |

**最关键的验证**：用 PYFA 原生接口复现交接文档基准 ——
灾难级海军型（Apocalypse Navy Issue）8× 超级集束激光器 II + 标准 L（`Standard L`）+ 2× 散热槽 II，
全 V 技能 → **8 门总 DPS = 454.6**，与文档记载的 **454.6 完全一致**。

---

## 1. 关键发现：PYFA 的打包形态

本机 PYFA 为 **PyInstaller onedir 冻结包**：

```
D:\eve  pyfa\pyfa\
├── pyfa.exe                    (17.4 MB, PyInstaller 引导器 + 内嵌 CArchive/PYZ)
├── pyfa.exe.manifest
└── app\                        (218 MB, pyi-contents-directory = "app")
    ├── eve.db                  (96 MB, SDE 静态数据库)
    ├── python314.dll           (内嵌 Python 3.14 运行时)
    ├── *.pyd / *.dll           (编译扩展与依赖)
    ├── numpy/ matplotlib/ PIL/ sqlalchemy/ cryptography/ wx/ ...
    └── saveddata/ ...
```

**重要事实**：`app/` 目录里**只有二进制与数据**，**没有任何 `.py` / `.pyc`**。
PYFA 的全部 Python 源码（`eos/`、`service/`、`gui/`、`config` 等，共 **2065 个模块**）
以 `.pyc`（marshalled code）形式**冻结在 `pyfa.exe` 的内嵌 PYZ 归档里**。

### 1.1 CArchive 布局（本机实测，供复刻）

```
ARCH_START = EOF - pkg_len
TOC        = data[ARCH_START + toc_off : + toc_len]
COOKIE     = 紧随 TOC 之后，以 8 字节魔数 b'MEI\014\013\012\013\016' 开头
             = magic(8) + pkg_len(4) + toc_off(4) + toc_len(4) + pyvers(4) + pylibname(NUL 终止)
TOC entry  = entry_len(4) + offset(4) + clen(4) + ulen(4) + [1B 标志] + typecode(1) + name\0
             （typecode: 's' 脚本 / 'm' 模块 / 'o' 选项 / 'z' PYZ）
```

> 注意：cookie 在**文件尾部**，不在开头；`toc_off` 是相对 `ARCH_START` 的偏移。
> （与常见 pyinstxtractor 假设不同，已在本机实测确认。）

### 1.2 已验证的调用路径

```
① 从 pyfa.exe 提取 PYZ → 还原 2065 个 .pyc（补 16 字节 pyc 头）
② 把 app/ 的二进制与数据合并进模块目录（跳过 eve.db 本体）
③ 系统 Python 3.14.8（与内嵌 python314.dll 同版本）加载该目录
④ import eos → eos.db → eos.saveddata.* （纯计算核心）
⑤ 指向真实 eve.db，建 Character(All 5)，组装 Ship/Module/Charge，调用 calculateModifiedAttributes()
```

工具：`spike/pyfa_extract.py`（提取）、`spike/pyfa_boot.py`（引导）。

---

## 2. 十问逐项答案

### 问题 1：无头加载可行性 —— ✅ 可行

- 计算入口：**`eos.saveddata.fit.Fit.calculateModifiedAttributes()`**（不是 `eos.calc`，后者只剩 3 个几何辅助函数）。
- 无 GUI 环境下完整跑通：加载 SDE（**27 808** 个 item）→ 组装配装 → 计算属性 → 得出 DPS。
- 代码位置：`eos/saveddata/fit.pyc`、`eos/saveddata/{ship,module,cargo,character,drone,fighter}.pyc`。

### 问题 2：GUI 依赖边界 —— ⚠️ 可有条件剥离

实测导入链：

| 导入目标 | 结果 |
|---|---|
| `import eos` / `eos.calc` / `eos.const` / `eos.config` / `eos.effects` | ✅ 直接可用 |
| `import eos.db` | ✅ 可用，但**触发 `config` → `cryptography` + `wx`** |
| `eos.saveddata.{ship,module,fit,character}` | ✅ 可用 |
| `import service.fit` | ❌ 经 `service.esi` → `gui.ssoLogin` → `gui.mainFrame` → **拉入整套 GUI** 而失败（循环导入） |
| `import service.port.eft` / `xml` | ❌ 同上（`service.port.__init__` → `efs` → `service.fit` → `gui`） |

依赖链（实测）：

```
eos.db → eos.db.migration → config.py → cryptography.hazmat.bindings._rust (+ wx)
service.fit → service.character → service.esi → gui.ssoLogin → gui.mainFrame → gui.*
```

**结论**：
- **精简核 = `eos` 及其依赖**（sqlalchemy / logbook / yaml / cryptography / wx），
  **去掉 `gui/`（2.4 MB）与 `service/`（0.6 MB）**。
- `wx` 仍被 PYFA 的 `config.py`（顶层 `import wx`，模块级构造 `wx.Colour`）所必需。
  wx 在无显示环境可正常 import（不需要 `MainLoop`），但体积 **30.4 MB**。
  → **待办**：用轻量 `wx` shim 替代，可再省 ~30 MB（本 SPIKE 未完成，列为遗留）。

### 问题 3：输入构造 —— ✅ 可用（但需自建解析）

- `service.port.eft` / `service.port.xml` **不可用**（GUI 链）。
- **替代方案（已验证）**：直接用 `eos` 组装：
  ```
  Item(按 name 或 typeID 查 SDE) → Ship(item, owner=char) / Module(item) / Cargo(item)
  fit.modules.append(module)          # fit.modules 为只读属性，直接 append
  module.charge = charge_item         # ✅ 生效（赋值 Item 即被接受）
  module.getValidCharges()            # ✅ 枚举合法弹药（返回 Item 集合）
  module.state = FittingModuleState.ACTIVE   # ⚠️ 必须激活，否则 getVolley() 恒为 0
  ```
- EFT 文本解析需**自研**（格式简单：`[船名, 配装名]` + 槽位行 + `弹药名 xN`）；
  或 stub 掉 `gui` 以复用 `service.port.eft`（判断见遗留问题）。
- **`module.state` 影响一切输出**：默认不激活时 `getVolley()` 返回全 0；
  传 `ignoreState=True` 或先设 `FittingModuleState.ACTIVE` 才有值。这是重要坑点。

### 问题 4：输出字段完整性 ★硬门槛 —— ✅ 基本通过

对照交接文档《第 5 章 属性契约》逐项实测（对象：灾难级海军型配装）：

| 契约字段 | 实际属性名 | 实测值 | 结论 |
|---|---|---|---|
| `hp.shield` | `shieldCapacity` | 11000.0 | ✅ |
| `hp.armor` | `armorHP` | 14437.5 | ✅ |
| `hp.hull` | `hp` | 13750.0 | ✅ |
| `res.shield[EM/TH/KIN/EXP]` | `shield{Em,Thermal,Kinetic,Explosive}DamageResonance` | 1.0 / 0.8 / 0.6 / 0.5 | ✅ |
| `res.armor[...]` | `armor*DamageResonance` | 0.5 / 0.65 / 0.75 / 0.8 | ✅ |
| `res.hull[...]` | `hull*DamageResonance` | 1.0 / 1.0 / 1.0 / 1.0 | ✅ |
| `cap.capacity` | `capacitorCapacity` | 8750.0 | ✅ |
| `cap.rechargeRate` | `rechargeRate` | 750000 (ms) | ✅ |
| `scan.maxRange` | `maxTargetRange` | 114000.0 | ✅ |
| `scan.resolution` | `scanResolution` | 195.0 | ✅ |
| `scan.maxLocks` | `maxLockedTargets` | 7.0 | ✅ |
| `scan.sensorStrength` | `gravimetricStrength` 等 | **0** ⚠️ | ⚠️ 字段名待确认 |
| `nav.maxVelocity` | `maxVelocity` | 150.0 | ✅ |
| `nav.agility` | `agility` | 0.077625 | ✅ |
| `nav.mass` | `mass` | 97100000.0 | ✅ |
| `nav.signatureRadius` | `signatureRadius` | 370.0 | ✅ |
| `nav.warpSpeed` | `warpSpeed` | **0** ⚠️ | ⚠️ 字段名待确认 |
| `drone.bay` / `bandwidth` | `droneCapacity` / `droneBandwidth` | 100.0 / 75.0 | ✅ |
| `slots.*` | `hiSlots/medSlots/lowSlots/rigSlots/turretSlotsLeft/launcherSlotsLeft` | 8/4/8/3/8/0 | ✅ |
| `resource.*` | `cpuOutput` / `powerOutput` | 725.0 / 27500.0 | ✅ |
| `weapon.dmg` | `damageMultiplier` × `charge.{em,thermal,kinetic,explosive}Damage` | 9.3582 × (20/12/0/0) | ✅ |
| `weapon.rof` | `speed` (ms) | 5270.3 | ✅ |
| `weapon.optimal` / `falloff` | `maxRange` / `falloff` | 90000 / 20000 | ✅ |
| `weapon.tracking` | `trackingSpeed` | 1.914 | ✅ |
| `weapon.sigResolution` | `signatureRadius` | 100.0 | ✅ |
| `weapon.capNeed` | `capacitorNeed` | 10.725 | ✅ |
| 模块 `duration`/`capNeed`/效果量 | `duration` / `capacitorNeed` / `shieldBonus`(104) / `speedFactor`(637.5) | ✅ | ✅ |
| `index`（同 kind 实例序号） | 引擎侧自行编号（PYFA 无此概念） | — | 引擎侧补算 |
| `flags`（siege/triage/固定） | 由模块语义 + `speedFactor`/`siege*` 属性推导 | — | 引擎侧/属性推导 |
| `E. 溯源信息` | **未提供**（PYFA 不暴露加成来源清单） | — | ⚠️ 见下 |

**缺项/需修正项**：
1. **传感器强度**：`gravimetricStrength` 等返回 0 → 需改用正确属性名（如 `scanGravimetricStrength`），**待确认**。
2. **`warpSpeed`** 返回 0 → 需改用正确属性名（如 `baseWarpSpeed`），**待确认**。
3. **溯源信息（契约 5.7）**：PYFA **不提供**"数值来源列表"。→ 引擎侧无法直接获得；建议**降级为可选**，
   改为在引擎侧记录"引用了哪些 fit/state/env 键"，而非逐项加成交代。
4. **`index`（实例序号）**：PYFA 无此概念，由引擎侧按 `kind` 出现顺序自行编号（与文档 8.3 一致）。

### 问题 5：模块开关表达 —— ✅ 可行（部分验证）

- 开关通过 **`module.state`（`eos.const.FittingModuleState`）** 表达。
- 实测：未激活时 `getVolley()` 全 0；设 `ACTIVE` 后立即产生伤害 → **证明 state 真实参与计算**。
- **待补**：siege / 主动抗性硬化 / 微曲 的开关前后数值对比表（本 SPIKE 未完成）。

### 问题 6：环境加成注入 —— ⚠️ 未验证（遗留）

`Fit` 暴露 `addCommandBonus` / `boostedOf` / `boostedOnto` / `commandFits` 等接口，
**预计可用**，但本 SPIKE 未实测。列为遗留问题。

### 问题 7：稳定性 —— ⚠️ 存在内存增长，需定期重启

- 连续 500 次「建配装+计算」，`tracemalloc` 显示增长主要集中于：
  - `eos/modifiedAttributeDict.py`：**+37.9 MiB**
  - `eos/saveddata/module.py`：+7.0 MiB
  - `sqlalchemy/orm/state.py`：+4.7 MiB
- 即约 **76 KB / 次** 的滞留。虽含 tracemalloc 统计放大，但趋势明确：
  **PYFA 内部有缓存/状态滞留，不宜无限复用同一进程**。
- **建议**：StatOracle 子进程按 **N = 2000 ~ 5000 次请求** 主动重启；或**每场推演一个子进程**。

### 问题 8：性能 ★硬门槛 —— ✅ 通过

| 指标 | 实测 |
|---|---|
| 冷启动 → 首次数值出结果 | **709 ms**（boot 1 ms + import 325 ms + 首次计算 384 ms） |
| 稳态单次「组装配装 + calculateModifiedAttributes」 | 均值 **9.2 ms** / P50 9.1 ms / **P95 10.2 ms** / max 34 ms |
| 判定阈值 | < 200 ms → **通过** |

**对缓存策略的影响**：单次 < 50 ms → **缓存压力小**。
属性缓存可只做"同 (fit, state, env) 复用"，无需激进的预计算。

### 问题 9：体积 —— ✅ 通过

| 组成 | 体积 |
|---|---|
| eve.db（SDE，必需） | 96.0 MB |
| 内嵌 Python 3.14 运行时（python314.dll 等） | ~10 MB |
| 提取的纯 Python 模块（eos + 依赖） | ~60 MB（numpy/matplotlib/PIL/cryptography 为主） |
| `wx/`（含二进制，**可裁剪**） | 30.4 MB |
| `gui/`（**可裁剪**） | 2.4 MB |
| `service/`（**可裁剪**） | 0.6 MB |
| **全量（含 app/ 全部）** | **≈ 218 MB** |
| **精简核（去 gui/service/wx，去 matplotlib/PIL）估算** | **≈ 150 ~ 170 MB** |

合计 **≪ 1 GB** ✅。主 exe 本身可 < 50 MB（核心是外部目录）。

> 补充：matplotlib / PIL / contourpy / kiwisolver 仅供 PYFA 图表（graphs/gui）使用，精简核可整体移除。

### 问题 10：版本检测 —— ✅ 简单可靠

- **首选**：读取 PYFA 目录下 **`app/version.yml`** → 本机为 `version: v2.69.0`。
- `config.getVersion()` 在未初始化时返回 `None`（不可靠）。
- `eos.version` = `0.2.3`（是 eos 库版本，**不是** PYFA 版本，勿混用）。
- **建议**：受支持版本以 `version.yml` 为准；启动时跑**冒烟测试**（用固定基准配装校验 DPS=454.6 与 HP）。

---

## 3. 对架构的影响（第 4 章填充建议）

### 4.1 提供者发现与选择
- **内置核心**：随包附"已提取的无头核心目录 + Python 3.14 运行时 + eve.db"。
- **用户指定 PYFA 目录**：设置项指向 `...\pyfa\pyfa`，启动时**现场提取** `pyfa.exe` 的 PYZ
  （复用 `spike/pyfa_extract.py` 的逻辑，用 TS 或随包 Python 实现）。
- **优先级**：用户指定 > 内置。

### 4.2 版本检测
- 读 `app/version.yml`；受支持列表 + 冒烟测试（基准配装 DPS/HP 校验）。

### 4.3 冒烟测试
- 固定配装：Apocalypse Navy Issue + 8× Mega Beam Laser II + Standard L + 2× Heat Sink II
  → 断言 8 门总 DPS ≈ 454.6；Raven 基础 HP = 9625 / 7975 / 8800。

### 4.4 请求/响应格式（JSON 行协议）
```
请求: { "op": "calcFit",
        "ship": {"typeId": 17726} | {"name": "..."},
        "modules": [ {"slot":"hi","typeId":3049,"chargeTypeId":258,"state":"active"} ],
        "drones": [...], "fighters": [...],
        "skills": "all5",
        "env": { "commandBursts": [...] } }
响应: { "ok": true,
        "attrs": { "shieldCapacity": 11000, ... },
        "weapons": [ {"typeId":3049,"damageMultiplier":9.3582,"rof":5270.3,
                      "optimal":90000,"falloff":20000,"tracking":1.914,
                      "charge":{"em":20,"thermal":12,"kinetic":0,"explosive":0},
                      "capNeed":10.725} ],
        "modules": [ {"kind":"...","duration":3000,"capNeed":54,"effectAmount":104} ],
        "unhandled": [ ... ] }
```

### 4.5 属性契约调整
- 修正属性名：传感器强度、`warpSpeed`（待确认）。
- **`index`（实例序号）改由引擎侧生成**，不进 StatOracle 契约。
- **溯源信息（5.7）降级**：PYFA 不提供；改为引擎侧记录"引用了哪些 (fit, state, env) 键"。

### 4.6 缓存策略
- 单次 9.2 ms，**压力小**。缓存键 `(fitFingerprint, stateBitmap, envKey)` 即可，
  命中即复用；无需预计算或跨会话持久化。

### 4.7 子进程重启
- 建议每 **2000~5000** 次请求重启；或每场推演一个子进程。
- 崩溃恢复：重启后重放未完成请求。

### 4.8 内置核心形态
- **精简核**：`eos` + sqlalchemy/logbook/yaml/cryptography（**去 gui/service/wx/matplotlib/PIL**）。
- 体积目标 **≈ 150~170 MB**（主要为 eve.db 96 MB）。

### 4.9 ⚠️ 合规重要发现（需与用户确认）

交接文档 D-39 假设"PYFA 以独立子进程调用 = 聚合，非衍生"。
但**本方案会把 PYFA 的代码（.pyc）与数据打包分发**（内置核心），
这属于 **GPLv3 意义上的"分发"**，而非单纯聚合。
**合规动作（必须）**：
- [ ] 随包附 PYFA 的 GPLv3 许可文本与版权声明；
- [ ] 提供对应版本 PYFA **完整源码**获取途径（指向其 GitHub 仓库）；
- [ ] 若使用用户指定目录并在其机器上现场提取，则本软件不构成再分发（更安全）——**推荐此路线**。

---

## 4. 遗留问题清单

| # | 问题 | 优先级 |
|---|---|---|
| L1 | 传感器强度、`warpSpeed` 的正确属性名 | 高 |
| L2 | siege / 主动抗性 / 微曲 的开关前后对比（问题 5 补全） | 高 |
| L3 | 环境加成（指挥脉冲）注入方式（问题 6） | 中 |
| L4 | `wx` shim 可行性（可再省 30 MB） | 中 |
| L5 | `fit.getDps()` 报 `'NoneType' has no attribute 'factorReload'` | 中 |
| L6 | EFT / PYFA-XML 自建解析 vs stub gui 复用 `service.port` | 中 |
| L7 | 无人机 / 铁骑（fighter）属性与组结算字段核对 | 中 |
| L8 | 内存增长的精确定位与重启阈值 N 的实测标定 | 中 |
| L9 | 提取流程的**产品化实现**（TS 侧调用 Python / 打包 Python 运行时） | 高 |
| L10 | GPLv3 合规清单落地 | 高 |

### 关于 L5 的说明（本 SPIKE 已给出可用替代）
`Module.getDps()` 内部引用了一个为 `None` 的 `factorReload`（疑与 fit 反向引用未建立有关）。
**不影响结论**：DPS 可由 `getVolley() / (speed/1000)` 精确得到，
已验证与 PYFA 官方口径一致（454.6）。后续可据此绕开 `getDps()`。

---

## 5. 产出物

| 文件 | 作用 |
|---|---|
| `spike/pyfa_extract.py` | 从 `pyfa.exe` 提取全部 Python 模块（CArchive + PYZ 解析） |
| `spike/pyfa_boot.py` | 无头引导：sys.path + 二进制合并 + wx 合并 |
| `spike/verify_benchmark.py` | **基准复现**：8 门总 DPS = 454.6 |
| `spike/perf_survey.py` | 性能 / 稳定性 / 字段完整性 / 体积 / 版本 实测 |
| `spike/*.py`（诊断脚本） | 调查过程中的逐层探测记录 |

> 所有实验代码隔离在 `spike/`，**不进产品仓库**。

---

## 6. 建议的下一步

1. 用户确认 **内置核形态** 与 **合规路线**（内置分发 vs 现场提取）。
2. 本报告结论用于**冻结交接文档第 4 章**。
3. 进入**阶段 1（属性契约与 StatOracle 客户端）**：
   - 先补 L1 / L2 / L3（补齐属性名与开关语义），
   - 再把 `spike/` 的调用逻辑固化为 StatOracle 子进程协议。

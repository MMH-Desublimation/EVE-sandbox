# 第 4 章　PYFA 集成协议（冻结稿 v1.0）

> 状态：**已冻结**。结论来自 SPIKE-001 的本机实测（PYFA v2.69.0 / Windows x64 / Python 3.14）。
> 本章替换交接文档《第 4 章》的占位内容；与其实测冲突之处**以本章为准**。

---

## 4.0 总判定

**可行。** 无头调用 PYFA 计算核心成立，且数值与官方口径一致
（基准：Apocalypse Navy Issue + 8× Mega Beam Laser II + Standard L + 2× Heat Sink II → **454.6 DPS**）。

**本集成方式的最大收益**：交接文档中列为"上一版反复出错、必须引擎侧自行实现"的机制
（伤害/射速模块、炮台专精、HP 技能、改装件百分比、主动抗性开关、叠加惩罚、siege 语义……），
**PYFA 已原生、正确地实现**。引擎侧只需负责"时间与几何"，不再负责"效果叠加"。

---

## 4.1 提供者发现与选择

| 项 | 规则 |
|---|---|
| 内置核心 | 随包提供"已提取的无头核心目录 + Python 3.14 运行时 + eve.db" |
| 用户指定 | 设置项 `pyfaDir` 指向 `.../pyfa/pyfa`（含 `pyfa.exe` 与 `app/eve.db`） |
| 优先级 | **用户指定 > 内置**（符合交接文档 D-02） |
| 校验 | 选定后必须通过 §4.2 版本检测与 §4.3 冒烟测试；失败则回退到另一提供者 |

**关键实现注记**：本机 PYFA 为 **PyInstaller onedir 冻结包**，全部 Python 源码
（`eos/` 等 2065 个模块）以 `.pyc` 形式**内嵌于 `pyfa.exe` 的 PYZ 归档**，
`app/` 内只有二进制与数据，**磁盘上无任何 `.py/.pyc`**。

因此"提供者准备"= **从目标 `pyfa.exe` 提取无头核心**：

```
ARCH_START = EOF - pkg_len
TOC        = data[ARCH_START + toc_off : ARCH_START + toc_off + toc_len]
COOKIE     = 紧随 TOC（8 字节魔数 b'MEI\\014\\013\\012\\013\\016' 开头）
             = magic(8) + pkg_len(4) + toc_off(4) + toc_len(4) + pyvers(4) + pylibname(NUL 终止)
TOC entry  = entry_len(4) + offset(4) + clen(4) + ulen(4) + [1B 标志] + typecode(1) + name\\0
             typecode: 's' 脚本 / 'm' 模块 / 'o' 选项 / 'z' PYZ
PYZ 条目   = zlib( marshal(code) )，offset/length 取自 PYZ 自身 TOC（marshal 列表）
```

参考实现：`spike/pyfa_extract.py`（提取）、`spike/pyfa_boot.py`（引导）。

> 推荐流程：**优先在用户机器上现场提取**（不随包再分发 PYFA 代码，规避 GPLv3 再分发义务）；
> 内置核作为离线/无 PYFA 环境的后备。见 §4.10 合规。

---

## 4.2 版本检测

| 项 | 结论 |
|---|---|
| 首选方式 | 读取 `<pyfaDir>/app/version.yml` → `version: v2.69.0` |
| 不可用方式 | `config.getVersion()` 未初始化时返回 `None`；`eos.version`(=0.2.3) 是 **eos 库版本**，非 PYFA 版本 |
| 受支持列表 | 以 `version.yml` 的 `version` 字符串匹配；不匹配时**提示但允许继续**（并跑冒烟测试） |
| 记录 | 存档元数据写入 PYFA 版本号（符合 D-18） |

---

## 4.3 冒烟测试

启动（或切换提供者）后必须执行，全部通过才算"核心可用"：

| # | 用例 | 断言 |
|---|---|---|
| S1 | `Apocalypse Navy Issue` 无装备 | `shieldCapacity=11000`, `armorHP=14437.5`, `hp=13750` |
| S2 | S1 + 8× `Mega Beam Laser II` + `Standard L` + 2× `Heat Sink II`，state=ACTIVE | 8 门总 DPS ≈ **454.6**（容差 ±0.5） |
| S3 | `Raven` 无装备 | `shieldCapacity=9625`, `armorHP=7975`, `hp=8800` |
| S4 | S1 + `Multispectrum Shield Hardener II`，state 由 ONLINE 切 ACTIVE | shield EM res `1.0 → 0.675` |

失败处理：提示"内置核心校验失败/版本不匹配"，禁用计算功能并给出诊断信息。

---

## 4.4 请求 / 响应格式（JSON 行协议）

进程模型：主程序 ⇄ StatOracle 子进程，**stdin/stdout，每行一个 JSON**（符合 D-04）。

### 4.4.1 请求

```jsonc
{
  "id": 1024,                      // 请求序号，用于匹配响应
  "op": "calcFit",                 // calcFit | ping | version | resolveNames
  "ship": { "typeId": 17726 },     // 或 { "name": "Apocalypse Navy Issue" }
  "skills": "all5",                // 本期固定全 V
  "character": null,               // 预留：指定技能等级表
  "modules": [
    { "slot": "hi", "typeId": 3049, "state": "active", "chargeTypeId": 258 },
    { "slot": "lo", "typeId": 2364, "state": "active" }
  ],
  "drones":   [ { "typeId": 2456, "count": 5 } ],
  "fighters": [ { "typeId": 40356, "count": 1 } ],
  "env": { "commandBursts": [] }   // 预留：指挥脉冲等环境加成
}
```

- `state` ∈ `online | active | offline | overload`（映射 `eos.const.FittingModuleState`）。
- **`active` 是必须显式指定的**：未激活的模块 `getVolley()` 恒为 0（见 §4.7 坑点）。
- 弹药：`chargeTypeId` → `module.charge = Item`；可用 `resolveNames`/`getValidCharges` 校验合法性。

### 4.4.2 响应

```jsonc
{
  "id": 1024,
  "ok": true,
  "pyfaVersion": "v2.69.0",
  "attrs": {                       // 见 §4.5 属性契约
    "hp": { "shield": 11000, "armor": 14437.5, "hull": 13750 },
    "res": { "shield": [1.0, 0.8, 0.6, 0.5], "armor": [0.5, 0.65, 0.75, 0.8], "hull": [1,1,1,1] },
    "cap": { "capacity": 8750, "rechargeRate": 750000 },
    "scan": { "maxRange": 114000, "resolution": 195, "maxLocks": 7,
              "sensor": [0, 0, 0, 30] },     // GRAV / LADAR / MAGNETO / RADAR
    "nav": { "maxVelocity": 150, "agility": 0.077625, "mass": 97100000,
             "signatureRadius": 370, "warpSpeedMultiplier": 3.0, "baseWarpSpeed": 1.0 },
    "drone": { "bay": 100, "bandwidth": 75 },
    "slots": { "hi": 8, "med": 4, "lo": 8, "rig": 3, "turretMax": 8, "launcherMax": 0 },
    "resource": { "cpu": 725, "power": 27500 }
  },
  "weapons": [
    { "typeId": 3049, "kind": "turret", "state": "active",
      "damageMultiplier": 9.3582, "rof": 5270.34,
      "optimal": 90000, "falloff": 20000, "tracking": 1.914, "sigResolution": 100,
      "chargeTypeId": 258, "dmgTypes": { "em": 20, "thermal": 12, "kinetic": 0, "explosive": 0 },
      "volley": 299.46, "capNeed": 10.725, "count": 1 }
  ],
  "actives": [
    { "typeId": 2281, "kind": "shieldHardener", "state": "active",
      "duration": 0, "capNeed": 20, "effectAmount": 32.5, "optimal": 0, "falloff": 0,
      "resonanceDelta": { "em": 0.675, "thermal": 0.54, "kinetic": 0.405, "explosive": 0.3375 } }
  ],
  "drones": [
    { "typeId": 2456, "count": 5, "damageMultiplier": 3.96,
      "dmgTypes": { "em": 0, "thermal": 20, "kinetic": 0, "explosive": 0 },
      "rof": 4000, "optimal": 2625, "falloff": 2000, "tracking": 2.178,
      "optimalSigRadius": 25, "hpPoolEach": { "shield": 75, "armor": 135, "hull": 300 },
      "signatureRadius": 25, "maxVelocity": 4200 }
  ],
  "fighters": [],
  "unhandled": []                  // 未能识别的效果清单（开发期警告）
}
```

### 4.4.3 错误

```jsonc
{ "id": 1024, "ok": false, "error": { "code": "UNKNOWN_ITEM", "message": "...", "detail": {...} } }
```

| code | 处理 |
|---|---|
| `UNKNOWN_ITEM` | 返回该条目缺失，其余字段照常返回（部分成功） |
| `CALC_FAILED` | 该配装计算失败，标记单位属性不可用；不中断整场推演 |
| `TIMEOUT` | 主程序超时 → 重启子进程 → 重放该请求（至多 1 次） |
| `VERSION_MISMATCH` | 提示；允许继续 |

---

## 4.5 输出字段完整性（对照原第 5 章）

**逐项实测结论：契约字段基本齐全。** 下表给出"契约字段 → 实际属性名"的映射（**已修正**）。

### A. 单位静态属性

| 契约字段 | 实际属性名 | 实测（Apoc Navy） |
|---|---|---|
| `hp.shield` / `hp.armor` / `hp.hull` | `shieldCapacity` / `armorHP` / `hp` | 11000 / 14437.5 / 13750 |
| `res.shield[4]` | `shield{Em,Thermal,Kinetic,Explosive}DamageResonance` | 1.0/0.8/0.6/0.5 |
| `res.armor[4]` | `armor{...}DamageResonance` | 0.5/0.65/0.75/0.8 |
| `res.hull[4]` | `hull{...}DamageResonance` | 1.0×4 |
| `cap.capacity` / `cap.rechargeRate` | `capacitorCapacity` / `rechargeRate` | 8750 / 750000 |
| `scan.maxRange` / `scan.resolution` / `scan.maxLocks` | `maxTargetRange` / `scanResolution` / `maxLockedTargets` | 114000 / 195 / 7 |
| `scan.sensorStrength` | ⚠️ **`scanGravimetricStrength` / `scanLadarStrength` / `scanMagnetometricStrength` / `scanRadarStrength`**（**不是** `gravimetricStrength`） | 0/0/0/**30** |
| `nav.maxVelocity` / `agility` / `mass` / `signatureRadius` | `maxVelocity` / `agility` / `mass` / `signatureRadius` | 150 / 0.077625 / 97100000 / 370 |
| `nav.warpSpeed` | ⚠️ **`warpSpeedMultiplier`**（`warpSpeed` 恒为 0） | 3.0（另有 `baseWarpSpeed`=1.0） |
| `nav.alignTime` | **引擎侧派生**：`-ln(0.25)·mass·agility/1e6`（秒） | ≈10.45 s |
| `drone.bay` / `bandwidth` | `droneCapacity` / `droneBandwidth` | 100 / 75 |
| `fighter.tubes/light/heavy/support` | `fighterTubes*` 系列 | 待按舰型核对 |
| `slots.hi/med/lo/rig` | `hiSlots` / `medSlots` / `lowSlots` / `rigSlots` | 8/4/8/3 |
| `slots.turret` / `launcher`（已用/上限） | 上限 = SDE 原始值 `turretSlotsLeft`/`launcherSlotsLeft`；已用 = 上限 − 修正后值 | 上限 8 / 0 |
| `resource.cpu` / `power` | `cpuOutput` / `powerOutput` | 725 / 27500 |
| `flags`（siege/triage/固定） | 由模块语义 + `speedFactor` 推导（引擎侧） | — |
| `isStructure` / `groupName` / `shipName` | SDE `groupID` / 名称 | — |

### B. 武器属性（按 typeId）

| 契约字段 | 实际属性名 | 实测（Mega Beam Laser II） |
|---|---|---|
| `dmg[4]` | `damageMultiplier` × 弹药 `{em,thermal,kinetic,explosive}Damage` | 9.3582 × (20/12/0/0) |
| `rof` | `speed`（ms） | 5270.34 |
| `optimal` / `falloff` | `maxRange` / `falloff` | 90000 / 20000 |
| `tracking` | `trackingSpeed` | 1.914 |
| `sigResolution` | `signatureRadius`（炮台自身） | 100 |
| `capNeed` | `capacitorNeed` | 10.725 |
| `chargeId` / `chargeName` | 弹药 Item 的 ID / name | 258 / Standard L |

### C. 主动模块属性（按实例）

| 契约字段 | 实际属性名 |
|---|---|
| `duration` | `duration`（ms） |
| `capNeed` | `capacitorNeed` |
| `effectAmount` | 按语义取：`shieldBonus` / `armorDamageAmount` / `powerTransferAmount` / `shieldTransferAmount` / `energyNeutralizerAmount` / `speedFactor` … |
| `optimal` / `falloff` | `maxRange` / `falloff` |
| `targetLayer` | `getRepAmountParameters()` / 引擎侧按 kind 判定 |

### D. 动态修饰器

| 契约字段 | 实际实现 |
|---|---|
| `stateBitmap` | 由 `module.state` 组合编码（引擎侧） |
| `overrides` | PYFA 已直接反映在 `attrs` 中（如 siege → `maxVelocity=0`、`mass×10`） |
| `envModifiers` | 见 §4.6（待补） |

### E. 溯源信息 ⚠️ **降级**

**PYFA 不提供**"某数值由哪些加成构成"的来源清单。
→ 契约 5.7 **降级为可选**：改为记录 `(fitFingerprint, stateBitmap, envKey)` 三元组
（即"这个数值是在什么输入下算出来的"），而非逐项加成交代。
UI 悬停展示"来源加成列表"的能力**本期不做**。

---

## 4.6 环境加成注入（待补，遗留）

- `Fit` 暴露 `addCommandBonus` / `boostedOf` / `boostedOnto` / `commandFits` / `commandLinks`，
  **预计可用**，SPIKE 未实测。
- 在此之前，`envKey` 恒为 `""`，契约中 `envModifiers` 为空数组。
- 状态：**未阻塞阶段 1**（指挥脉冲属阶段 2 战术机制）。

---

## 4.7 关键坑点（务必写进实现）

1. **`module.state` 决定一切**：不设 `ACTIVE` 时 `getVolley()` 恒为 `DmgTypes(0,0,0,0)`。
   → StatOracle 收到 `state:"active"` 必须真正调用 `module.state = FittingModuleState.ACTIVE`。
2. **`fit.modules` / `fit.cargo` 是只读属性**，只能 `append`，不能赋值。
3. **弹药挂载**：`module.charge = Item`（直接赋 Item 即可），不要用 `Cargo`（会缺 `attributes`）。
4. **`Module.getDps()` 不可直接用**：内部引用未初始化的 `factorReload` 抛 `AttributeError`。
   → DPS 一律用 **`getVolley() / (speed/1000)`**（已与官方口径验证一致）。
5. **先 `calculateModifiedAttributes()` 再读值**；切换任何 `state`/弹药后必须**重算**。
6. **`eve.db` 路径**：必须在 `import eos.db` **之前**设置
   `eos.config.gamedata_connectionstring = "sqlite:///<abs path>/eve.db"`。
7. **saveddata 库**：需要 `os.makedirs(<dir>)` + `eos.db.saveddata_meta.create_all(eos.db.saveddata_engine)`，
   否则建会 `Ship()` 时即报 "unable to open database file"。

---

## 4.8 内置核心形态

**精简核 = 只用 `eos` 及其依赖**；**排除 `gui/` 与 `service/`**。

排除理由（实测）：
```
service.fit → service.character → service.esi → gui.ssoLogin → gui.mainFrame → 整套 GUI（导入即失败）
```

| 组成 | 体积 |
|---|---|
| `eve.db`（必需） | 96.0 MB |
| Python 3.14 运行时 | ≈10 MB |
| `eos` + sqlalchemy/logbook/yaml/cryptography 等 | ≈60 MB |
| `wx/`（**可裁剪**，见下） | 30.4 MB |
| `gui/` + `service/`（**必须排除**） | 3.0 MB |
| matplotlib / PIL / contourpy / kiwisolver（**可裁剪**，仅 PYFA 图表用） | 待测 |
| **合计（精简核）** | **≈ 150 ~ 170 MB** ✅ < 1 GB |

**`wx` 说明**：`eos.db` 会经 PYFA 的 `config.py`（顶层 `import wx` + 模块级 `wx.Colour`）拉入 wx。
wx 在**无显示环境可正常 import**（无需 `MainLoop`）。若用轻量 `wx` shim 替代，可再省 ~30 MB（遗留 L4）。

---

## 4.9 子进程重启策略

| 项 | 建议值 |
|---|---|
| 冷启动（进程起 → 首个结果） | 实测 **709 ms** |
| 稳态单次「组装配装 + 计算」 | 实测 均值 **9.2 ms** / P95 **10.2 ms** |
| 内存增长 | 500 次调用约 +38 MiB（`eos/modifiedAttributeDict` 为主）≈ **76 KB/次** |
| **重启阈值** | **每 2000 ~ 5000 次请求**主动重启；或**每场推演一个子进程** |
| 崩溃恢复 | 主程序捕获 → 重启 → 重放未完成请求（至多 1 次） |
| 生命周期 | 程序启动拉起；程序退出终止 |

**缓存**：单次 9.2 ms（< 50 ms）→ **缓存压力小**。
只需按 `(fitFingerprint, stateBitmap, envKey)` 做同进程内复用，无需预计算或跨会话持久化。

---

## 4.10 合规（GPLv3）

交接文档 D-39 假设"独立子进程调用 = 聚合，非衍生"。**本方案内置核心会分发 PYFA 的
`.pyc` 与数据，属 GPLv3 意义上的再分发**，须履行：

- [ ] 随包附 PYFA 的 **GPLv3 许可文本**与版权声明；
- [ ] 提供对应版本 PYFA **完整源码**的获取途径（指向其官方仓库）；
- [ ] 若对 PYFA 源码有任何修改，记录补丁并独立保留、按 GPL 释放（本方案**未修改**其源码，仅在运行时加载）；
- [ ] **推荐路线**：默认采用"用户机器上现场提取"，此时不构成再分发，合规风险最低；
     内置核作为可选后备并完整履行上述义务。

---

## 4.11 遗留问题（不阻塞阶段 1）

| # | 问题 | 影响面 |
|---|---|---|
| L3 | 指挥脉冲等环境加成注入方式 | 阶段 2 |
| L4 | `wx` shim 可行性（省 ~30 MB） | 打包阶段 |
| L6 | EFT / PYFA-XML 解析：自研 vs stub `gui` 复用 `service.port` | 阶段 1 配装导入 |
| L7 | 铁骑（fighter）属性与纵队字段核对 | 阶段 2 |
| L8 | 内存增长精确定位与重启阈值标定 | 阶段 3 压测 |
| L9 | 提取流程产品化（TS 侧驱动 / 打包 Python 运行时） | 阶段 1 / 4 |

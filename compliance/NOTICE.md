# 合规说明（NOTICE）

本文件是本发行包合规检查项（交接文档第 11 章）的说明与凭据。

---

## 1. 本软件与 PYFA 的关系

本软件（EVE 战局沙盒推演）在计算《EVE Online》舰船属性与武器数值时，
调用 [PYFA（Python Fitting Assistant）](https://github.com/pyfa-org/PyFA) 的计算核心。

**★ 本发行包不包含 PYFA 的任何源代码、字节码或数据文件。**

具体事实：

| 项 | 事实 |
|---|---|
| PYFA 代码来源 | 用户**自己安装**的 PYFA（首次启动时由用户在设置中指定安装目录） |
| 代码提取时机 | 程序运行时，在**用户自己的机器上**从 `pyfa.exe` 现场提取 |
| 提取产物位置 | 用户本机的缓存目录（`%APPDATA%\EveSandbox\core`），不随发行包分发 |
| 调用方式 | **独立子进程 + 标准输入输出上的 JSON 行协议**（不是链接、不是派生、不是静态/动态库嵌入） |

因此，本软件与 PYFA 之间是**两个独立程序在运行时互相调用**的关系，
属于聚合（aggregation），**不构成 GPLv3 意义上的再分发或衍生作品**。
本软件自身代码不包含也不链接任何 GPLv3 代码。

---

## 2. PYFA 的许可与版权

PYFA 以 **GNU General Public License v3.0（GPLv3）** 授权。

- 版权归 PYFA 项目及其贡献者所有（pyfa-org）。
- 许可证全文见同目录下的 [`PYFA-GPLv3.txt`](./PYFA-GPLv3.txt)（GNU 官方文本）。
- GPLv3 官方地址：https://www.gnu.org/licenses/gpl-3.0.html

本软件**不修改** PYFA 的源代码（交接文档 D-40：尽量不修改）。
若未来必须修改，将在此处记录补丁、独立保留，并按 GPL 释放。

---

## 3. PYFA 源码获取途径

- 项目主页：https://github.com/pyfa-org/PyFA
- 本软件使用并验证的版本：**v2.69.0**
- 对应源码标签：https://github.com/pyfa-org/PyFA/releases

本软件不会下载 PYFA，也不会自动更新 PYFA。
「更新 PYFA」= 在设置中把目录指向你本机的新版 PYFA 安装位置。

---

## 4. 免责声明（交接文档 §11.3 / D-41）

> 本软件使用 PYFA 作为数值计算引擎。PYFA 是对 EVE Online 的**高精度近似**，
> 与游戏服务器真值可能存在微小差异。本软件用于**战术推演与教学**，
> 不适用于对真实战报的逐项复现。

该免责声明同时已内置于软件界面中（首次启动必须明确同意；菜单「帮助 → 关于 / 免责声明 / 合规」可随时查看）。

---

## 5. 离线保证（交接文档 §11.2）

- [x] 完全无联网行为。软件自身不发起任何网络请求。
- [x] 无自动更新检查。
- [x] 界面资源通过 WebView2 的**虚拟主机名映射**从本地文件夹加载，不经过任何 HTTP 服务。
- [x] 所有非本地虚拟主机的导航与新窗口请求都会被宿主拒绝。
- [x] WebView2 以关闭后台联网特性的参数启动
      （`--disable-background-networking --disable-component-update --disable-sync --disable-features=SmartScreen`）。
- [x] 「用户更新 PYFA」= 指向本地目录，非联网下载。

> 说明：构建期（开发者机器上）会从 NuGet 还原 `Microsoft.Web.WebView2`、
> 从 gnu.org 取回 GPLv3 文本、从 nuget.org 取包。这些**不发生在用户机器上**，
> 用户拿到的发行包运行时完全离线。

---

## 6. 本软件自身的许可

本软件开源（交接文档 D-38：GitHub 免费公开），并**延续 PYFA 的许可：GNU GPL v3.0**。

- 许可证全文：仓库根目录的 [`LICENSE`](../LICENSE)（GPLv3 官方文本）。
- `package.json` 的 `license` 字段为 `GPL-3.0-only`。
- 版权声明：Copyright (C) 2026 EVE 战局沙盒推演项目贡献者。

本程序是自由软件：你可以根据自由软件基金会发布的 GNU 通用公共许可证
（第 3 版）的条款重新发布和/或修改它。本程序基于「有用」的目的发布，但**不提供任何担保**。

采用 GPLv3 的额外好处：与 PYFA 的许可完全一致，因此即使将来出于某种原因
需要把两者的代码放在一起分发，也不存在许可冲突。

---

## 7. 第三方组件清单

| 组件 | 用途 | 许可 | 是否随包分发 |
|---|---|---|---|
| PYFA | 数值计算引擎（独立子进程调用） | GPLv3 | **否**（用户本机安装，运行时现场提取） |
| Microsoft.Web.WebView2 | 界面承载（系统组件 WebView2 Runtime） | 专有（Microsoft 可再发行组件） | 加载器 DLL |
| .NET Runtime | 宿主运行时（自包含发布时随包） | MIT | 是 |

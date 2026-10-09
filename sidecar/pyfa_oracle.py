"""StatOracle 子进程：以 JSON 行协议对外提供 PYFA 计算能力。

协议（每行一个 JSON；详见 docs/第4章-PYFA集成协议-冻结稿.md §4.4）：
  请求  {"id":1,"op":"ping"}
        {"id":2,"op":"version"}
        {"id":3,"op":"resolveNames","names":["Raven","Standard L"]}
        {"id":4,"op":"calcFit","ship":{"name":"Apocalypse Navy Issue"},
         "modules":[{"slot":"hi","typeId":3049,"state":"active","chargeTypeId":258}],
         "drones":[{"typeId":2456,"count":5}]}
  响应  {"id":..,"ok":true, ...} / {"id":..,"ok":false,"error":{...}}

约束：stdout 只输出 JSON 行；所有日志走 stderr。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pyfa_core import boot_core, ensure_core  # noqa: E402

# --------------------------------------------------------------------------- #
# 语义 kind 判定（模块效果名 → 契约 §5.6 的 kind）
# 规则基于 PYFA 的实际效果命名（见 sidecar/_probe_effects.py 的实测输出）。
# 顺序敏感：更具体的规则必须排在前面（如 ecmBurst 先于 ecm、remote* 先于 armorRepair）。
# --------------------------------------------------------------------------- #
_KIND_RULES = [
    # —— 自身增益 / 抗性硬化 ——
    ("modifyactiveshieldresonance", "shieldHardener"),
    ("modifyactivearmorresonance", "armorHardener"),
    # ★ 微型跳跃引擎（跳刀）：PYFA/SDE 效果名就是 `microJumpDrive`（实测
    #   Large/Medium/Capital Micro Jump Drive 三个变体都是它）。
    #   必须排在 microwarpdrive 之前更保险（两者互不为子串，但语义上更该命中这里）。
    #   注意：微型跳跃**力场发生器**的效果名是 microJumpPortalDrive，
    #   不含 "microjumpdrive" 这段连续串，因此不会被这里误命中（属另一个功能）。
    ("microjumpdrive", "microJump"),
    ("modulebonusmicrowarpdrive", "prop"), ("modulebonusafterburner", "prop"),
    ("microwarpdrive", "prop"), ("afterburner", "prop"),
    ("modulebonustrackingcomputer", "trackingComputer"), ("trackingcomputer", "trackingComputer"),
    ("modulebonusmissileguidancecomputer", "missileGuidanceComputer"),
    ("missileguidancecomputer", "missileGuidanceComputer"),
    ("modulebonussensorbooster", "sensorBooster"), ("sensorbooster", "sensorBooster"),
    # —— 会战 / 指挥 ——
    ("modulebonussiegemodule", "siege"), ("siegemodule", "siege"),
    ("modulebonustriagemodule", "triage"), ("triagemodule", "triage"),
    ("modulebonuscommandburst", "commandBurst"), ("commandburst", "commandBurst"),
    # —— 后勤 / 传电（PYFA 实际效果名：shipModuleRemote*）——
    ("remotecapacitortransmitter", "capTransfer"), ("powertransfer", "capTransfer"),
    ("remotearmorrepair", "remoteArmor"),
    ("remoteshieldboost", "remoteShield"), ("remoteshieldbooster", "remoteShield"),
    ("remotehullrepair", "remoteHull"),
    # —— 本维修 / 注电器 ——
    ("shieldboosting", "shieldBooster"), ("shieldbooster", "shieldBooster"),
    ("armorrepair", "armorRepairer"),
    ("hullrepair", "hullRepairer"),
    ("capacitorbooster", "capBooster"),
    # —— 电子战（注意更具体的规则须在前）——
    ("warpbubble", "bubble"), ("warpdisruptionfield", "bubble"),
    ("interdiction", "interdictionLauncher"),
    ("ecmburst", "ecmBurst"),
    ("ecm", "ecm"), ("targetjam", "ecm"),
    ("trackingdisrupt", "trackDisrupt"),
    ("guidancedisrupt", "guidanceDisrupt"),
    ("sensordampener", "damp"), ("remotesensordampener", "damp"),
    ("targetpaint", "painter"), ("remotetargetpaint", "painter"),
    ("webifier", "web"),
    ("energyneutralizer", "neut"),
    ("nosferatu", "nos"),
    ("warpscramble", "warpScramble"), ("warpscrambler", "warpScramble"),
    ("warpdisruptor", "warpDisrupt"), ("warpdisrupt", "warpDisrupt"),
    # ★ 立体炸弹的 PYFA 效果名是 empWave（不是 "smartbomb"）。
    #   装备名兜底本来也能命中（"Large EMP Smartbomb II"），这里按效果名再兜一层。
    ("empwave", "smartbomb"),     ("smartbomb", "smartbomb"),
    ("grappler", "grappler"),
]

# 装备名兜底规则（EVE 命名稳定，效果名意外时仍能定向）
_NAME_RULES = [
    # ★ 微型跳跃引擎（跳刀）的名称兜底（中英文都覆盖；
    #   注意不要命中"微型跳跃**力场发生器**"——它属于另一个功能）
    ("micro jump drive", "microJump"),
    ("微型跳跃引擎", "microJump"),
    ("remote capacitor transmitter", "capTransfer"),
    ("remote armor repairer", "remoteArmor"),
    ("remote shield booster", "remoteShield"),
    ("remote hull repairer", "remoteHull"),
    ("capital remote armor repairer", "remoteArmor"),
    ("capital remote shield booster", "remoteShield"),
    ("stasis webifier", "web"),
    ("target painter", "painter"),
    ("tracking disruptor", "trackDisrupt"),
    ("guidance disruptor", "guidanceDisrupt"),
    ("sensor dampener", "damp"),
    ("remote sensor dampener", "damp"),
    ("energy neutralizer", "neut"),
    ("energy nosferatu", "nos"),
    ("warp scrambler", "warpScramble"),
    ("warp disruptor", "warpDisrupt"),
    ("warp disruption field", "bubble"),
    ("interdiction sphere", "bubble"),
    ("mobile warp disruptor", "bubble"),
    ("smartbomb", "smartbomb"),
    ("grappler", "grappler"),
    ("siege module", "siege"),
    ("triage module", "triage"),
    ("command burst", "commandBurst"),
    ("tracking computer", "trackingComputer"),
    ("missile guidance computer", "missileGuidanceComputer"),
    ("sensor booster", "sensorBooster"),
    ("shield hardener", "shieldHardener"),
    ("armor hardener", "armorHardener"),
    ("shield booster", "shieldBooster"),
    ("armor repairer", "armorRepairer"),
    ("hull repairer", "hullRepairer"),
    ("capacitor booster", "capBooster"),
    ("microwarpdrive", "prop"),
    ("afterburner", "prop"),
]


def _effect_names(item) -> list:
    """取 item 的效果名列表。注意 item.effects 是 SQLAlchemy mapped collection（字典式）。"""
    try:
        effs = item.effects
    except Exception:
        return []
    if effs is None:
        return []
    vals = []
    if hasattr(effs, "values"):
        try:
            vals = list(effs.values())
        except Exception:
            vals = []
    if not vals:
        try:
            for k in effs:
                try:
                    vals.append(effs[k])
                except Exception:
                    vals.append(k)
        except Exception:
            vals = []
    out = []
    for e in vals:
        nm = getattr(e, "name", None)
        if isinstance(nm, str):
            out.append(nm)
    return out


def _warp_core_stability(scramble_status) -> float:
    """把 PYFA 的 `warpScrambleStatus` 换算成"跃迁稳定系数"。

    PYFA/SDE 用**负值**表示"舰船跃迁核心强度"（夜神级 = -25）。
    基础值 1 → 有效系数 = 1 + 强度；普通舰船为 0 → 系数 1。
    """
    try:
        v = float(scramble_status)
    except (TypeError, ValueError):
        v = 0.0
    return 1.0 + max(0.0, -v)


# 这些 kind 在 PYFA 的 `canDealDamage` 上也可能为真，但它们**不是武器** ——
# 不需要锁定，也不吃追踪/爆炸应用率，必须走"主动模块"通路。
_NON_WEAPON_KINDS = {"smartbomb", "commandBurst", "bubble", "interdictionLauncher"}


def _kind_of(item) -> str:
    """两阶段判定：先按效果名，再按装备名兜底。"""
    blob = " ".join(_effect_names(item)).lower()
    if blob:
        for needle, kind in _KIND_RULES:
            if needle in blob:
                return kind
    name = (getattr(item, "name", "") or "").lower()
    for needle, kind in _NAME_RULES:
        if needle in name:
            return kind
    return "other"


# --------------------------------------------------------------------------- #
class Oracle:
    def __init__(self, core: dict):
        self.core = core
        self.version = core["version"]

        import eos.db as eos_db
        self.edb = eos_db
        eos_db.saveddata_meta.create_all(eos_db.saveddata_engine)

        from eos.gamedata import Item
        from eos.const import FittingModuleState
        from eos.saveddata.character import Character
        from eos.saveddata.cargo import Cargo
        from eos.saveddata.drone import Drone
        from eos.saveddata.fit import Fit
        from eos.saveddata.module import Module
        from eos.saveddata.ship import Ship
        # ★ 建筑（Upwell 结构）不能用 Ship：实测 `Ship(Fortizar)` 会抛
        #   ValueError: ... is not under Ship category。
        #   必须走 eos.saveddata.citadel.Citadel（它是 Ship 的子类，用法一致）。
        from eos.saveddata.citadel import Citadel
        # ★ 脑插必须挂在 **Fit** 上（fit.implants），不是 Character 上 ——
        #   实测挂 Character 完全不影响属性，挂 Fit 才能算出套装加成。
        from eos.saveddata.implant import Implant
        from eos.saveddata.fighter import Fighter
        from eos.saveddata.commandLink import (
            COMMAND_LINK_DEFS, CommandLink, applyCommandLinkToFit,
        )

        self.Item, self.Module, self.Ship, self.Fit = Item, Module, Ship, Fit
        self.Citadel = Citadel
        self.Implant, self.Fighter = Implant, Fighter
        self.CommandLink, self.applyCommandLinkToFit = CommandLink, applyCommandLinkToFit
        # 合法 link 类型表（用于把拼错的 linkType 拦下来，而不是静默无效）
        self.COMMAND_LINK_DEFS = COMMAND_LINK_DEFS
        self.Drone, self.Cargo = Drone, Cargo
        self.STATES = {s.name.lower(): s for s in FittingModuleState}
        self.character = Character("All 5", defaultLevel=5)
        self._items = {}

    # ---------------- 查找 ----------------
    def item_by_id(self, type_id: int):
        if type_id in self._items:
            return self._items[type_id]
        it = self.edb.gamedata_session.query(self.Item).filter(self.Item.ID == type_id).first()
        self._items[type_id] = it
        return it

    def item_by_name(self, name: str):
        key = ("n", name)
        if key in self._items:
            return self._items[key]
        it = self.edb.gamedata_session.query(self.Item).filter(self.Item.name == name).first()
        self._items[key] = it
        return it

    # ---------------- 脑插 ----------------
    def implant_row(self, imp) -> dict:
        it = getattr(imp, "item", None)
        name = getattr(it, "name", None)
        # 套装名：从"High-grade Nirvana Alpha"里取"High-grade Nirvana"
        s = name or ""
        set_name = None
        for suffix in (" Alpha", " Beta", " Gamma", " Delta", " Epsilon", " Omega"):
            if s.endswith(suffix):
                set_name = s[: -len(suffix)]
                break
        return {
            "slot": getattr(imp, "slot", None),
            "typeId": getattr(it, "ID", None),
            "name": name,
            "set": set_name,
        }

    # ---------------- 铁骑（战斗机）----------------
    def fighter_row(self, fr, input_index=None) -> dict:
        """一个纵队（= 一个发射管，D-27）。

        伤害用 PYFA 的 `getVolleyParametersPerEffect()` —— 它返回的是**整个纵队**的
        齐射（已含纵队规模与技能；实测 Templar I 攻击 1096.875 = 97.5×6×1.875）。
        HP 用 `fr.hp`，那是**单架**的值，纵队血池需再乘 squadronSize。
        """
        a = self.attr
        it = fr.item

        vols = {}
        try:
            for eid, per in (fr.getVolleyParametersPerEffect() or {}).items():
                for _, v in (per or {}).items():
                    vols[eid] = {
                        "em": float(v.em), "thermal": float(v.thermal),
                        "kinetic": float(v.kinetic), "explosive": float(v.explosive),
                    }
        except Exception:
            pass

        cycles = {}
        try:
            for eid, info in (fr.getCycleParametersPerEffectInfinite() or {}).items():
                cycles[eid] = float(getattr(info, "activeTime", 0) or 0)
        except Exception:
            pass

        abilities = []
        for ab in (fr.abilities or []):
            eff = getattr(ab, "effect", None)
            eid = getattr(eff, "ID", None)
            nm = getattr(eff, "name", None) or ""
            vol = vols.get(eid)
            if vol is None:
                continue
            # 只保留**真正能造成伤害**的能力。
            # 微型跃迁（fighterAbilityMicroWarpDrive）也会出现在 getVolleyParametersPerEffect
            # 里，但齐射恒为 0 —— 若不剔除，引擎会把它当成一门射程很远、伤害为零的"武器"。
            if sum(float(vol.get(k, 0) or 0)
                   for k in ("em", "thermal", "kinetic", "explosive")) <= 0:
                continue
            is_attack = "Attack" in nm
            prefix = "fighterAbilityAttackMissile" if is_attack else "fighterAbilityMissiles"
            cycle = cycles.get(eid)
            if not cycle:
                # 远程导弹能力的周期不在 CycleParameters 里，直接读属性
                cycle = a(fr, prefix + "Duration")
            if not cycle:
                continue
            if is_attack:
                optimal = a(fr, "fighterAbilityAttackMissileRangeOptimal")
                falloff = a(fr, "fighterAbilityAttackMissileRangeFalloff")
                expl_r = a(fr, "fighterAbilityAttackMissileExplosionRadius")
                expl_v = a(fr, "fighterAbilityAttackMissileExplosionVelocity")
                drf = a(fr, "fighterAbilityAttackMissileReductionFactor")
                drs = a(fr, "fighterAbilityAttackMissileReductionSensitivity")
            else:
                optimal = a(fr, "fighterAbilityMissilesRange")
                falloff = 0.0
                expl_r = a(fr, "fighterAbilityMissilesExplosionRadius")
                expl_v = a(fr, "fighterAbilityMissilesExplosionVelocity")
                drf = a(fr, "fighterAbilityMissilesDamageReductionFactor")
                drs = a(fr, "fighterAbilityMissilesDamageReductionSensitivity")
            abilities.append({
                "effect": nm,
                "volley": vol,
                "cycleMs": cycle,
                "optimal": optimal,
                "falloff": falloff,
                "explosionRadius": expl_r,
                "explosionVelocity": expl_v,
                "drf": drf,
                "drs": drs,
            })

        hp = getattr(fr, "hp", None) or {}
        return {
            "typeId": getattr(it, "ID", None),
            "name": getattr(it, "name", None),
            "squadronSize": int(a(fr, "fighterSquadronMaxSize") or 1),
            "isLight": bool((a(fr, "fighterSquadronIsLight") or 0) >= 0.5),
            "hpEach": {
                "shield": float(hp.get("shield", 0) or 0),
                "armor": float(hp.get("armor", 0) or 0),
                "hull": float(hp.get("hull", 0) or 0),
            },
            "maxVelocity": a(fr, "maxVelocity"),
            "signatureRadius": a(fr, "signatureRadius"),
            "orbitRange": a(fr, "fighterSquadronOrbitRange"),
            "abilities": abilities,
            "inputIndex": input_index,
        }

    def _vessel(self, item):
        """按 SDE category 选择正确的载体类：舰船用 `Ship`，建筑用 `Citadel`。

        建筑的属性同样走 PYFA 的完整叠加链（实测铁壁 shieldCapacity=6750000、
        结构 hp=21600000、maxVelocity=0），因此"建筑可装配、可开火、可被摧毁"
        （§9.1）不需要引擎自己造数值。
        """
        try:
            from eos.gamedata import Category, Group
            g = self.edb.gamedata_session.query(Group).filter(Group.ID == item.groupID).first()
            c = (self.edb.gamedata_session.query(Category)
                 .filter(Category.ID == g.categoryID).first()) if g is not None else None
            if c is not None and getattr(c, "name", None) == "Structure":
                return self.Citadel(item, owner=self.character)
        except Exception:
            pass
        return self.Ship(item, owner=self.character)

    def _resolve(self, ref: dict):
        if not isinstance(ref, dict):
            return None
        if ref.get("typeId") is not None:
            return self.item_by_id(int(ref["typeId"]))
        if ref.get("name"):
            return self.item_by_name(str(ref["name"]))
        return None

    # ---------------- 属性读取 ----------------
    @staticmethod
    def attr(obj, name):
        try:
            return obj.getModifiedItemAttr(name)
        except Exception:
            return None

    @staticmethod
    def _state_name(module) -> str:
        st = getattr(module, "state", None)
        name = getattr(st, "name", None)
        return name.lower() if name else str(st).lower()

    def _volley(self, module):
        """返回四类伤害之和（DmgTypes）；不可用时返回 None。"""
        try:
            v = module.getVolley()
            return v.em + v.thermal + v.kinetic + v.explosive
        except Exception:
            return None

    def _dps(self, module):
        """DPS = 齐射 / (循环时间/1000)。不用 module.getDps()（其内部引用未初始化的 factorReload）。"""
        rof = self.attr(module, "speed")
        volley = self._volley(module)
        if not rof or volley is None:
            return None
        return volley / (rof / 1000.0)

    @staticmethod
    def raw_attr(item, name):
        """读取 SDE 条目的**基础**属性值（返回 float；PYFA 的 Attribute 对象需取 .value）。"""
        try:
            at = (item.attributes or {}).get(name)
        except Exception:
            return None
        if at is None:
            return None
        for key in ("value", "baseValue", "modifiedValue"):
            v = getattr(at, key, None)
            if isinstance(v, (int, float)):
                return float(v)
        try:
            return float(at)
        except Exception:
            return None

    def ship_attrs(self, fit) -> dict:
        s = fit.ship
        a = self.attr
        turret_max = self.raw_attr(s.item, "turretSlotsLeft")
        launcher_max = self.raw_attr(s.item, "launcherSlotsLeft")
        return {
            "hp": {"shield": a(s, "shieldCapacity"), "armor": a(s, "armorHP"), "hull": a(s, "hp")},
            "res": {
                "shield": [a(s, f"shield{x}DamageResonance") for x in ("Em", "Thermal", "Kinetic", "Explosive")],
                "armor": [a(s, f"armor{x}DamageResonance") for x in ("Em", "Thermal", "Kinetic", "Explosive")],
                "hull": [a(s, f"hull{x}DamageResonance") for x in ("Em", "Thermal", "Kinetic", "Explosive")],
            },
            "cap": {"capacity": a(s, "capacitorCapacity"), "rechargeRate": a(s, "rechargeRate")},
            "shieldRechargeRate": a(s, "shieldRechargeRate"),
            "scan": {
                "maxRange": a(s, "maxTargetRange"), "resolution": a(s, "scanResolution"),
                "maxLocks": a(s, "maxLockedTargets"),
                "sensor": [a(s, f"scan{x}Strength") for x in
                           ("Gravimetric", "Ladar", "Magnetometric", "Radar")],
            },
            "nav": {
                "maxVelocity": a(s, "maxVelocity"), "agility": a(s, "agility"), "mass": a(s, "mass"),
                "signatureRadius": a(s, "signatureRadius"),
                "warpSpeedMultiplier": a(s, "warpSpeedMultiplier"),
                "baseWarpSpeed": a(s, "baseWarpSpeed"),
                # 跃迁稳定系数（含舰船技能加成）
                #
                # ★ 实测（sidecar/_probe_wcs.py）：PYFA 把"舰船跃迁核心强度"存成
                #   **负的** `warpScrambleStatus` —— 夜神级超级航母特性是
                #   「5+ bonus to ship warp core strength」（效果 shipBonusSupercarrierG3WarpStrength
                #   = -5 × 技能等级5）→ 读出来就是 **-25**。基础值 1，故有效稳定系数
                #   = 1 + 25 = **26**，与用户给出的算式一致。
                #   普通舰船该属性为 0 → 系数 1（一个扰频/扰断即可拦住）。
                "warpCoreStability": _warp_core_stability(a(s, "warpScrambleStatus")),
            },
            "drone": {"bay": a(s, "droneCapacity"), "bandwidth": a(s, "droneBandwidth")},
            "slots": {
                "hi": a(s, "hiSlots"), "med": a(s, "medSlots"), "lo": a(s, "lowSlots"),
                "rig": a(s, "rigSlots"),
                "turretMax": turret_max, "launcherMax": launcher_max,
                "turretLeft": a(s, "turretSlotsLeft"), "launcherLeft": a(s, "launcherSlotsLeft"),
            },
            "resource": {"cpu": a(s, "cpuOutput"), "power": a(s, "powerOutput")},
            "alignTime": self._align_time(s),
            # 旗舰跳能力（普通舰船三项皆 None → 引擎判定为"不具备旗舰跳"）
            "jump": {
                "range": a(s, "jumpDriveRange"),
                "activationCost": a(s, "jumpDriveConsumption"),
                "durationMs": a(s, "jumpDriveDuration"),
            },
        }

    @staticmethod
    def _align_time(ship):
        """alignTime = -ln(0.25)·mass·agility/1e6（秒）"""
        try:
            import math
            return -math.log(0.25) * ship.getModifiedItemAttr("mass") * ship.getModifiedItemAttr("agility") / 1e6
        except Exception:
            return None

    def ship_info(self, fit) -> dict:
        """舰船身份：吨位归类与势力染色的**权威来源**。

        必须用 SDE 的 category/group/race，而不是对船名做正则猜测 ——
        这样"多米尼克斯级 / 多米尼克斯级海军型 / 罪恶级 / 克洛诺斯级"这类
        同吨位不同科技等级的船会自动落到同一个图标上（用户的图标规则）。
        """
        it = fit.ship.item
        group = category = None
        try:
            from eos.gamedata import Category, Group
            group = self.edb.gamedata_session.query(Group).filter(Group.ID == it.groupID).first()
            if group is not None:
                category = (self.edb.gamedata_session.query(Category)
                            .filter(Category.ID == group.categoryID).first())
        except Exception:
            pass
        return {
            "typeId": getattr(it, "ID", None),
            "name": getattr(it, "name", None),
            "groupId": getattr(it, "groupID", None),
            "groupName": getattr(group, "name", None) if group is not None else None,
            "categoryName": getattr(category, "name", None) if category is not None else None,
            "raceId": getattr(it, "raceID", None),
        }

    def _charge_attr(self, module, name):
        """弹药的**修正后**属性（技能参与）。必须走 getModifiedChargeAttr，不能用 Item 上的基础值。"""
        try:
            v = module.getModifiedChargeAttr(name)
            if v is not None:
                return v
        except Exception:
            pass
        return None

    def weapon_row(self, module, count=1, input_index=None) -> dict:
        a = self.attr
        charge = getattr(module, "charge", None)
        has_charge = charge is not None

        def ca(name):
            return self._charge_attr(module, name) if has_charge else None

        dmg = {k: ca(f"{k}Damage") for k in ("em", "thermal", "kinetic", "explosive")}
        return {
            "typeId": getattr(module.item, "ID", None),
            "name": getattr(module.item, "name", None),
            "state": self._state_name(module),
            "damageMultiplier": a(module, "damageMultiplier"),
            "rof": a(module, "speed"),
            "optimal": a(module, "maxRange"),
            "falloff": a(module, "falloff"),
            "tracking": a(module, "trackingSpeed"),
            "sigResolution": a(module, "signatureRadius"),
            "aoeCloudSize": ca("aoeCloudSize"),
            "aoeVelocity": ca("aoeVelocity"),
            "aoeDamageReduction": ca("aoeDamageReductionFactor"),
            "aoeDamageReductionSensitivity": ca("aoeDamageReductionSensitivity"),
            "missileVelocity": ca("maxVelocity"),
            "missileFlightMs": ca("explosionDelay"),
            "capNeed": a(module, "capacitorNeed"),
            "chargeTypeId": getattr(charge, "ID", None) if has_charge else None,
            "chargeName": getattr(charge, "name", None) if has_charge else None,
            "dmgTypes": dmg,
            "count": count,
            "inputIndex": input_index,
        }

    def drone_row(self, drone, count=1) -> dict:
        a = self.attr
        return {
            "typeId": getattr(drone.item, "ID", None),
            "name": getattr(drone.item, "name", None),
            "count": count,
            "damageMultiplier": a(drone, "damageMultiplier"),
            "rof": a(drone, "speed"),
            "optimal": a(drone, "maxRange"),
            "falloff": a(drone, "falloff"),
            "tracking": a(drone, "trackingSpeed"),
            "optimalSigRadius": a(drone, "optimalSigRadius"),
            "dmgTypes": {k: a(drone, f"{k}Damage") for k in ("em", "thermal", "kinetic", "explosive")},
            "hpEach": {"shield": a(drone, "shieldCapacity"), "armor": a(drone, "armorHP"), "hull": a(drone, "hp")},
            "signatureRadius": a(drone, "signatureRadius"),
            "maxVelocity": a(drone, "maxVelocity"),
            "bandwidthUsed": a(drone, "droneBandwidthUsed"),
        }

    # ---------------- op 分发 ----------------
    def op_version(self, req):
        return {"ok": True, "pyfaVersion": self.version, "op": "version"}

    def op_ping(self, req):
        return {"ok": True, "pong": True, "pyfaVersion": self.version}

    def op_resolve_names(self, req):
        out, missing = {}, []
        for nm in req.get("names", []):
            it = self.item_by_name(str(nm))
            if it is None:
                missing.append(nm)
            else:
                out[nm] = {"typeId": it.ID, "groupID": getattr(it, "groupID", None)}
        return {"ok": True, "resolved": out, "missing": missing}

    def op_valid_charges(self, req):
        """列出某型号武器可装的弹药（PYFA getValidCharges），供 UI 右键换弹。"""
        it = self._resolve(req.get("module") or {"typeId": req.get("moduleTypeId")})
        if it is None:
            return {"ok": False, "error": {"code": "UNKNOWN_ITEM",
                                           "message": f"未知武器: {req.get('moduleTypeId')!r}"}}
        try:
            fit = self.Fit()
            fit.ship = self.Ship(self.item_by_id(17726), owner=self.character)
            fit.character = self.character
            module = self.Module(it)
            fit.modules.append(module)
            charges = module.getValidCharges() or []
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": {"code": "CALC_FAILED", "message": str(exc)}}
        rows = sorted(({"typeId": c.ID, "name": c.name} for c in charges),
                      key=lambda r: r["name"])
        return {"ok": True, "moduleTypeId": it.ID, "moduleName": it.name, "charges": rows}

    def op_calc_fit(self, req):
        fit = self.Fit()
        ship_item = self._resolve(req.get("ship") or {})
        if ship_item is None:
            return {"ok": False, "error": {"code": "UNKNOWN_ITEM",
                                           "message": f"未知舰船: {req.get('ship')!r}"}}
        fit.ship = self._vessel(ship_item)
        fit.character = self.character

        unhandled, instances = [], []

        # ---- 1. 装配（此时只写入输入，不读任何数值）----
        for spec in req.get("modules", []):
            it = self._resolve(spec)
            if it is None:
                unhandled.append({"spec": spec, "reason": "UNKNOWN_ITEM"})
                continue
            # ★ 非 Module 的条目（弹药/脚本/装料/无人机…）绝不能拖垮整份配装：
            #   PYFA 的 Module() 会抛 ValueError("Passed item is not a Module")，
            #   一旦冒出去，整份 fit 都算不出属性 → 上层一艘船都建不出来。
            #   这里如实记进 unhandled 后跳过，其余装备照常计算。
            try:
                module = self.Module(it)
            except Exception as exc:  # noqa: BLE001
                unhandled.append({"spec": spec, "reason": "NOT_A_MODULE", "detail": str(exc)})
                continue
            fit.modules.append(module)
            charge_it = None
            if spec.get("chargeTypeId") is not None:
                charge_it = self.item_by_id(int(spec["chargeTypeId"]))
            elif spec.get("chargeName"):
                charge_it = self.item_by_name(str(spec["chargeName"]))
            if charge_it is not None:
                module.charge = charge_it
            module.state = self.STATES.get(str(spec.get("state", "online")).lower(),
                                           self.STATES.get("online"))
            instances.append((module, it, charge_it))

        drone_specs = []
        for spec in req.get("drones", []):
            it = self._resolve(spec)
            if it is None:
                unhandled.append({"spec": spec, "reason": "UNKNOWN_ITEM"})
                continue
            count = int(spec.get("count", 1))
            for _ in range(count):
                fit.drones.append(self.Drone(it))
            drone_specs.append((self.Drone(it), count))

        # ---- 2. 铁骑：每个发射管 = 一个纵队（D-27）----
        fighter_specs = []
        for spec in req.get("fighters") or []:
            it = self._resolve(spec)
            if it is None:
                unhandled.append({"spec": spec, "reason": "UNKNOWN_FIGHTER"})
                continue
            count = max(1, int(spec.get("count", 1)))
            for _ in range(count):
                fit.fighters.append(self.Fighter(it))
            fighter_specs.append((it, count))

        # ---- 3. 先算一次基础值 ----
        # 指挥脉冲要求"先算过一次、挂上 link、再重算"（实测：只 apply 不算 = 无变化）
        fit.calculateModifiedAttributes()

        # ---- 4. 脑插：★ 挂在 **Fit** 上（不是 Character）----
        # 用户的规则：配置里有脑插才算，没有就不算 —— 这里就是"有才挂"。
        implant_rows = []
        for spec in req.get("implants") or []:
            it = self._resolve(spec)
            if it is None:
                unhandled.append({"spec": spec, "reason": "UNKNOWN_IMPLANT"})
                continue
            try:
                imp = self.Implant(it)
                fit.implants.append(imp)
                implant_rows.append(self.implant_row(imp))
            except Exception as exc:
                unhandled.append({"spec": spec, "reason": f"IMPLANT_FAILED: {exc}"})
        implant_rows.sort(key=lambda r: (r.get("slot") or 0, r.get("typeId") or 0))

        # ---- 5. 指挥脉冲（环境加成）----
        link_rows = []
        for spec in ((req.get("env") or {}).get("commandLinks") or []):
            lt = str(spec.get("linkType"))
            # ★ 先校验 linkType：PYFA 对拼错的类型是"静默无效"，那样玩家会以为
            #   脉冲挂上了其实没挂 —— 宁可报错也不要给出错数。
            if lt not in (self.COMMAND_LINK_DEFS or {}):
                unhandled.append({
                    "spec": spec,
                    "reason": f"UNKNOWN_COMMAND_LINK: {lt!r}（合法值见 COMMAND_LINK_DEFS）",
                })
                continue
            try:
                st = max(0, min(5, int(spec.get("strength", 5))))
                ml = bool(spec.get("mindlink", False))
                self.applyCommandLinkToFit(fit, self.CommandLink(lt, st, mindlink=ml))
                link_rows.append({"linkType": lt, "strength": st, "mindlink": ml})
            except Exception as exc:
                unhandled.append({"spec": spec, "reason": f"LINK_FAILED: {exc}"})

        # ---- 6. 重算：让脑插与指挥脉冲生效 ----
        fit.calculateModifiedAttributes()

        # ---- 3. 先算后读：分类并读取最终数值 ----
        weapons, actives, passives = [], [], []
        weapon_index = {}
        for input_index, (module, it, charge_it) in enumerate(instances):
            kind = _kind_of(it)
            # ★ 立体炸弹 / 指挥脉冲 / 拦截泡：PYFA 的 `canDealDamage` 对它们**也为真**，
            #   但它们不是"武器"—— 不需要锁定，也不吃追踪/爆炸应用率。
            #   不排除的话会被当成炮台，读到一份全是 0 的伤害（立体炸弹实测就是这样丢的）。
            if kind in _NON_WEAPON_KINDS:
                volley, is_weapon = None, False
            else:
                volley = self._volley(module)
                try:
                    is_weapon = bool(module.canDealDamage(True))  # 未装弹的发射器也算武器
                except Exception:
                    is_weapon = False
                if volley is not None and volley > 0:
                    is_weapon = True
            if is_weapon:
                key = (it.ID, getattr(charge_it, "ID", None))
                if key in weapon_index:
                    row = weapon_index[key]
                    row["count"] += 1
                    row["volley"] = volley
                    row["dps"] = self._dps(module) * row["count"]
                else:
                    row = self.weapon_row(module, input_index=input_index)
                    row["count"] = 1
                    row["volley"] = volley
                    row["dps"] = self._dps(module)
                    weapon_index[key] = row
                    weapons.append(row)
                continue

            duration = self.attr(module, "duration")
            amounts = self._effect_amounts(module)
            if kind == "other" and not duration and not amounts:
                passives.append({"typeId": it.ID, "name": it.name,
                                 "state": self._state_name(module),
                                 "inputIndex": input_index})
                continue
            if kind == "other":
                unhandled.append({"typeId": it.ID, "name": it.name, "reason": "UNKNOWN_KIND"})
            actives.append({
                "typeId": it.ID, "name": it.name, "kind": kind,
                # 弹药名（指挥脉冲波靠它区分"装甲激能/装甲强化…"）
                "chargeName": getattr(charge_it, "name", None) if charge_it is not None else None,
                "state": self._state_name(module),
                "duration": duration,
                "capNeed": self.attr(module, "capacitorNeed"),
                "optimal": self.attr(module, "maxRange"),
                "falloff": self.attr(module, "falloff"),
                "effectAmounts": amounts,
                "smartbomb": self._smartbomb_of(module) if kind == "smartbomb" else None,
                "microJump": self._microjump_of(module) if kind == "microJump" else None,
                "inputIndex": input_index,
            })

        drones = [self.drone_row(d, c) for d, c in drone_specs]

        return {
            "ok": True,
            "ship": self.ship_info(fit),
            "attrs": self.ship_attrs(fit),
            "weapons": weapons,
            "actives": actives,
            "passives": passives,
            "drones": drones,
            "fighters": self._fighter_rows_of(fit, fighter_specs),
            "implants": implant_rows,
            "env": {"commandLinks": link_rows},
            "unhandled": unhandled,
        }

    def _smartbomb_of(self, module) -> dict:
        """立体炸弹：作用半径 + 四类伤害。

        ★ 属性名实测自 SDE（Large EMP Smartbomb II）：
          `empFieldRange = 6000`（作用半径）、`emDamage = 300`（EMP 型只给 EM，
          其余三类为 0；Proton/Graviton/Plasma 型分别给动能/热能）。
        """
        a = self.attr
        return {
            "range": a(module, "empFieldRange"),
            "dmg": {k: a(module, k + "Damage")
                    for k in ("em", "thermal", "kinetic", "explosive")},
        }

    def _microjump_of(self, module) -> dict:
        """微型跳跃引擎（跳刀）：跃迁距离 + 再启动冷却。

        ★ 属性名实测自 SDE（Large Micro Jump Drive / ID 4383）：
          `duration = 12000`（**先运转 12 s 才起跳**）、
          `moduleReactivationDelay = 180000`（起跳后再启动需等 180 s）。

          距离属性 `mjdJumpRange`：普通/中型**没有**这个属性（标准距离就是 100 km），
          旗舰型给了 `mjdJumpRange = 250000`。缺值/无效一律兜底 100 km。
        """
        a = self.attr

        def num(v, default):
            try:
                f = float(v)
            except (TypeError, ValueError):
                return default
            return f if f > 0 else default

        return {
            "distanceM": num(a(module, "mjdJumpRange"), 100_000.0),
            "cooldownMs": num(a(module, "moduleReactivationDelay"), 0.0),
        }

    def _fighter_rows_of(self, fit, fighter_specs) -> list:
        """把已挂到 fit 上的铁骑按"型号 → 一个纵队一行（含发射管数）"归组。

        `fit.fighters` 里每个元素就是一个纵队，因此直接逐个读；
        再按 typeId 聚合出 count（= 发射管数）。
        """
        rows = []
        by_type = {}
        for fr in (fit.fighters or []):
            tid = getattr(fr.item, "ID", None)
            by_type.setdefault(tid, []).append(fr)
        for order, (tid, frs) in enumerate(by_type.items()):
            row = self.fighter_row(frs[0], order)
            row["count"] = len(frs)
            rows.append(row)
        return rows

    # 这些属性的"无效果"取值不是 0，而是恒等值；比对时需排除
    _IDENTITY = {"speedFactor": 1.0}

    def _effect_amounts(self, module) -> dict:
        keys = (
            # 后勤 / 本地维修
            "shieldBonus", "armorDamageAmount", "structureDamageAmount",
            "powerTransferAmount", "energyNeutralizerAmount", "energyNosferatuAmount",
            # 推进
            "speedFactor", "massAddition",
            # 电子战
            "signatureRadiusBonus", "trackingSpeedBonus", "maxRangeBonus",
            "scanResolutionBonus", "maxTargetRangeBonus",
            "warpScrambleStrength", "warpDisruptionStrength",
            "scanGravimetricStrengthBonus", "scanLadarStrengthBonus",
            "scanMagnetometricStrengthBonus", "scanRadarStrengthBonus",
            # 会战 / 指挥
            "siegeTurretDamageBonus", "siegeMissileDamageBonus", "siegeLauncherROFBonus",
            # 抗性硬化（引擎侧不叠加，仅用于展示与自检）
            "emDamageResistanceBonus", "thermalDamageResistanceBonus",
            "kineticDamageResistanceBonus", "explosiveDamageResistanceBonus",
        )
        out = {}
        for k in keys:
            v = self.attr(module, k)
            if v in (None, 0):
                continue
            if self._IDENTITY.get(k) == v:
                continue
            out[k] = v
        return out

    def dispatch(self, req: dict) -> dict:
        op = req.get("op")
        if op == "ping":
            return self.op_ping(req)
        if op == "version":
            return self.op_version(req)
        if op == "resolveNames":
            return self.op_resolve_names(req)
        if op == "validCharges":
            return self.op_valid_charges(req)
        if op == "calcFit":
            return self.op_calc_fit(req)
        if op == "linkTable":
            return self.op_link_table(req)
        return {"ok": False, "error": {"code": "UNKNOWN_OP", "message": f"未知 op: {op!r}"}}

    def op_link_table(self, req: dict) -> dict:
        """指挥脉冲倍率表（**以 PYFA 为准**，供引擎比较"同种脉冲谁更强"）。

        这样 TS 侧不必硬编码公式；PYFA 若改了系数，重新跑一次即可对齐。
        """
        from eos.saveddata.commandLink import STRENGTHS, getLinkMultiplier
        mult = {}
        for s in STRENGTHS:
            for ml in (False, True):
                mult[f"{s}:{1 if ml else 0}"] = getLinkMultiplier(s, ml)
        return {"ok": True, "strengths": list(STRENGTHS), "multiplier": mult}


# --------------------------------------------------------------------------- #
def _json_default(obj):
    """JSON 安全网：非原生类型尽量转数值，否则转字符串（避免协议因个别字段崩溃）。"""
    for key in ("value", "baseValue", "modifiedValue"):
        v = getattr(obj, key, None)
        if isinstance(v, (int, float)):
            return v
    try:
        return float(obj)
    except Exception:
        return str(obj)


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, default=_json_default)


def serve(oracle: Oracle, max_requests: int = 0) -> None:
    served = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            result = oracle.dispatch(req)
        except Exception as exc:  # noqa: BLE001
            result = {"ok": False, "error": {"code": "INTERNAL",
                                             "message": f"{type(exc).__name__}: {exc}",
                                             "traceback": traceback.format_exc()}}
        result["id"] = req_id
        try:
            line_out = dumps(result)
        except Exception as exc:  # noqa: BLE001
            line_out = dumps({"id": req_id, "ok": False,
                              "error": {"code": "SERIALIZE", "message": str(exc)}})
        sys.stdout.write(line_out + "\n")
        sys.stdout.flush()

        served += 1
        if max_requests and served >= max_requests:
            print(f"[oracle] 达到重启阈值 ({max_requests})，主动退出", file=sys.stderr, flush=True)
            return


def main():
    ap = argparse.ArgumentParser(description="PYFA StatOracle 子进程")
    ap.add_argument("--pyfa-dir", required=True, help="PYFA 安装目录（含 pyfa.exe 与 app/）")
    ap.add_argument("--work-dir", required=True, help="无头核心的工作目录（提取产物）")
    ap.add_argument("--max-requests", type=int, default=0, help="处理 N 个请求后退出（0=不限制）")
    args = ap.parse_args()

    core = ensure_core(args.pyfa_dir, args.work_dir)
    boot_core(core)
    oracle = Oracle(core)

    print(f"[oracle] 就绪：PYFA {core['version']}", file=sys.stderr, flush=True)
    sys.stdout.write(dumps({"id": None, "ok": True, "ready": True,
                            "pyfaVersion": core["version"]}) + "\n")
    sys.stdout.flush()

    serve(oracle, max_requests=max(0, args.max_requests))


if __name__ == "__main__":
    main()
    # ★ PYFA 的 SQLAlchemy / atexit 拆除阶段会触发访问违例
    #   （实测退出码 0xC0000005），会让宿主日志出现"子进程崩溃"的假象。
    #   此时所有输出都已 flush，直接硬退出，拿到干净的 0。
    sys.stdout.flush()
    sys.stderr.flush()
    import os as _os
    _os._exit(0)

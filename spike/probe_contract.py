"""SPIKE-001 L1/L2：修正属性名 + 验证模块开关语义。

L1：传感器强度 / 跃迁速度 的正确属性名。
L2：会战装备、主动抗性硬化、微曲 的开关前后数值对比。
L3（附带）：无人机属性字段。
"""
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pyfa_boot  # noqa

pyfa_boot.boot(verbose=False)
EVE_DB = os.path.join(pyfa_boot.APP_DIR, "eve.db")
SAVE_DIR = os.path.join(pyfa_boot.MODULES_DIR, "saveddata")
os.makedirs(SAVE_DIR, exist_ok=True)
import eos.config as ec
ec.gamedata_connectionstring = "sqlite:///" + EVE_DB.replace("\\", "/")
ec.saveddata_connectionstring = "sqlite:///" + os.path.join(SAVE_DIR, "saveddata.db").replace("\\", "/")
import eos.db as edb
from eos.gamedata import Item
edb.saveddata_meta.create_all(edb.saveddata_engine)
from eos.saveddata.ship import Ship
from eos.saveddata.module import Module
from eos.saveddata.fit import Fit
from eos.saveddata.character import Character
from eos.const import FittingModuleState

char = Character("All 5", defaultLevel=5)
ACTIVE = FittingModuleState.ACTIVE
ONLINE = FittingModuleState.ONLINE


def find_item(n):
    return edb.gamedata_session.query(Item).filter(Item.name == n).first()


def new_fit(ship_name):
    fit = Fit()
    fit.ship = Ship(find_item(ship_name), owner=char)
    fit.character = char
    return fit


print("========== L1：属性名修正 ==========")
f = new_fit("Apocalypse Navy Issue")
f.calculateModifiedAttributes()
cands = [
    "scanGravimetricStrength", "scanLadarStrength", "scanMagnetometricStrength", "scanRadarStrength",
    "gravimetricStrength", "ladarStrength", "magnetometricStrength", "radarStrength",
    "baseWarpSpeed", "warpSpeed", "warpSpeedMultiplier", "warpFactor",
    "alignTime", "agility", "mass", "signatureRadius",
    "shieldRechargeRate", "shieldCapacity",
]
for c in cands:
    try:
        print(f"  {c:<32} = {f.ship.getModifiedItemAttr(c)}")
    except Exception as ex:
        print(f"  {c:<32} ERR {type(ex).__name__}")

print("\n  -- 从 SDE 原始数据看属性是否存在 --")
ship_item = find_item("Apocalypse Navy Issue")
try:
    raw = ship_item.attributes
    print("  gamedata item attribute keys:", sorted(raw.keys()) if raw else None)
except Exception as ex:
    print("  raw attrs ERR", ex)

print("\n========== L2-A：会战装备（siege）开关对比 ==========")
for ship_name, siegename in (("Phoenix", "Siege Module II"), ("Moros", "Siege Module II")):
    it = find_item(siegename)
    if it is None:
        print(f"  {siegename}: not found")
        continue
    for state, label in ((ONLINE, "在线(ONLINE)"), (ACTIVE, "开启(ACTIVE)")):
        try:
            fit = new_fit(ship_name)
            m = Module(it)
            fit.modules.append(m)
            m.state = state
            fit.calculateModifiedAttributes()
            print(f"  [{ship_name} / {label}] maxVelocity={fit.ship.getModifiedItemAttr('maxVelocity')} "
                  f"mass={fit.ship.getModifiedItemAttr('mass')} "
                  f"siegeTurretDamageBonus={m.getModifiedItemAttr('siegeTurretDamageBonus')} "
                  f"siegeMissileDamageBonus={m.getModifiedItemAttr('siegeMissileDamageBonus')} "
                  f"siegeLauncherROFBonus={m.getModifiedItemAttr('siegeLauncherROFBonus')} "
                  f"speedFactor={m.getModifiedItemAttr('speedFactor')} "
                  f"duration={m.getModifiedItemAttr('duration')}")
        except Exception:
            traceback.print_exc()

print("\n========== L2-B：主动抗性硬化 开关对比 ==========")
hardener = find_item("Multispectrum Shield Hardener II") or find_item("Multispectrum Shield Hardener I")
print("  hardener item:", hardener)
if hardener:
    for state, label in ((ONLINE, "在线"), (ACTIVE, "开启")):
        fit = new_fit("Apocalypse Navy Issue")
        m = Module(hardener)
        fit.modules.append(m)
        m.state = state
        fit.calculateModifiedAttributes()
        print(f"  [{label}] shield EM/TH/KIN/EXP = "
              f"{fit.ship.getModifiedItemAttr('shieldEmDamageResonance')}/"
              f"{fit.ship.getModifiedItemAttr('shieldThermalDamageResonance')}/"
              f"{fit.ship.getModifiedItemAttr('shieldKineticDamageResonance')}/"
              f"{fit.ship.getModifiedItemAttr('shieldExplosiveDamageResonance')}")

print("\n  -- 两件同型主动抗性（叠加惩罚）--")
for n, label in ((0, "0 件"), (1, "1 件"), (2, "2 件")):
    fit = new_fit("Apocalypse Navy Issue")
    for _ in range(n):
        m = Module(hardener)
        fit.modules.append(m)
        m.state = ACTIVE
    fit.calculateModifiedAttributes()
    print(f"  [{label}] shield EM res = {fit.ship.getModifiedItemAttr('shieldEmDamageResonance')}")

print("\n========== L2-C：微曲（MWD）开关对比 ==========")
mwd = find_item("5MN Microwarpdrive II")
print("  mwd item:", mwd)
if mwd:
    for state, label in ((ONLINE, "在线"), (ACTIVE, "开启")):
        fit = new_fit("Apocalypse Navy Issue")
        m = Module(mwd)
        fit.modules.append(m)
        m.state = state
        fit.calculateModifiedAttributes()
        print(f"  [{label}] maxVelocity={fit.ship.getModifiedItemAttr('maxVelocity')} "
              f"signatureRadius={fit.ship.getModifiedItemAttr('signatureRadius')} "
              f"speedFactor={m.getModifiedItemAttr('speedFactor')} "
              f"massAddition={m.getModifiedItemAttr('massAddition')}")

print("\n========== L3：无人机属性字段 ==========")
try:
    from eos.saveddata.drone import Drone
    fit = new_fit("Apocalypse Navy Issue")
    drone_item = find_item("Hobgoblin II")
    print("  drone item:", drone_item)
    d = Drone(drone_item)
    fit.drones.append(d)
    fit.calculateModifiedAttributes()
    for a in ("damageMultiplier", "emDamage", "thermalDamage", "kineticDamage", "explosiveDamage",
              "speed", "maxRange", "falloff", "trackingSpeed", "optimalSigRadius",
              "shieldCapacity", "armorHP", "hp", "signatureRadius",
              "droneBandwidthUsed", "maxVelocity"):
        try:
            print(f"    drone.{a:<24} = {d.getModifiedItemAttr(a)}")
        except Exception as ex:
            print(f"    drone.{a:<24} ERR {type(ex).__name__}")
except Exception:
    traceback.print_exc()

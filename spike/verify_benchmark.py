"""SPIKE-001 关键验证：用 PYFA 原生接口复现交接文档基准（灾难级海军型 454.6 DPS）。"""
import dis
import os
import sys

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


def find_item(n):
    return edb.gamedata_session.query(Item).filter(Item.name == n).first()


print("=== FittingModuleState 取值 ===")
for s in FittingModuleState:
    print("   ", s)

print("\n=== getDps 反汇编片段（定位 factorReload）===")
names = [ins.argval for ins in dis.get_instructions(Module.getDps) if ins.opname in ("LOAD_ATTR", "LOAD_METHOD", "LOAD_GLOBAL")]
print("  ", names)

char = Character("All 5", defaultLevel=5)
fit = Fit()
fit.ship = Ship(find_item("Apocalypse Navy Issue"), owner=char)
fit.character = char

lasers = []
for _ in range(8):
    m = Module(find_item("Mega Beam Laser II"))
    fit.modules.append(m)
    lasers.append(m)
for _ in range(2):
    fit.modules.append(Module(find_item("Heat Sink II")))

charge = find_item("Standard L")
for m in lasers:
    m.charge = charge
    m.state = FittingModuleState.ACTIVE

fit.calculateModifiedAttributes()

print("\n=== 结果 ===")
m0 = lasers[0]
print("  damageMultiplier =", m0.getModifiedItemAttr("damageMultiplier"))
print("  speed (ms)       =", m0.getModifiedItemAttr("speed"))
print("  maxRange         =", m0.getModifiedItemAttr("maxRange"))
print("  falloff          =", m0.getModifiedItemAttr("falloff"))
print("  trackingSpeed    =", m0.getModifiedItemAttr("trackingSpeed"))
v = m0.getVolley()
print("  单门齐射 DmgTypes =", v)
rof_s = m0.getModifiedItemAttr("speed") / 1000.0
per = (v.em + v.thermal + v.kinetic + v.explosive) / rof_s
print(f"  单门 DPS = {per:.2f}")
print(f"  8 门总 DPS = {per * 8:.1f}   (文档基准 454.6)")

print("\n  尝试 getDps() ...")
try:
    print("   ", m0.getDps())
except Exception as ex:
    print("    ERR", type(ex).__name__, ex)

print("\n=== 护盾/装甲/结构 HP ===")
for a in ("shieldCapacity", "armorHP", "hp"):
    print(f"  {a} = {fit.ship.getModifiedItemAttr(a)}")

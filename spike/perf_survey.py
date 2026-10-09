"""SPIKE-001：性能（问题8）、稳定性（问题7）、字段完整性（问题4）、体积（问题9）、版本（问题10）。"""
import os
import sys
import time

T_PROCESS_START = time.perf_counter()

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pyfa_boot  # noqa

pyfa_boot.boot(verbose=False)
T_BOOT = time.perf_counter()

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

T_IMPORTS = time.perf_counter()

char = Character("All 5", defaultLevel=5)


def find_item(n):
    return edb.gamedata_session.query(Item).filter(Item.name == n).first()


def build_and_calc():
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
    ch = find_item("Standard L")
    for m in lasers:
        m.charge = ch
        m.state = FittingModuleState.ACTIVE
    fit.calculateModifiedAttributes()
    v = lasers[0].getVolley()
    return fit, lasers[0], (v.em + v.thermal + v.kinetic + v.explosive)


T0 = time.perf_counter()
fit, m0, volley = build_and_calc()
T_FIRST_CALC = time.perf_counter()

print("========== 性能（问题 8）==========")
print(f"  进程启动 -> boot 完成      : {(T_BOOT - T_PROCESS_START) * 1000:.0f} ms")
print(f"  boot -> 全部 import 完成   : {(T_IMPORTS - T_BOOT) * 1000:.0f} ms")
print(f"  import -> 首次计算完成     : {(T_FIRST_CALC - T_IMPORTS) * 1000:.0f} ms")
print(f"  === 冷启动到首次出结果     : {(T_FIRST_CALC - T_PROCESS_START) * 1000:.0f} ms ===")

N = 300
ts = []
for i in range(N):
    a = time.perf_counter()
    build_and_calc()
    ts.append(time.perf_counter() - a)
ts.sort()
print(f"  稳态单次「建装配装+计算」(N={N}): 均值 {sum(ts) / N * 1000:.1f} ms, "
      f"P50 {ts[N // 2] * 1000:.1f} ms, P95 {ts[int(N * 0.95)] * 1000:.1f} ms, max {ts[-1] * 1000:.1f} ms")

print("\n========== 稳定性（问题 7）==========")
try:
    import tracemalloc
    tracemalloc.start()
    build_and_calc()
    s1 = tracemalloc.take_snapshot()
    for _ in range(500):
        build_and_calc()
    s2 = tracemalloc.take_snapshot()
    top = s2.compare_to(s1, "filename")[:5]
    print("  tracemalloc top diffs:")
    for st in top:
        print("   ", st)
except Exception as ex:
    print("  tracemalloc 不可用:", ex)

print("\n========== 字段完整性（问题 4，对照第 5 章）==========")
A = {
    "hp.shield": "shieldCapacity", "hp.armor": "armorHP", "hp.hull": "hp",
    "res.shield.EM": "shieldEmDamageResonance", "res.shield.TH": "shieldThermalDamageResonance",
    "res.shield.KIN": "shieldKineticDamageResonance", "res.shield.EXP": "shieldExplosiveDamageResonance",
    "res.armor.EM": "armorEmDamageResonance", "res.armor.TH": "armorThermalDamageResonance",
    "res.armor.KIN": "armorKineticDamageResonance", "res.armor.EXP": "armorExplosiveDamageResonance",
    "res.hull.EM": "hullEmDamageResonance", "res.hull.TH": "hullThermalDamageResonance",
    "res.hull.KIN": "hullKineticDamageResonance", "res.hull.EXP": "hullExplosiveDamageResonance",
    "cap.capacity": "capacitorCapacity", "cap.rechargeRate": "rechargeRate",
    "scan.maxRange": "maxTargetRange", "scan.resolution": "scanResolution", "scan.maxLocks": "maxLockedTargets",
    "scan.grav": "gravimetricStrength", "scan.ladar": "ladarStrength",
    "scan.magneto": "magnetometricStrength", "scan.radar": "radarStrength",
    "nav.maxVelocity": "maxVelocity", "nav.agility": "agility", "nav.mass": "mass",
    "nav.signatureRadius": "signatureRadius", "nav.warpSpeed": "warpSpeed",
    "drone.bay": "droneCapacity", "drone.bandwidth": "droneBandwidth",
    "slots.hi": "hiSlots", "slots.med": "medSlots", "slots.lo": "lowSlots", "slots.rig": "rigSlots",
    "slots.turret": "turretSlotsLeft", "slots.launcher": "launcherSlotsLeft",
    "resource.cpu": "cpuOutput", "resource.power": "powerOutput",
}
for label, attr in A.items():
    try:
        val = fit.ship.getModifiedItemAttr(attr)
        print(f"  {'OK ' if val is not None else 'NIL'} {label:<22} <- {attr:<28} = {val}")
    except Exception as ex:
        print(f"  ERR {label:<22} <- {attr:<28} : {type(ex).__name__}: {ex}")

print("\n  -- 武器（示例第 1 门）--")
weapon = {
    "dmg[em/th/kin/exp]": None, "rof": "speed", "optimal": "maxRange", "falloff": "falloff",
    "tracking": "trackingSpeed", "sigResolution": "signatureRadius",
    "capNeed": "capacitorNeed",
}
print("    damageMultiplier =", m0.getModifiedItemAttr("damageMultiplier"))
for label, attr in weapon.items():
    if attr is None:
        continue
    try:
        print(f"    {label:<20} <- {attr:<22} = {m0.getModifiedItemAttr(attr)}")
    except Exception as ex:
        print(f"    {label:<20} ERR {ex}")
for a in ("emDamage", "thermalDamage", "kineticDamage", "explosiveDamage"):
    try:
        print(f"    charge.{a:<18} = {m0.getModifiedChargeAttr(a)}")
    except Exception as ex:
        print(f"    charge.{a} ERR {ex}")

print("\n  -- 主动模块效果量示例（远程装甲维修器 II / 护盾回充增量器 II）--")
for modname in ("Remote Armor Repairer II", "Medium Shield Booster II", "5MN Microwarpdrive II"):
    it = find_item(modname)
    if it is None:
        print(f"    {modname}: not found")
        continue
    f2 = Fit()
    f2.ship = Ship(find_item("Apocalypse Navy Issue"), owner=char)
    f2.character = char
    mm = Module(it)
    f2.modules.append(mm)
    f2.calculateModifiedAttributes()
    try:
        print(f"    {modname}: duration={mm.getModifiedItemAttr('duration')} "
              f"capNeed={mm.getModifiedItemAttr('capacitorNeed')} "
              f"armorDamageAmount={mm.getModifiedItemAttr('armorDamageAmount')} "
              f"shieldBonus={mm.getModifiedItemAttr('shieldBonus')} "
              f"speedFactor={mm.getModifiedItemAttr('speedFactor')} "
              f"maxRange={mm.getModifiedItemAttr('maxRange')}")
    except Exception as ex:
        print(f"    {modname} ERR {ex}")

print("\n========== 体积（问题 9）==========")


def dirsize(p):
    t = 0
    for root, dirs, files in os.walk(p):
        for f in files:
            try:
                t += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return t


extracted = dirsize(pyfa_boot.MODULES_DIR)
app = dirsize(pyfa_boot.APP_DIR)
print(f"  提取模块目录 (纯 py + 合并二进制): {extracted / 1048576:.1f} MB")
print(f"  PYFA app/ 原始目录              : {app / 1048576:.1f} MB")
print(f"  eve.db                          : {os.path.getsize(EVE_DB) / 1048576:.1f} MB")
print(f"  pyfa.exe                        : {os.path.getsize(r'D:\\eve  pyfa\\pyfa\\pyfa.exe') / 1048576:.1f} MB")
gui = dirsize(os.path.join(pyfa_boot.MODULES_DIR, "gui"))
svc = dirsize(os.path.join(pyfa_boot.MODULES_DIR, "service"))
wx = dirsize(os.path.join(pyfa_boot.MODULES_DIR, "wx"))
print(f"  gui/ 包                         : {gui / 1048576:.1f} MB")
print(f"  service/ 包                     : {svc / 1048576:.1f} MB")
print(f"  wx/ 包（含二进制）              : {wx / 1048576:.1f} MB")

print("\n========== 版本检测（问题 10）==========")
print("  app/version.yml:", open(os.path.join(pyfa_boot.APP_DIR, "version.yml"), encoding="utf-8").read().strip())
try:
    import config
    print("  config.getVersion() =", config.getVersion())
except Exception as ex:
    print("  config.getVersion ERR:", ex)
try:
    import eos
    print("  eos.version =", getattr(eos, "version", None))
    print("  eos.tag =", getattr(eos, "tag", None))
except Exception as ex:
    print("  eos.version ERR:", ex)

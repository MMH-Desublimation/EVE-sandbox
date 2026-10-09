"""探查 PYFA 的铁骑（Fighter / 战斗机）支持，判断「发射管 = 纵队」(D-27) 能否落到 PYFA 数据上。

需要确认：
  1. eos.saveddata.fighter.Fighter 的构造方式；
  2. fit.fighters 容器；
  3. 每个纵队能读到的量：HP、伤害、循环、射程、发射管数。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pyfa_core import boot_core, ensure_core  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
core = ensure_core(os.environ.get("PYFA_DIR", r"D:\eve  pyfa\pyfa"),
                   os.environ.get("PYFA_WORK_DIR", os.path.join(ROOT, ".pyfa-core")))
boot_core(core)

import eos.db as edb  # noqa: E402
from eos.gamedata import Item  # noqa: E402
import eos.saveddata.fighter as fmod  # noqa: E402

print("=== eos.saveddata.fighter 公开名字 ===")
print([n for n in dir(fmod) if not n.startswith("_")])
for n in dir(fmod):
    o = getattr(fmod, n)
    if isinstance(o, type):
        print(f"  类 {n} bases={[b.__name__ for b in o.__bases__]}")

from eos.saveddata.character import Character  # noqa: E402
from eos.saveddata.fit import Fit  # noqa: E402
from eos.saveddata.ship import Ship  # noqa: E402

char = Character("All 5", defaultLevel=5)

# 载机母舰（铁骑必须挂在有发射管的船上）
CARRIER = 23757          # Archon
FIGHTERS = ["Templar I", "Templar II", "Cyclops I", "Dragonfly I"]

carrier_item = edb.gamedata_session.query(Item).filter(Item.ID == CARRIER).first()
fit = Fit()
fit.ship = Ship(carrier_item, owner=char)
fit.character = char

for fname in FIGHTERS:
    it = edb.gamedata_session.query(Item).filter(Item.name == fname).first()
    print(f"\n--- {fname} ID={getattr(it, 'ID', None)} groupID={getattr(it, 'groupID', None)} ---")
    if it is None:
        continue
    made = None
    for kwargs in ({"owner": char}, {}):
        try:
            made = fmod.Fighter(it, **kwargs)
            print(f"  Fighter(item, {list(kwargs) or '-'}) OK -> {made}")
            break
        except Exception as exc:
            print(f"  Fighter(item, {list(kwargs) or '-'}) 失败: {type(exc).__name__}: {exc}")
    if made is None:
        continue
    try:
        fit.fighters.append(made)
        print("  已加入 fit.fighters")
    except Exception as exc:
        print(f"  加入失败: {type(exc).__name__}: {exc}")

print("\n=== fit.fighters 内容 ===")
try:
    print("  len =", len(fit.fighters))
    for f in fit.fighters:
        print("   -", f)
except Exception as exc:
    print("  读取失败：", exc)

print("\n=== 计算并读取纵队量 ===")
try:
    fit.calculateModifiedAttributes()
except Exception as exc:
    print("  calculateModifiedAttributes 失败：", exc)
for f in fit.fighters:
    print(f"  --- {getattr(f.item, 'name', '?')} ---")
    for key in ("hp", "shieldCapacity", "armorHP", "structureHP",
                "damageMultiplier", "speed", "maxRange", "falloff",
                "maxVelocity", "signatureRadius", "explosionDelay",
                "emDamage", "thermalDamage", "kineticDamage", "explosiveDamage",
                "fighterSquadronMaxSize", "fighterSquadronIsLight"):
        try:
            v = f.getModifiedItemAttr(key)
        except Exception as exc:
            v = f"<err {type(exc).__name__}>"
        if v is not None:
            print(f"      {key} = {v}")

print("\n=== 该舰可挂的发射管数 ===")
for key in ("fighterTubes", "launcherSlotsLeft", "turretSlotsLeft", "maxActiveDrones"):
    try:
        v = fit.ship.getModifiedItemAttr(key)
    except Exception:
        v = None
    print(f"  {key} = {v}")

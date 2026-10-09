"""核实铁骑齐射口径：per-effect 值是否 = 基础伤害 × 纵队规模 × 技能系数，以及是否等于 getVolley()。"""
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
from eos.saveddata.character import Character  # noqa: E402
from eos.saveddata.fit import Fit  # noqa: E402
from eos.saveddata.fighter import Fighter  # noqa: E402
from eos.saveddata.ship import Ship  # noqa: E402


def by_name(n):
    return edb.gamedata_session.query(Item).filter(Item.name == n).first()


def base(it, k):
    at = (it.attributes or {}).get(k)
    if at is None:
        return None
    for key in ("value", "baseValue"):
        v = getattr(at, key, None)
        if isinstance(v, (int, float)):
            return v
    return None


char = Character("All 5", defaultLevel=5)
carrier = by_name("Archon")

for nm in ("Templar I", "Templar II", "Cyclops I", "Malleus I", "Standup Templar I"):
    it = by_name(nm)
    if it is None:
        continue
    fit = Fit()
    fit.ship = Ship(carrier, owner=char)
    fit.character = char
    f = Fighter(it)
    fit.fighters.append(f)
    fit.calculateModifiedAttributes()

    size = int(f.getModifiedItemAttr("fighterSquadronMaxSize") or 1)
    base_atk = base(it, "fighterAbilityAttackMissileDamageTherm") or base(it, "fighterAbilityAttackMissileDamageEM")
    base_msl = base(it, "fighterAbilityMissilesDamageTherm") or base(it, "fighterAbilityMissilesDamageEM")

    print(f"\n{nm}  纵队规模={size}")
    print(f"  基础伤害（SDE）：攻击={base_atk}  导弹={base_msl}")
    print("  修改后（含技能）：攻击伤害=%.2f  导弹伤害=%.2f  倍率=%.4f" % (
        f.getModifiedItemAttr("fighterAbilityAttackMissileDamageTherm") or
        f.getModifiedItemAttr("fighterAbilityAttackMissileDamageEM") or 0,
        f.getModifiedItemAttr("fighterAbilityMissilesDamageTherm") or
        f.getModifiedItemAttr("fighterAbilityMissilesDamageEM") or 0,
        f.getModifiedItemAttr("fighterAbilityAttackMissileDamageMultiplier") or 0,
    ))
    try:
        for eid, per in (f.getVolleyParametersPerEffect() or {}).items():
            for _, v in per.items():
                tot = v.em + v.thermal + v.kinetic + v.explosive
                if tot <= 0:
                    continue
                print(f"  per-effect {eid}: 合计={tot:.2f} "
                      f"(em={v.em:.1f} th={v.thermal:.1f} kin={v.kinetic:.1f} exp={v.explosive:.1f})")
    except Exception as exc:
        print("  per-effect 失败:", exc)
    gv = f.getVolley()
    tot = gv.em + gv.thermal + gv.kinetic + gv.explosive
    print(f"  getVolley() 合计={tot:.2f}")
    print(f"  参考：基础×规模×1.875 = {((base_atk or 0) + (base_msl or 0)) * size * 1.875:.2f}")

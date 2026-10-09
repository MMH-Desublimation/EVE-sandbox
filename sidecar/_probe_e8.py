"""探查：立体炸弹（smartbomb）的伤害与作用半径属性；指挥脉冲倍率表。"""
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

print("=" * 78)
print("一、立体炸弹（smartbomb）")
print("=" * 78)
rows = edb.gamedata_session.query(Item).filter(Item.name.like("%Smartbomb%")).limit(12).all()
for it in rows:
    print(f"  {it.ID:>7}  {it.name}  group={it.groupID}")

print("\n单个立体炸弹的属性（伤害/范围）：")
it = edb.gamedata_session.query(Item).filter(Item.name == "Large EMP Smartbomb II").first()
if it is None:
    it = edb.gamedata_session.query(Item).filter(Item.name.like("%Smartbomb%")).first()
print(f"  样本：{it.name} (ID={it.ID})")
for k, at in sorted((it.attributes or {}).items()):
    low = k.lower()
    if not any(n in low for n in ("damage", "range", "emp", "field", "radius",
                                  "duration", "capacitor", "charge", "explosive",
                                  "thermal", "kinetic", "em")):
        continue
    v = None
    for key in ("value", "baseValue"):
        vv = getattr(at, key, None)
        if isinstance(vv, (int, float)):
            v = vv
            break
    print(f"    {k} = {v}")

effs = getattr(it, "effects", None)
vals = list(effs.values()) if hasattr(effs, "values") else list(effs or [])
print("  effects:", [getattr(e, "name", None) for e in vals if getattr(e, "name", None)])

print()
print("=" * 78)
print("二、指挥脉冲倍率表（getLinkMultiplier）")
print("=" * 78)
from eos.saveddata.commandLink import STRENGTHS, getLinkMultiplier  # noqa: E402

print("  STRENGTHS =", STRENGTHS)
print("  strength | mindlink=F | mindlink=T")
for s in STRENGTHS:
    a = getLinkMultiplier(s, False)
    b = getLinkMultiplier(s, True)
    print(f"    {s}      | {a:<10} | {b:<10}")
print("  推断公式自检：(1+0.05s) × 1.5(skill) × 1.25(tech) × (ml?1.25:1)")
for s in STRENGTHS:
    for ml in (False, True):
        pred = (1 + 0.05 * s) * 1.5 * 1.25 * (1.25 if ml else 1)
        got = getLinkMultiplier(s, ml)
        print(f"    s={s} ml={int(ml)} 预测={pred:.7f} 实测={got:.7f} "
              f"{'OK' if abs(pred - got) < 1e-9 else '不一致'}")

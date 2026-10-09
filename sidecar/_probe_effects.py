"""探查 PYFA Item.effects 的结构与名称（用于修正 kind 判定）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pyfa_core import boot_core, ensure_core  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
core = ensure_core(os.environ.get("PYFA_DIR", r"D:\eve  pyfa\pyfa"),
                   os.environ.get("PYFA_WORK_DIR", os.path.join(ROOT, "spike", "pyfa_runtime")))
boot_core(core)

import eos.db as edb  # noqa: E402
from eos.gamedata import Item  # noqa: E402

for name in ("Siege Module II", "Multispectrum Shield Hardener II", "Heat Sink II",
             "Mega Beam Laser II", "Triage Module II", "Medium Shield Booster II",
             "5MN Microwarpdrive II", "Small Energy Neutralizer II"):
    it = edb.gamedata_session.query(Item).filter(Item.name == name).first()
    print(f"\n=== {name} (ID={getattr(it, 'ID', None)}) ===")
    if it is None:
        continue
    try:
        effs = it.effects
    except Exception as exc:
        print("  effects ERR", exc)
        continue
    print("  effects type:", type(effs).__name__, "len:", len(effs) if effs else 0)
    vals = list(effs.values()) if hasattr(effs, "values") else list(effs or [])
    for e in vals[:12]:
        if isinstance(e, int):
            print(f"    - key={e} (未取到对象)")
            continue
        print(f"    - name={getattr(e, 'name', None)!r}  category={getattr(e, 'category', None)!r}")

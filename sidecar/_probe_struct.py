"""探查 PYFA 的建筑（Upwell Structure）支持。

Ship() 要求 category=Ship，建筑不是 → 必须用 eos.saveddata.citadel。
本探针确认 Citadel 类的用法，并把结论写回 pyfa_oracle.py 的 _ship_or_structure()。
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
import eos.saveddata.citadel as cit  # noqa: E402

print("=== eos.saveddata.citadel 的公开名字 ===")
print([n for n in dir(cit) if not n.startswith("_")])

print("\n=== 类与基类 ===")
for n in dir(cit):
    obj = getattr(cit, n)
    if isinstance(obj, type):
        print(f"  {n}  bases={[b.__name__ for b in obj.__bases__]}  module={obj.__module__}")

print("\n=== 构造函数签名（尽量取） ===")
import inspect  # noqa: E402
for n in dir(cit):
    obj = getattr(cit, n)
    if isinstance(obj, type):
        try:
            print(f"  {n}{inspect.signature(obj.__init__)}")
        except Exception as exc:
            print(f"  {n}: 签名取不到（{exc}）")

print("\n=== 试建建筑 ===")
from eos.saveddata.fit import Fit  # noqa: E402
from eos.saveddata.character import Character  # noqa: E402

char = Character("All 5", defaultLevel=5)
for name in ("Fortizar", "Keepstar", "Raitaru"):
    it = edb.gamedata_session.query(Item).filter(Item.name == name).first()
    print(f"\n--- {name} ID={getattr(it, 'ID', None)} ---")
    built = None
    for clsname in ("Citadel", "Structure", "UpwellStructure"):
        cls = getattr(cit, clsname, None)
        if cls is None:
            continue
        for kwargs in ({"owner": char}, {}):
            try:
                built = cls(it, **kwargs)
                print(f"  {clsname}(item, {list(kwargs) or 'no-kwargs'}) OK -> {built}")
                break
            except Exception as exc:
                print(f"  {clsname}(item, {list(kwargs) or 'no-kwargs'}) 失败: {type(exc).__name__}: {exc}")
        if built is not None:
            break

    if built is None:
        continue
    # 装到 Fit 上并试算属性
    try:
        fit = Fit()
        fit.ship = built
        fit.character = char
        fit.calculateModifiedAttributes()
        print(f"  calculateModifiedAttributes OK；"
              f"shieldCapacity={built.getModifiedItemAttr('shieldCapacity')} "
              f"armorHP={built.getModifiedItemAttr('armorHP')} "
              f"hp={built.getModifiedItemAttr('hp')} "
              f"maxVelocity={built.getModifiedItemAttr('maxVelocity')}")
    except Exception as exc:
        print(f"  计算失败: {type(exc).__name__}: {exc}")

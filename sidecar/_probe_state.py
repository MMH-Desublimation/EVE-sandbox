"""临时探针：PYFA 新建模块的默认状态。用完即删。"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pyfa_core  # noqa: E402

PYFA_DIR = os.environ.get("PYFA_DIR", r"D:\eve  pyfa\pyfa")
WORK_DIR = os.environ.get("PYFA_WORK_DIR", os.path.join(os.path.dirname(HERE), ".pyfa-core"))

core = pyfa_core.ensure_core(PYFA_DIR, WORK_DIR, log=lambda s: print("[core]", s, file=sys.stderr))
pyfa_core.boot_core(core, log=lambda s: print("[core]", s, file=sys.stderr))

import eos.db as edb  # noqa: E402
from eos.gamedata import Item  # noqa: E402
from eos.const import FittingModuleState  # noqa: E402
from eos.saveddata.module import Module  # noqa: E402

print("FittingModuleState:", [(s.name, s.value) for s in FittingModuleState])

IDS = [
    (3049, "Mega Beam Laser II 激光炮"),
    (2048, "Damage Control II 损伤控制"),
    (11269, "Multispectrum Energized Membrane II 多谱电压薄膜"),
    (11337, "Armor Explosive Hardener II 爆抗膜(主动)"),
    (2364, "Heat Sink II 散热槽"),
    (11279, "1600mm Steel Plates II 钢附甲板"),
    (4405, "Y-T8 Compact MWD 微曲"),
    (1974, "Tracking Computer II 索敌计算机"),
]
for tid, label in IDS:
    it = edb.gamedata_session.query(Item).filter(Item.ID == tid).first()
    if it is None:
        print(f"  {label} ({tid}): <SDE 无>")
        continue
    try:
        m = Module(it)
        print(f"  {label} ({tid}) 默认 state = {getattr(m.state, 'name', m.state)}")
    except Exception as exc:
        print(f"  {label} ({tid}) Module() 失败：{exc!r}")

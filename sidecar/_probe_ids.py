"""按名称查 SDE 的 typeId —— 场景与增援编成里要用的 id 一律来自这里，不靠记忆。"""
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

NAMES = [
    # 旗舰（增援编成用）
    "Phoenix", "Revelation", "Moros", "Naglfar",
    "Apostle", "Minokawa", "Lif", "Ninazu",
    "Archon", "Thanatos", "Nidhoggur", "Chimera",
    "Aeon", "Nyx", "Wyvern", "Hel",
    "Avatar", "Erebus", "Ragnarok", "Leviathan",
    "Rhea", "Nomad", "Anshar", "Ark",
    # 会战装备
    "Siege Module II", "Triage Module II",
    "Capital Armor Repairer II", "Capital Shield Booster II",
    "Capital Remote Armor Repairer II", "Capital Remote Shield Booster II",
    "Capital Capacitor Booster II", "Capital Energy Neutralizer II",
    # 旗舰武器与弹药
    "Dual Giga Pulse Laser II", "Dual Giga Beam Laser II",
    "Multifrequency XL", "Standard XL",
    "Citadel Cruise Launcher II", "Scourge Citadel Cruise Missile",
    "Capital Blasters II", "Capital Autocannon II",
    # 建筑（作为单位处理）
    "Fortizar", "Keepstar", "Standup Guided Bomb Launcher I",
    "Standup XL Energy Neutralizer I", "Standup Point Defense Battery I",
    "Standup Multirole Missile Launcher I", "Standup Heavy Missile Launcher I",
    "Standup Missile Guidance Enhancer I",
    "Standup Anticapital Missile Launcher I", "Standup Heavy Energy Neutralizer I",
    # 电子战 / 反跳（用于验证"被反跳禁止旗舰跳"）
    "Warp Scrambler II", "Warp Disruptor II", "Mobile Large Warp Disruptor I",
    "Mobile Medium Warp Disruptor I", "Interdiction Sphere Launcher I",
    "Warp Disruption Field Generator I",
    # 铁骑（若 PYFA/SDE 支持）
    "Templar I", "Templar II", "Dragonfly I", "Firbolg I", "Cyclops I", "Malleus I",
    "Standup Templar I", "Standup Dragonfly I",
]

print("name\ttypeId\tgroupID\tcategoryID")
for n in NAMES:
    it = edb.gamedata_session.query(Item).filter(Item.name == n).first()
    if it is None:
        print(f"{n}\t-\t-\t-")
        continue
    g = edb.gamedata_session.query(Item).filter(Item.ID == it.ID).first()
    print(f"{n}\t{it.ID}\t{it.groupID}\t{getattr(g, 'categoryID', '-')}")

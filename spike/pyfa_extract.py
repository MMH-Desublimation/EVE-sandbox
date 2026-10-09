"""SPIKE-001：从 pyfa.exe (PyInstaller) 中提取所有内嵌 Python 模块。

布局（本机实测）:
  ARCH_START = EOF - pkg_len
  TOC        = data[ARCH_START + toc_off : + toc_len]
  cookie     = data[ARCH_START + toc_off + toc_len : EOF]   (magic 开头)

CArchive TOC entry:
  [4] entry_len  [4] offset  [4] clen  [4] ulen  [1] typecode  name\0
  offset 相对 ARCH_START

PYZ (typecode 'z') 解压后自定义格式:
  b'PYZ\0' [4] pyvers [4] toc_offset  ... (toc 为 marshal)

用法:
  py spike/pyfa_extract.py "D:\\eve  pyfa\\pyfa\\pyfa.exe" spike/pyfa_modules
"""
import io
import marshal
import os
import struct
import sys
import zlib

MAGIC = b"MEI\014\013\012\013\016"


def parse_carchive(data: bytes):
    pos = data.rfind(MAGIC)
    if pos < 0:
        raise SystemExit("not a PyInstaller archive")
    p = pos + 8
    pkg_len = struct.unpack("!i", data[p:p + 4])[0]
    toc_off = struct.unpack("!i", data[p + 4:p + 8])[0]
    toc_len = struct.unpack("!i", data[p + 8:p + 12])[0]
    pyvers = struct.unpack("!i", data[p + 12:p + 16])[0]
    name = data[p + 16:p + 36].split(b"\x00", 1)[0].decode("ascii", "replace")
    arch_start = len(data) - pkg_len
    toc_pos = arch_start + toc_off
    assert toc_pos + toc_len == pos, (toc_pos + toc_len, pos)
    assert arch_start + pkg_len == len(data)
    return {
        "arch_start": arch_start,
        "toc_pos": toc_pos,
        "toc_len": toc_len,
        "pyvers": pyvers,
        "pylibname": name,
    }


def parse_toc(data: bytes, toc_pos: int, toc_len: int):
    entries = []
    pos = toc_pos
    end = toc_pos + toc_len
    while pos < end - 1:
        entry_len = struct.unpack("!i", data[pos:pos + 4])[0]
        if entry_len <= 0 or pos + entry_len > end:
            break
        off = struct.unpack("!i", data[pos + 4:pos + 8])[0]
        clen = struct.unpack("!i", data[pos + 8:pos + 12])[0]
        ulen = struct.unpack("!i", data[pos + 12:pos + 16])[0]
        # 名称字段首字节即 typecode，其后为真正名字
        nm_raw = data[pos + 17:pos + entry_len].split(b"\x00", 1)[0].decode("utf-8", "replace")
        tc = nm_raw[:1]
        nm = nm_raw[1:]
        entries.append({"name": nm, "typecode": tc, "offset": off, "clen": clen, "ulen": ulen})
        pos += entry_len
    return entries


def read_entry(data: bytes, arch_start: int, e: dict) -> bytes:
    raw = data[arch_start + e["offset"]: arch_start + e["offset"] + e["clen"]]
    if e["clen"] < e["ulen"]:
        return zlib.decompress(raw)
    return raw


def parse_pyz(blob: bytes):
    """解析 PYZ 归档。返回 {module_name: marshalled_code_bytes}。"""
    assert blob[:4] == b"PYZ\0", blob[:8]
    toc_off = struct.unpack("!i", blob[8:12])[0]
    toc = marshal.loads(blob[toc_off:])
    modules = {}
    if isinstance(toc, dict):
        items = list(toc.items())
    else:
        items = list(toc)

    def try_pairs(val):
        """按可能的 (pos,length) 组合给出候选。"""
        if isinstance(val, (tuple, list)):
            if len(val) >= 3:
                return [(val[1], val[2]), (val[0], val[1])]
            if len(val) == 2:
                return [(val[0], val[1])]
        return []

    for name, val in items:
        body = None
        for pos, length in try_pairs(val):
            if not (0 <= pos < len(blob)) or length <= 0 or pos + length > len(blob):
                continue
            try:
                cand = zlib.decompress(blob[pos:pos + length])
                marshal.loads(cand)  # 校验
                body = cand
                break
            except Exception:
                continue
        if body is None:
            # 兜底：可能未压缩
            for pos, length in try_pairs(val):
                seg = blob[pos:pos + length]
                try:
                    marshal.loads(seg)
                    body = seg
                    break
                except Exception:
                    continue
        if body is not None:
            modules[name] = body
    return modules


BYTECODE_MAGIC = None  # 由主程序设置（当前 Python 的 MAGIC_NUMBER）


def pyc_header(code_bytes: bytes) -> bytes:
    import importlib.util
    return importlib.util.MAGIC_NUMBER + struct.pack("<I", 0) + struct.pack("<I", 0) + struct.pack("<I", 0)


def main():
    exe = sys.argv[1] if len(sys.argv) > 1 else r"D:\eve  pyfa\pyfa\pyfa.exe"
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "pyfa_modules")
    with open(exe, "rb") as f:
        data = f.read()

    info = parse_carchive(data)
    print(f"[extract] pylibname={info['pylibname']} pyvers={info['pyvers']} arch_start={info['arch_start']}")
    entries = parse_toc(data, info["toc_pos"], info["toc_len"])
    from collections import Counter
    print(f"[extract] CArchive entries = {len(entries)} typecodes = {dict(Counter(e['typecode'] for e in entries))}")

    import shutil
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out, exist_ok=True)

    pyz_entry = next((e for e in entries if e["typecode"] in ("z", "Z")), None)
    if pyz_entry:
        blob = read_entry(data, info["arch_start"], pyz_entry)
        print(f"[extract] PYZ '{pyz_entry['name']}' decompressed = {len(blob)} bytes, magic={blob[:8]!r}")
        modules = parse_pyz(blob)
        print(f"[extract] PYZ modules={len(modules)}")
        keys = sorted(modules.keys())
        top = sorted(set(k.split(".")[0] for k in keys))
        print(f"[extract] top-level packages ({len(top)}): {top}")
        print("[extract] sample modules:", keys[:25])
        want = [k for k in keys if k.split(".")[0] in ("eos", "service", "gui", "config", "pyfa")]
        print(f"[extract] PYFA root packages present: {sorted(set(k.split('.')[0] for k in want))}")
        print("[extract] eos modules:", [k for k in keys if k.startswith("eos")][:40])

        hdr = pyc_header(b"")
        # 包名集合：任何模块名的前缀都是包
        packages = set()
        for name in modules:
            parts = name.split(".")
            for i in range(1, len(parts)):
                packages.add(".".join(parts[:i]))
        # 写盘：按点分路径建目录；包写 __init__.pyc
        n_written = 0
        for name, code_bytes in modules.items():
            parts = name.split(".")
            if name in packages:
                path = os.path.join(out, *parts, "__init__.pyc")
            else:
                path = os.path.join(out, *parts) + ".pyc"
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as w:
                w.write(hdr + code_bytes)
            n_written += 1
        print(f"[extract] wrote {n_written} modules ({len(packages)} packages) -> {out}")

    # 顺带记录 CArchive 的顶层文件（非 PYZ）
    tops = [(e["typecode"], e["name"]) for e in entries if e["typecode"] not in ("z",)]
    print("[extract] other CArchive entries:", tops)


if __name__ == "__main__":
    main()

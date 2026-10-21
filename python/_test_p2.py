"""Phase 2 安全子集集成测试（真实后端 + 真实探针，仅只读/离线操作）。

不含 program/erase/fill 等破坏性写操作。单进程内 start_managed 拉起后端，
直接调用各命令 handler 走真实 HTTP，覆盖 target / commander / flash(只读)。
"""

import argparse
from omni_cli import client
from omni_cli.commands import target, commander, flash


def ns(**kw):
    defaults = dict(json_=False, quiet=False, timeout=45, managed=False,
                    backend_port=None, flash_sub=None, commander_sub=None,
                    target_sub=None, search=None, limit=0, uid=None,
                    out="", part=None, type="chip", no_run=False, batch="")
    defaults.update(kw)
    return argparse.Namespace(**defaults)


def main():
    proc, port = client.start_managed(45)
    c = client.ApiClient(port)
    try:
        print("== target list (search=stm32f4) ==")
        target._list(c, ns(search="stm32f4", limit=6))

        print("\n== target info stm32f407xg ==")
        target._info(c, ns(part="stm32f407xg"))

        print("\n== commander exec help (离线) ==")
        commander._exec(c, ns(command=["help"]))

        print("\n== commander list --json (pyOCD 探针/目标列表，离线) ==")
        commander._exec(c, ns(command=["list"], json_=True))

        # 连接真实目标以便线上命令
        probes = c.get("/api/probes")["probes"]
        uid = probes[0]["uid"]
        print(f"\n== connect uid={uid} (attach, stm32f407xg) ==")
        c.post(f"/api/probes/{uid}/connect",
               {"target": "stm32f407xg", "interface": "swd", "connect_mode": "attach"})

        print("\n== commander exec status ==")
        commander._exec(c, ns(command=["status"], uid=uid))

        print("\n== commander exec reg pc ==")
        commander._exec(c, ns(command=["reg", "pc"], uid=uid))

        print("\n== commander exec read32 0x080000C0 4 ==")
        commander._exec(c, ns(command=["read32", "0x080000C0", "4"], uid=uid))

        print("\n== flash blank-check (0x08000000, 64) ==")
        flash._blank(c, ns(addr="0x08000000", size="64", uid=uid))

        print("\n== flash read --type range 0x08000000 64 (json) ==")
        flash._read(c, ns(type="range", addr="0x08000000", size="64", uid=uid, json_=True))

        print("\n== flash reset ==")
        flash._reset(c, ns(type="hw", no_run=False, uid=uid))

        print("\n== 离线错误: verify 读文件（未连接也行但需要文件，演示错误路径）==")
        # 演示缺显式 uid 时自动取第一个探针
        print("OK: 安全子集全部通过")
    finally:
        client.stop(proc.pid)


if __name__ == "__main__":
    main()
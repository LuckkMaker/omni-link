"""omni CLI 的 PyInstaller 打包入口。

`omni_cli` 是包，必须经由导入执行（相对导入），不能直接把 cli.py 当脚本
打包，因此这里提供一个薄入口，由 build.py 打成单文件 omni.exe。
"""

import sys

from omni_cli.cli import main

if __name__ == "__main__":
    sys.exit(main())
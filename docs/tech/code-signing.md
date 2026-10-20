# 代码签名（消除“未知发布者”提示）

## 现象

用户下载并运行 `OMNI Link-x.y.z-x64-setup.exe` 时，Windows 会给出两类警告：

- **UAC / 文件属性**里“发布者”显示为 **未知**（Unknown publisher）；
- **SmartScreen** 弹出“Windows 已保护你的电脑”，需要点“更多信息 → 仍要运行”。

## 原因

安装包没有做 **Authenticode 数字签名**。Windows 无法确认这个 exe 由谁发布、是否被篡改，只能：

- 把发布者标成“未知”；
- 用 SmartScreen 的文件/发布者声誉决定是否拦截。

SmartScreen 看两个信号（[微软文档](https://learn.microsoft.com/zh-cn/windows/apps/package-and-deploy/smartscreen-reputation)）：

1. **发布者声誉** —— 文件是否签名、证书是否来自受信任的发布者；
2. **文件哈希声誉** —— 这个具体文件是否有足够的正常下载记录。

未签名的文件每个新版本都要从零积累声誉，所以**每次发版都会提示**；签名后证书声誉可以跨版本继承（新版本仍可能提示，但会随下载量衰减）。

> 结论：**没有任何构建参数能“关掉”这个提示**。能改变它的只有两件事——用受信任的证书给每个产物签名，或者上架 Microsoft Store（商店应用由微软重签名，永不提示）。自签名证书对公网分发没有任何帮助（行为和未签名相同）。

## 方案对比

| 方案 | 成本 | 硬件要求 | 首次安装表现 | 适用场景 |
|------|------|----------|--------------|----------|
| **OV 代码签名证书**（DigiCert / Sectigo / SSL.com 等） | 约数千元/年 | 私钥必须在 HSM 中；可购买 CA 的云签名服务，或导出为 `.pfx`（取决于 CA 政策） | 仍可能有 SmartScreen 提示，但显示**已验证的发布者名称**，随下载量衰减 | 对外分发，性价比最高 |
| **EV 代码签名证书** | 更贵 | 硬件令牌（USB HSM），私钥不可导出 | 与 OV 相同（**2024 年起 EV 不再即时免除 SmartScreen**） | 企业采购 / 合规要求 |
| **Azure Artifact Signing**（原 Trusted Signing） | 约 $9.99/月起 | 无硬件令牌，云端签名，CI 友好 | 与 OV 相同 | 有 Azure 账号、希望免硬件令牌 |
| **Microsoft Store** | 商店开发者账号 | 无 | **无提示**（微软重签名） | 面向普通用户分发 |
| **自签名证书** | 免费 | 需在每台目标机器安装根证书 | 与未签名相同 | 仅内网 / 企业 GPO 分发 |

签名证书需要通过 CA 的身份验证（个人开发者也可以申请，但需实名/企业资料）。签名后请**不要再用任何工具修改 exe**，否则签名失效。

## 本项目如何签名

`build.ps1` 已经接好 electron-builder 的签名链路，会自动签名：

- 安装包 `release/OMNI Link-x.y.z-x64-setup.exe`；
- 应用主程序 `win-unpacked/OMNI Link.exe`；
- `resources/python/` 下的 `omni.exe` 与 `omni-backend.exe`（`extraResources` 中的 `.exe`）。

### 方式 A：`.pfx` 证书文件

```powershell
# 参数方式（密码会留在命令历史里，仅本地使用）
.\build.ps1 -PfxPath D:\certs\omni.pfx -PfxPassword "你的密码"

# 环境变量方式（推荐；CI 用 secret 注入）
$env:WIN_CSC_LINK = "D:\certs\omni.pfx"
$env:WIN_CSC_KEY_PASSWORD = "你的密码"
.\build.ps1
```

`WIN_CSC_LINK` 也接受 base64 内容或 `https://` 地址，适合放在 CI 变量里。脚本会把 `-PfxPath` 转成 `WIN_CSC_LINK` 交给 electron-builder，不需要改 `package.json`。

### 方式 B：证书库中的证书（EV 硬件令牌）

EV 证书私钥不可导出，只能装进 Windows 证书库（令牌驱动安装后自动出现）。用指纹或主题名指定：

```powershell
.\build.ps1 -CertSha1 8F1A2B3C4D5E6F...   # 证书 SHA-1 指纹，去掉空格
.\build.ps1 -CertSubject "LuckkMaker"      # 主题名子串匹配
```

脚本会把它转成 `--config.win.signtoolOptions.certificateSha1`（或 `certificateSubjectName`）传给 electron-builder。EV 令牌签名时可能会弹 PIN 输入框。

### 方式 C：Azure Artifact Signing

在 `package.json` 的 `build.win` 中加入（`azureSignOptions` 与 `signtoolOptions` **互斥**）：

```json
"win": {
  "azureSignOptions": {
    "endpoint": "https://eus.codesigning.azure.net/",
    "codeSigningAccountName": "omni-signing",
    "certificateProfileName": "omni-link"
  }
}
```

再注入身份凭据（`AZURE_TENANT_ID`、`AZURE_CLIENT_ID`、`AZURE_CLIENT_SECRET`，或 GitHub Actions 的 OIDC / workload identity federation），并给应用注册分配 *Trusted Signing Certificate Profile Signer* 角色。脚本检测到该配置后会打印 `Code signing: enabled (azure)`。

初次配置见 [Azure 快速入门](https://learn.microsoft.com/zh-cn/azure/trusted-signing/quickstart)；electron-builder 侧会自动安装 `TrustedSigning` PowerShell 模块并调用 `Invoke-TrustedSigning`。

## 校验签名

打包结束时脚本会打印每个产物的签名状态：

```
[build] Signature status:
  OMNI Link-0.5.2-x64-setup.exe        Valid        LuckkMaker
  win-unpacked\OMNI Link.exe           Valid        LuckkMaker
  win-unpacked\resources\python\omni.exe          Valid  LuckkMaker
  win-unpacked\resources\python\omni-backend.exe  Valid  LuckkMaker
```

- 配置了签名但产物仍是 `NotSigned` → 脚本以退出码 1 结束（避免把未签名包发出去）；
- 签名存在但证书链不受信任（自签名）→ 打印警告；
- 只想检查现有产物、不重新打包：

```powershell
.\build.ps1 -VerifyOnly
Get-AuthenticodeSignature 'release\OMNI Link-0.5.2-x64-setup.exe' |
    Format-List Status, StatusMessage, SignerCertificate
```

CI 里可以用 `.\build.ps1 -PfxPath <cert> -RequireSigned`：没有可用签名配置时直接失败，不会静默产出未签名包。

## 覆盖范围与盲区

- `signExts` 默认为空 → electron-builder 只签名 `.exe`。因此 Python 后端 `_internal/` 下的 `.dll` / `.pyd` **不签名**（它们不会触发“未知发布者”，但可能影响杀毒软件的启发式判断）。
- 想更彻底可以设置 `"win": { "signExts": [".exe", ".dll", ".pyd"] }`，代价是每个文件都要单独调用一次签名工具，构建时间显著增加（默认还是 SHA-1 + SHA-256 双签）。如果只需要 SHA-256，可加 `"win": { "signtoolOptions": { "signingHashAlgorithms": ["sha256"] } }`。
- NSIS 卸载器由 electron-builder 在打包时一并签名（除非用 `nsis.script` 完全自定义安装脚本，此时会跳过卸载器签名，与本项目无关）。
- `latest.yml` / `.blockmap` 由 electron-builder 在签名之后生成，自动化流程里不要再手工改安装包，否则自动更新的哈希校验会失败。

## 给已经构建好的安装包补签

如果证书到手时安装包已经打好了（比如当前的 0.5.2），可以跳过重新打包直接补签：

```powershell
$signtool = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\windows-10\x64\signtool.exe"
& $signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
    /f D:\certs\omni.pfx /p "你的密码" `
    "release\OMNI Link-0.5.2-x64-setup.exe"
```

注意两点：

1. **补签会改变文件哈希**，`latest.yml` 里的 `sha512` 与 `.blockmap` 随之失效。若暂时不做自动更新可以接受；要发布更新就必须重新打包（让脚本在签名后生成这些文件）。
2. 补签只能签安装包本身，`win-unpacked` 里的已解包文件不会被带进安装包——正式发布请走 `build.ps1` 重新打包。

## 常见问题

**签了名为什么还提示？**
新证书没有声誉积累，SmartScreen 会先显示“无法识别的应用”，但发布者名称是已验证的；下载量上去后提示消失。这不是签名失败——用 `Get-AuthenticodeSignature` 确认 `Status` 为 `Valid`。

**EV 证书能立刻免提示吗？**
不能。微软 2024 年起对 EV 与 OV 一视同仁，仅为绕过 SmartScreen 买 EV 没有意义。

**时间戳服务器超时（国内网络常见）？**
签名会失败并中断打包。换一个 RFC3161 服务器重试：

```powershell
.\build.ps1 -PfxPath ... -TimestampServer http://timestamp.sectigo.com
```

**证书过期后旧版本还能装吗？**
只要签名时带了时间戳，证书过期后签名仍然有效。

**杀毒软件误报？**
未签名 + PyInstaller 打包的 exe 很容易被启发式规则误报。签名能显著改善，但不能完全避免；必要时向厂商提交误报样本。

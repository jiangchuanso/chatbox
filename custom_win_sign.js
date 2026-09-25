/**
 * Windows Authenticode 代码签名 hook（electron-builder 的 `win.signtoolOptions.sign`）。
 *
 * 被 electron-builder 在打包 Windows 产物时逐个文件调用一次。
 *
 * 设计目标：
 *   - 本地 / 离网构建：机器上没有签名基础设施时，**自动跳过**，绝不阻塞出包。
 *   - CI 发布构建：配置齐全 Azure Key Vault 凭据后，自动用 AzureSignTool 完成签名。
 *
 * 行为矩阵：
 *   - `WINDOWS_CODE_SIGNING_DISABLED` 为 true/1/yes/on → 跳过签名
 *   - 五个 Azure 变量**一个都没设** → 跳过签名（离线/本地开发）
 *   - 只设了**一部分** Azure 变量 → 抛错（避免误产出未签名的发布包）
 *   - 五个 Azure 变量**齐全** → 调用 AzureSignTool 签名
 *
 * 需要的环境变量：
 *   AZURE_KEY_VAULT_URL / AZURE_KEY_VAULT_CLIENT_ID / AZURE_KEY_VAULT_CLIENT_SECRET
 *   AZURE_KEY_VAULT_TENANT_ID / AZURE_KEY_VAULT_CERTIFICATE_NAME
 *
 * 可选覆盖：
 *   AZURE_SIGNTOOL_TIMESTAMP_URL（默认 http://timestamp.globalsign.com/tsa/advanced）
 *   AZURE_SIGNTOOL_FILE_DIGEST（默认 sha256）
 *   AZURE_SIGNTOOL_TIMESTAMP_DIGEST（默认 sha256）
 *   AZURE_SIGNTOOL_DESCRIPTION（默认 Chatbox）
 *   AZURE_SIGNTOOL_DESCRIPTION_URL（默认 https://chatboxai.app）
 */
const { execFileSync } = require('node:child_process')

const AZURE_VARS = [
  'AZURE_KEY_VAULT_URL',
  'AZURE_KEY_VAULT_CLIENT_ID',
  'AZURE_KEY_VAULT_CLIENT_SECRET',
  'AZURE_KEY_VAULT_TENANT_ID',
  'AZURE_KEY_VAULT_CERTIFICATE_NAME',
]

const isTruthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())

const isSet = (name) => String(process.env[name] || '').trim() !== ''

async function sign(configuration) {
  const file = configuration && configuration.path
  if (!file) {
    throw new Error('[custom_win_sign] 未收到待签名文件路径（configuration.path 缺失）')
  }

  if (isTruthy(process.env.WINDOWS_CODE_SIGNING_DISABLED)) {
    console.log(`[custom_win_sign] WINDOWS_CODE_SIGNING_DISABLED 已设置，跳过签名：${file}`)
    return
  }

  const missing = AZURE_VARS.filter((name) => !isSet(name))

  // 一个都没配：本地 / 离网构建，直接跳过，不阻塞出包。
  if (missing.length === AZURE_VARS.length) {
    console.log(`[custom_win_sign] 未检测到 Azure Key Vault 配置，跳过签名：${file}`)
    return
  }

  // 只配了一部分：很可能是误配置，宁可失败也不要产出表面正常、实际未签名的发布包。
  if (missing.length > 0) {
    throw new Error(
      `[custom_win_sign] Azure Key Vault 配置不完整，缺失：${missing.join(', ')}。` +
        '请补齐以上环境变量，或设置 WINDOWS_CODE_SIGNING_DISABLED=1 显式跳过签名。',
    )
  }

  const args = [
    'sign',
    '-kvu', process.env.AZURE_KEY_VAULT_URL,
    '-kvi', process.env.AZURE_KEY_VAULT_CLIENT_ID,
    '-kvs', process.env.AZURE_KEY_VAULT_CLIENT_SECRET,
    '-kvt', process.env.AZURE_KEY_VAULT_TENANT_ID,
    '-kvc', process.env.AZURE_KEY_VAULT_CERTIFICATE_NAME,
    '-tr', process.env.AZURE_SIGNTOOL_TIMESTAMP_URL || 'http://timestamp.globalsign.com/tsa/advanced',
    '-td', process.env.AZURE_SIGNTOOL_TIMESTAMP_DIGEST || 'sha256',
    '-fd', process.env.AZURE_SIGNTOOL_FILE_DIGEST || 'sha256',
    '-du', process.env.AZURE_SIGNTOOL_DESCRIPTION_URL || 'https://chatboxai.app',
    '-d', process.env.AZURE_SIGNTOOL_DESCRIPTION || 'Chatbox',
    '-v',
    file,
  ]

  console.log(`[custom_win_sign] 使用 AzureSignTool 签名：${file}`)
  try {
    execFileSync('AzureSignTool', args, { stdio: 'inherit' })
  } catch (error) {
    const detail = error && error.message ? error.message : String(error)
    throw new Error(
      '[custom_win_sign] AzureSignTool 签名失败。请确认已安装（dotnet tool install --global AzureSignTool --version 7.0.1）且凭据有效。\n' +
        detail,
    )
  }
}

module.exports = sign
module.exports.default = sign

/**
 * beforePack hook for electron-builder.
 *
 * With pnpm's node-linker=hoisted, dependencies declared in
 * release/app/package.json get hoisted to the workspace root
 * node_modules/ instead of release/app/node_modules/.
 * electron-builder only packages release/app/node_modules/,
 * so transitive deps like detect-libc, node-fetch, zod end up
 * missing from the asar.
 *
 * This script runs `npm ci --omit=dev` in release/app/
 * to create a complete, flat node_modules/ before packaging,
 * then removes dev-only artifacts that shouldn't ship. It uses the effective
 * registry from the workspace root so local and CI installs follow the same
 * registry selection as the root pnpm install.
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { verifyInstalledRuntimeDeps } = require('./runtime-deps.cjs')

exports.default = async function ensureAppDeps(context) {
  const appDir = path.join(__dirname, '..', '..', 'release', 'app')
  const projectDir = path.join(appDir, '..', '..')
  const nodeModulesDir = path.join(appDir, 'node_modules')

  // Remove pnpm's incomplete hoisted node_modules if it exists
  if (fs.existsSync(nodeModulesDir)) {
    fs.rmSync(nodeModulesDir, { recursive: true, force: true })
  }

  console.log('[ensure-app-deps] Installing production dependencies in release/app/ ...')
  execSync('npm ci --omit=dev --ignore-scripts', {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_registry: getProjectRegistry(projectDir) },
  })

  verifyInstalledRuntimeDeps(appDir)
  verifyVersionsMatchPnpmWorkspace(appDir)

  // Remove type-only packages that are not needed at runtime.
  // @anthropic-ai/sandbox-runtime incorrectly lists @types/lodash-es
  // in production dependencies, pulling in @types/* and undici-types.
  const packagesToRemove = ['@types', 'undici-types']
  for (const pkg of packagesToRemove) {
    const pkgPath = path.join(nodeModulesDir, pkg)
    if (fs.existsSync(pkgPath)) {
      fs.rmSync(pkgPath, { recursive: true, force: true })
      console.log(`[ensure-app-deps] Removed dev-only package: ${pkg}`)
    }
  }

  console.log('[ensure-app-deps] Done.')
}

function readProjectNpmrc(projectDir) {
  return fs.readFileSync(path.join(projectDir, '.npmrc'), 'utf8')
}

function getProjectRegistry(projectDir, options = {}) {
  const readNpmrc = options.readNpmrc || readProjectNpmrc
  let registry = ''
  for (const line of readNpmrc(projectDir).split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator >= 0 && line.slice(0, separator).trim() === 'registry') {
      registry = line.slice(separator + 1).trim()
    }
  }
  if (!registry) {
    throw new Error('[ensure-app-deps] workspace .npmrc must configure a default registry')
  }
  return registry
}

/**
 * Guard against version skew between release/app/package-lock.json (used by
 * `npm ci` to materialize node_modules) and the root pnpm-lock.yaml (used by
 * electron-builder's pnpm node-module collector).
 *
 * electron-builder detects this repo as a pnpm workspace and resolves the
 * packaged dependency tree via `pnpm list`, while the physical node_modules is
 * created by npm. If the two lockfiles resolve a package to different versions,
 * the collector cannot find the expected version on disk and silently drops the
 * package from the asar — e.g. ws@8.20.0 on disk vs ws@8.19.0 expected caused
 * `Cannot find module 'ws'` at app startup. Keep the versions aligned (e.g.
 * via "overrides" in release/app/package.json); this check makes any future
 * skew fail the build loudly instead of shipping a broken app.
 *
 * `pnpm list` runs after `npm ci` has replaced release/app/node_modules, so the
 * directory has no pnpm install metadata; `--lockfile-only` makes pnpm build
 * the tree from the lockfile instead of inspecting node_modules, which keeps
 * this check reliable regardless of the node_modules state.
 *
 * Type-only packages (@types/*, undici-types) are excluded: they are removed
 * from disk before packaging and never needed at runtime.
 */
function readPnpmProductionDependencyTree(appDir) {
  return execSync(
    'pnpm list --prod --json --depth Infinity --silent --loglevel=error --lockfile-only',
    {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, COREPACK_ENABLE_STRICT: '0' },
    },
  ).toString()
}

function verifyVersionsMatchPnpmWorkspace(appDir, options = {}) {
  const readPnpmList = options.readPnpmList || readPnpmProductionDependencyTree
  let pnpmList
  try {
    const output = readPnpmList(appDir)
    pnpmList = JSON.parse(output)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[ensure-app-deps] failed to verify versions against pnpm workspace lockfile: ${message}`,
    )
  }

  const pnpmVersions = new Map()
  const walk = (node) => {
    for (const [depName, dep] of Object.entries(node?.dependencies || {})) {
      if (dep && dep.version) {
        pnpmVersions.set(depName, dep.version)
      }
      walk(dep)
    }
  }
  walk(Array.isArray(pnpmList) ? pnpmList[0] : pnpmList)

  if (pnpmVersions.size === 0) {
    // release/app is not a pnpm workspace importer (pnpm-workspace.yaml only lists
    // packages/*), so `pnpm list --lockfile-only` returns an empty tree here.
    // Fall back to comparing the two lockfiles directly: the `packages` section of
    // the root pnpm-lock.yaml is exactly what electron-builder's pnpm collector uses,
    // and it does not depend on the state of release/app/node_modules.
    // Keep failing closed when the lockfile itself yields no versions either.
    const lockedVersions = readPnpmLockedVersions(path.join(appDir, '..', '..'))
    if (lockedVersions.size === 0) {
      throw new Error(
        '[ensure-app-deps] pnpm list returned no production dependencies — cannot verify version alignment with the pnpm workspace lockfile. ' +
          'Run `pnpm list --prod --json --lockfile-only` in release/app/ to debug.',
      )
    }
    const lockMismatches = findNpmLockMismatches(appDir, lockedVersions)
    if (lockMismatches.length > 0) {
      throw new Error(
        `[ensure-app-deps] version skew between release/app/package-lock.json and pnpm-lock.yaml:\n${lockMismatches.join('\n')}\n` +
          'Align the versions (e.g. via "overrides" in release/app/package.json), otherwise the packaged app will silently miss runtime dependencies.',
      )
    }
    console.log('[ensure-app-deps] verified dependency versions against pnpm-lock.yaml (pnpm list returned an empty tree)')
    return
  }

  const npmLock = JSON.parse(fs.readFileSync(path.join(appDir, 'package-lock.json'), 'utf8'))
  const mismatches = []
  for (const [name, pnpmVersion] of pnpmVersions) {
    if (name.startsWith('@types/') || name === 'undici-types') {
      continue
    }
    const npmKey = Object.keys(npmLock.packages).find((key) => {
      return key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)
    })
    const npmVersion = npmKey != null ? npmLock.packages[npmKey].version : undefined
    if (npmVersion !== pnpmVersion) {
      mismatches.push(`  ${name}: npm lock ${npmVersion ?? '(missing)'} != pnpm lock ${pnpmVersion}`)
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `[ensure-app-deps] version skew between release/app/package-lock.json and the pnpm workspace lockfile:\n${mismatches.join('\n')}\n` +
        'Align the versions (e.g. via "overrides" in release/app/package.json), otherwise the packaged app will silently miss runtime dependencies.',
    )
  }

  console.log('[ensure-app-deps] verified dependency versions match pnpm workspace lockfile')
}

/**
 * Read the `packages:` section of the root pnpm-lock.yaml. Keys are `name@version`,
 * optionally quoted and suffixed with peer dependency contexts, e.g.
 * `'@scope/pkg@1.2.3(peer@1.0.0)'`. A package can legitimately appear at more than
 * one version, so collect a set of versions per package name.
 */
function readPnpmLockedVersions(projectDir) {
  const lines = fs.readFileSync(path.join(projectDir, 'pnpm-lock.yaml'), 'utf8').split(/\r?\n/)
  const start = lines.indexOf('packages:')
  if (start < 0) return new Map()

  const versions = new Map()
  for (const line of lines.slice(start + 1)) {
    if (line && !/^\s/.test(line)) break
    if (!/^ {2}\S/.test(line)) continue

    const key = line.trim().replace(/:$/, '').replace(/^'|'$/g, '').replace(/\(.*$/, '')
    const separator = key.lastIndexOf('@')
    if (separator <= 0) continue
    const name = key.slice(0, separator)
    const version = key.slice(separator + 1)
    if (!/^\d/.test(version)) continue

    if (!versions.has(name)) versions.set(name, new Set())
    versions.get(name).add(version)
  }
  return versions
}

/**
 * Compare every production package that npm ci installed in release/app/ with the
 * versions present in the pnpm workspace lockfile. Packages absent from the pnpm
 * lockfile are skipped (they cannot be dropped by electron-builder's collector),
 * and type-only packages are excluded just like in the `pnpm list` path above.
 */
function findNpmLockMismatches(appDir, lockedVersions) {
  const npmLock = JSON.parse(fs.readFileSync(path.join(appDir, 'package-lock.json'), 'utf8'))
  const marker = 'node_modules/'
  const mismatches = []
  for (const [key, pkg] of Object.entries(npmLock.packages || {})) {
    if (!pkg || !pkg.version) continue
    const index = key.lastIndexOf(marker)
    if (index < 0) continue
    const name = key.slice(index + marker.length)
    if (name.startsWith('@types/') || name === 'undici-types') continue

    const allowed = lockedVersions.get(name)
    if (!allowed || allowed.has(pkg.version)) continue
    mismatches.push(`  ${name}: npm lock ${pkg.version} != pnpm lock [${[...allowed].sort().join(', ')}]`)
  }
  return mismatches
}

exports.verifyVersionsMatchPnpmWorkspace = verifyVersionsMatchPnpmWorkspace
exports.getProjectRegistry = getProjectRegistry
exports.readPnpmLockedVersions = readPnpmLockedVersions

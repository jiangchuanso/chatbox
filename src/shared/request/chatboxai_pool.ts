import uniq from 'lodash/uniq'
import { ofetch } from 'ofetch'
import { cache } from '../utils/cache'

let API_ORIGIN = 'https://api.chatboxai.app'

let POOL = [
  'https://api.chatboxai.app',
  'https://chatboxai.app',
  'https://api.ai-chatbox.com',
  'https://api.chatboxapp.xyz',
]

/**
 * Offline / disable-Chatbox-cloud mode.
 *
 * When enabled, every request targeting a Chatbox cloud domain short-circuits
 * immediately instead of hanging on a TCP timeout (tens of seconds, ×retry) in an
 * intranet (no public internet) environment. This eliminates the long spinner
 * before the first token that is caused by `api.chatboxai.app` calls such as
 * session-attachment RAG config, link parsing and the API-origin liveness probe.
 *
 * Driven by the `disableChatboxCloud` setting (synced from both the renderer and
 * the main process) and/or the `CHATBOX_OFFLINE` env var (`1` / `true`).
 */
const chatboxCloudDisabledFromEnv =
  typeof process !== 'undefined' &&
  process.env != null &&
  (process.env.CHATBOX_OFFLINE === '1' || process.env.CHATBOX_OFFLINE === 'true')

let chatboxCloudDisabled = chatboxCloudDisabledFromEnv

export function setChatboxCloudDisabled(value: boolean): void {
  chatboxCloudDisabled = value
}

export function isChatboxCloudDisabled(): boolean {
  return chatboxCloudDisabled
}

const CHATBOX_CLOUD_HOSTS = [
  'api.chatboxai.app',
  'chatboxai.app',
  'cors-proxy.chatboxai.app',
  'api.ai-chatbox.com',
  'api.chatboxapp.xyz',
  'api.chatboxai.com',
]

/** True for any request targeting a Chatbox cloud domain. */
export function isChatboxCloudRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input : (input as Request).url ?? input.toString()
  return CHATBOX_CLOUD_HOSTS.some((host) => url.includes(host))
}

export function isChatboxAPI(input: RequestInfo | URL) {
  const url = typeof input === 'string' ? input : ((input as Request).url ?? input.toString())
  return POOL.some((o) => url.startsWith(o)) || url.startsWith(getChatboxAPIOrigin())
}

export function getChatboxAPIOrigin() {
  if (process.env.USE_LOCAL_API) {
    return 'http://localhost:8002'
  }
  if (process.env.USE_BETA_API) {
    return 'https://api-beta.chatboxai.app'
  }
  if (process.env.USE_NEWDB_API) {
    return 'https://beta-new-db.chatboxai.app'
  }
  return API_ORIGIN
}

/**
 * 按顺序测试 API 的可用性，只要有一个 API 域名可用，就终止测试并切换所有流量到该域名。
 * 在测试过程中，会根据服务器返回添加新的 API 域名，并缓存到本地
 */
export async function testApiOrigins() {
  // Offline mode: skip the liveness probe entirely and keep using the default pool.
  if (isChatboxCloudDisabled()) {
    return POOL
  }

  // 按顺序测试 API 的可用性
  const result = await cache(
    'api_origins',
    async () => {
      let i = 0
      let pool = POOL
      while (i < pool.length) {
        try {
          const origin: string = pool[i]
          const controller = new AbortController()
          setTimeout(() => controller.abort(), 2000) // 2秒超时
          const res = await ofetch<{ data: { api_origins: string[] } }>(`${origin}/api/api_origins`, {
            // ofetch and React Native expose compatible signals through different declarations.
            signal: controller.signal as unknown as NonNullable<Parameters<typeof ofetch>[1]>['signal'],
            retry: 1,
          })
          // 如果服务器返回了新的 API 域名，则更新缓存
          if (res.data.api_origins.length > 0) {
            pool = uniq([...pool, ...res.data.api_origins])
          }
          // 如果当前 API 可用，则切换所有流量到该域名
          API_ORIGIN = origin
          pool = uniq([origin, ...pool]) // 将当前 API 域名添加到列表顶部
          POOL = pool
          return pool
        } catch (e) {
          i++
        }
      }
      return POOL
    },
    { ttl: 1000 * 60 * 60, refreshFallbackToCache: true } // 1小时缓存，失败时使用旧缓存
  )

  return result
}

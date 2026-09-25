import { cachified } from '@epic-web/cachified'
import type { SearchResultItem } from '@shared/types'
import { truncate } from 'lodash'
import platform from '@/platform'
import { getExtensionSettings, getLanguage, getLicenseKey } from '@/stores/settingActions'
import { ChatboxAIAPIError } from '../../../shared/models/errors'
import WebSearch, { DEFAULT_CONTEXT_SNIPPET_MAX_LENGTH } from './base'
import { BingSearch } from './bing'
import { BingNewsSearch } from './bing-news'
import { BochaSearch } from './bocha'
import { ChatboxSearch } from './chatbox-search'
import { QueritSearch } from './querit'
import { normalizeSearxngBaseUrl, SearxngSearch } from './searxng'
import { TavilySearch } from './tavily'

const MAX_CONTEXT_ITEMS = 10

// 根据配置的搜索提供方来选择搜索服务
function getSearchProviders() {
  const settings = getExtensionSettings()
  const licenseKey = getLicenseKey()

  const selectedProviders: WebSearch[] = []
  const provider = settings.webSearch.provider
  const language = getLanguage()

  switch (provider) {
    case 'build-in':
      if (!licenseKey) {
        throw ChatboxAIAPIError.fromCodeName(
          'chatbox_search_license_key_required',
          'chatbox_search_license_key_required'
        )
      }
      selectedProviders.push(new ChatboxSearch(licenseKey))
      break
    case 'bing':
      selectedProviders.push(new BingSearch())
      if (language !== 'zh-Hans' && platform.type !== 'mobile') {
        selectedProviders.push(new BingNewsSearch()) // 国内和移动端容易被重定向到 Bing 首页
      }
      break
    case 'tavily':
      if (!settings.webSearch.tavilyApiKey) {
        throw ChatboxAIAPIError.fromCodeName('tavily_api_key_required', 'tavily_api_key_required')
      }
      selectedProviders.push(new TavilySearch(settings.webSearch.tavilyApiKey))
      break
    case 'bocha':
      if (!settings.webSearch.bochaApiKey) {
        throw ChatboxAIAPIError.fromCodeName('bocha_api_key_required', 'bocha_api_key_required')
      }
      selectedProviders.push(new BochaSearch(settings.webSearch.bochaApiKey))
      break
    case 'querit':
      if (!settings.webSearch.queritApiKey) {
        throw ChatboxAIAPIError.fromCodeName('querit_api_key_required', 'querit_api_key_required')
      }
      selectedProviders.push(
        new QueritSearch(
          settings.webSearch.queritApiKey,
          settings.webSearch.queritMaxResults,
          settings.webSearch.queritTimeRange
        )
      )
      break
    case 'searxng': {
      const searxngBaseUrl = normalizeSearxngBaseUrl(settings.webSearch.searxngBaseUrl ?? '')
      if (!searxngBaseUrl) {
        throw ChatboxAIAPIError.fromCodeName('searxng_base_url_required', 'searxng_base_url_required')
      }
      selectedProviders.push(new SearxngSearch(searxngBaseUrl))
      break
    }
    default:
      throw new Error(`Unsupported search provider: ${provider}`)
  }

  return selectedProviders
}

/**
 * Providers whose results carry complete excerpts declare `contextSnippetMaxLength = null`
 * and keep the whole snippet; everyone else is trimmed to the default budget.
 * Anything that isn't an explicit `null` or a number (e.g. provider doubles in tests) also
 * falls back to the default budget, so the context can never grow unbounded by accident.
 */
function toContextSnippet(snippet: string, provider: WebSearch): string {
  const configured = provider.contextSnippetMaxLength
  const maxLength =
    configured === null ? null : typeof configured === 'number' ? configured : DEFAULT_CONTEXT_SNIPPET_MAX_LENGTH
  if (maxLength === null) return snippet
  return truncate(snippet, { length: maxLength })
}

async function _searchRelatedResults(query: string, signal?: AbortSignal) {
  const providers = getSearchProviders()
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const result = await provider.search(query, signal)
        console.debug(`web search result for "${query}":`, result.items)
        return { provider, result }
      } catch (err) {
        console.error(err)
        return { error: err }
      }
    })
  )

  const successfulResults = results.flatMap((entry) =>
    entry.result ? [{ provider: entry.provider, result: entry.result }] : []
  )
  if (successfulResults.length === 0) {
    throw results[0]?.error ?? new Error('Web search failed')
  }

  const items: { provider: WebSearch; item: SearchResultItem }[] = []

  // add items in turn
  let i = 0
  let hasMore = false
  do {
    hasMore = false
    for (const { provider, result } of successfulResults) {
      const item = result.items[i]
      if (item) {
        hasMore = true
        items.push({ provider, item })
      }
    }
    i++
  } while (hasMore && items.length < MAX_CONTEXT_ITEMS)

  console.debug('web search items', items)

  // 结果原样带进上下文（含提供方协议里的附加字段），只按提供方预算裁剪 snippet
  return items.map(({ provider, item }) => ({
    ...item,
    snippet: toContextSnippet(item.snippet, provider),
  }))
}

const cache = new Map()

export const webSearchExecutor = async (
  { query }: { query: string },
  { abortSignal }: { abortSignal?: AbortSignal }
) => {
  const webSearch = getExtensionSettings().webSearch
  const provider = webSearch.provider
  const cacheIdentity =
    provider === 'searxng' ? `${provider}:${normalizeSearxngBaseUrl(webSearch.searxngBaseUrl ?? '')}` : provider
  const searchResults = await cachified({
    cache,
    key: `search-context:${cacheIdentity}:${query}`,
    ttl: 1000 * 60 * 5,
    getFreshValue: () => _searchRelatedResults(query, abortSignal),
  })
  return { query, searchResults }
}

/**
 * Single source of truth: which configured providers offer the parse_link tool.
 * Keep in sync with the provider classes' `supportsParseLink` flags.
 */
export const PROVIDERS_WITH_PARSE_LINK: ReadonlySet<string> = new Set(['build-in', 'tavily', 'searxng'])

/**
 * Returns the first configured search provider that supports parseLink.
 * Throws the underlying provider error (e.g. missing API key) — caller decides how to handle.
 */
export function getParseLinkProvider(): WebSearch | null {
  const providers = getSearchProviders()
  return providers.find((p) => p.supportsParseLink) ?? null
}

export type { SearchResultItem }

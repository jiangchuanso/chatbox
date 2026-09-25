import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the settings actions before importing the module under test
vi.mock('@/stores/settingActions', () => ({
  getExtensionSettings: vi.fn(),
  getLanguage: vi.fn(() => 'en'),
  getLicenseKey: vi.fn(() => 'test-license-key'),
}))

// Mock the search providers to avoid actual network calls
vi.mock('./bing', () => {
  return {
    BingSearch: class {
      search = vi.fn().mockImplementation(async (query: string) => ({
        items: [
          {
            title: 'Bing Result',
            // teaser snippets are what the default context budget is designed for
            snippet: query === 'long snippet query' ? 'b'.repeat(400) : 'test',
            link: 'https://example.com',
          },
        ],
      }))
    },
  }
})

vi.mock('./bing-news', () => {
  return {
    BingNewsSearch: class {
      search = vi.fn().mockResolvedValue({ items: [] })
    },
  }
})

vi.mock('./tavily', () => {
  return {
    TavilySearch: class {
      constructor(private readonly apiKey: string) {}
      search = vi.fn().mockImplementation(async () => {
        if (this.apiKey === 'failing-key') throw new Error('Tavily unavailable')
        return { items: [{ title: 'Tavily Result', snippet: 'test', link: 'https://example.com' }] }
      })
    },
  }
})

vi.mock('./searxng', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./searxng')>()
  return {
    ...actual,
    SearxngSearch: class {
      // Mirrors the real provider: complete excerpts + optional source metadata.
      contextSnippetMaxLength = null
      constructor(private readonly baseUrl: string) {}
      search = vi.fn().mockImplementation(async (query: string) => ({
        items: [
          {
            title: `SearXNG Result ${this.baseUrl}`,
            snippet: query === 'full excerpt query' ? 'x'.repeat(400) : 'test',
            link: 'https://example.com',
            fileType: 'docx',
            snippetCount: 2,
          },
        ],
      }))
    },
  }
})

vi.mock('./chatbox-search', () => {
  return {
    ChatboxSearch: class {
      search = vi.fn().mockResolvedValue({
        items: [{ title: 'Chatbox Result', snippet: 'test', link: 'https://example.com' }],
      })
    },
  }
})

import { getExtensionSettings } from '@/stores/settingActions'
import { webSearchExecutor } from './index'

const mockGetExtensionSettings = vi.mocked(getExtensionSettings)

describe('webSearchExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns different results for different providers with same query', async () => {
    // First call with bing
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'bing', tavilyApiKey: '' },
    } as ReturnType<typeof getExtensionSettings>)

    const bingResult = await webSearchExecutor({ query: 'test query' }, {})
    expect(bingResult.searchResults).toHaveLength(1)
    expect(bingResult.searchResults[0].title).toBe('Bing Result')

    // Same query but different provider should NOT return cached bing results
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'tavily', tavilyApiKey: 'test-key' },
    } as ReturnType<typeof getExtensionSettings>)

    const tavilyResult = await webSearchExecutor({ query: 'test query' }, {})
    expect(tavilyResult.searchResults).toHaveLength(1)
    expect(tavilyResult.searchResults[0].title).toBe('Tavily Result')
  })

  it('returns cached results for same provider and query', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'bing', tavilyApiKey: '' },
    } as ReturnType<typeof getExtensionSettings>)

    const result1 = await webSearchExecutor({ query: 'cached query' }, {})
    const result2 = await webSearchExecutor({ query: 'cached query' }, {})

    // Both should return same results (cached)
    expect(result1.searchResults).toEqual(result2.searchResults)
  })

  it('uses a distinct cache key for the SearXNG provider', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: 'https://searx.example.com' },
    } as ReturnType<typeof getExtensionSettings>)

    const searxngResult = await webSearchExecutor({ query: 'searxng query' }, {})

    expect(searxngResult.searchResults).toHaveLength(1)
    expect(searxngResult.searchResults[0].title).toBe('SearXNG Result https://searx.example.com')
  })

  it('does not reuse cache when the SearXNG instance URL changes', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: 'https://searx-a.example.com/' },
    } as ReturnType<typeof getExtensionSettings>)

    const first = await webSearchExecutor({ query: 'instance query' }, {})
    expect(first.searchResults[0].title).toBe('SearXNG Result https://searx-a.example.com')

    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: 'https://searx-b.example.com' },
    } as ReturnType<typeof getExtensionSettings>)

    const second = await webSearchExecutor({ query: 'instance query' }, {})
    expect(second.searchResults[0].title).toBe('SearXNG Result https://searx-b.example.com')
  })

  it('reuses cache when the same SearXNG instance is written with a trailing slash', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: 'https://searx-cache.example.com/' },
    } as ReturnType<typeof getExtensionSettings>)

    const first = await webSearchExecutor({ query: 'normalized instance query' }, {})

    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: 'https://searx-cache.example.com' },
    } as ReturnType<typeof getExtensionSettings>)

    const second = await webSearchExecutor({ query: 'normalized instance query' }, {})
    expect(second.searchResults).toEqual(first.searchResults)
  })

  it('rejects a whitespace-only SearXNG instance URL', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: '   ' },
    } as ReturnType<typeof getExtensionSettings>)

    await expect(webSearchExecutor({ query: 'missing url' }, {})).rejects.toMatchObject({
      code: 20036,
    })
  })

  it('propagates the provider error when every configured provider fails', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'tavily', tavilyApiKey: 'failing-key' },
    } as ReturnType<typeof getExtensionSettings>)

    await expect(webSearchExecutor({ query: 'provider failure' }, {})).rejects.toThrow('Tavily unavailable')
  })

  it('keeps complete excerpts and source fields for providers that declare them', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: 'https://searx.example.com' },
    } as ReturnType<typeof getExtensionSettings>)

    const result = await webSearchExecutor({ query: 'full excerpt query' }, {})

    expect(result.searchResults[0]).toMatchObject({
      snippet: 'x'.repeat(400),
      fileType: 'docx',
      snippetCount: 2,
    })
  })

  it('trims teaser snippets to the default context budget', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'bing', tavilyApiKey: '' },
    } as ReturnType<typeof getExtensionSettings>)

    const result = await webSearchExecutor({ query: 'long snippet query' }, {})

    // lodash truncate's default omission marker
    expect(result.searchResults[0].snippet.length).toBeLessThanOrEqual(150)
    expect(result.searchResults[0].snippet.endsWith('...')).toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  extractHtmlTitle,
  extractReadableText,
  extractSearxngDocumentPath,
  normalizeSearxngBaseUrl,
  SearxngSearch,
} from './searxng'

const INSTANCE = 'http://127.0.0.1:4607'
/** 采购合同.docx，与兼容实例 `quote(rel_path)` 的编码结果一致 */
const DOC_PATH = '%E9%87%87%E8%B4%AD%E5%90%88%E5%90%8C.docx'
const DOC_URL = `${INSTANCE}/uploads/${DOC_PATH}`

describe('SearxngSearch', () => {
  it('requests the configured instance search endpoint and maps results', async () => {
    const search = new SearxngSearch('https://searx.example.com/')
    const fetchSpy = vi.spyOn(search, 'fetch').mockResolvedValueOnce({
      results: [
        { title: 'Result title', url: 'https://example.com/page', content: 'Result content' },
        { title: 'Missing URL', content: 'ignored' },
      ],
    } as never)

    const result = await search.search('test query')

    expect(fetchSpy).toHaveBeenCalledWith('https://searx.example.com/search', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      query: {
        q: 'test query',
        format: 'json',
      },
      responseType: 'json',
      signal: undefined,
    })
    expect(result.items).toEqual([
      {
        title: 'Result title',
        link: 'https://example.com/page',
        snippet: 'Result content',
      },
    ])
  })

  it('falls back to snippet when content is not present', async () => {
    const search = new SearxngSearch('https://searx.example.com')
    const fetchSpy = vi.spyOn(search, 'fetch').mockResolvedValueOnce({
      results: [{ title: 'Result title', url: 'https://example.com/page', snippet: 'Result snippet' }],
    } as never)

    const result = await search.search('test query')

    expect(fetchSpy).toHaveBeenCalled()
    expect(result.items[0]?.snippet).toBe('Result snippet')
  })

  it('normalizes instance URLs by trimming whitespace and trailing slashes', () => {
    expect(normalizeSearxngBaseUrl('  https://searx.example.com/  ')).toBe('https://searx.example.com')
    expect(normalizeSearxngBaseUrl('   ')).toBe('')
  })

  it('accepts an empty results array', async () => {
    const search = new SearxngSearch('https://searx.example.com')
    vi.spyOn(search, 'fetch').mockResolvedValueOnce({ results: [] } as never)

    const result = await search.search('empty query')

    expect(result.items).toEqual([])
  })

  it.each([
    ['HTML', '<html>login</html>'],
    ['an object without results', {}],
    ['a non-array results field', { results: { title: 'not an array' } }],
    ['null', null],
  ] as const)('rejects %s as a malformed SearXNG response', async (_label, payload) => {
    const search = new SearxngSearch('https://searx.example.com')
    vi.spyOn(search, 'fetch').mockResolvedValueOnce(payload as never)

    await expect(search.search('invalid query')).rejects.toThrow('invalid JSON search response')
  })

  it('passes through the extra source fields of a compatible instance', async () => {
    const search = new SearxngSearch(`${INSTANCE}/`)
    vi.spyOn(search, 'fetch').mockResolvedValueOnce({
      results: [
        {
          title: '采购合同.docx',
          url: DOC_URL,
          content: '命中的段落一\n命中的段落二',
          file_type: 'docx',
          file_size: 12345,
          file_id: 'a1b2c3',
          snippet_count: 2,
        },
        { title: 'Plain result', url: 'https://example.com/page', content: 'Result content' },
      ],
    } as never)

    const result = await search.search('合同')

    expect(result.items).toEqual([
      {
        title: '采购合同.docx',
        link: DOC_URL,
        snippet: '命中的段落一\n命中的段落二',
        fileType: 'docx',
        fileSize: 12345,
        fileId: 'a1b2c3',
        snippetCount: 2,
      },
      { title: 'Plain result', link: 'https://example.com/page', snippet: 'Result content' },
    ])
  })

  it('declares full-excerpt context and parse_link support', () => {
    const search = new SearxngSearch(INSTANCE)

    expect(search.supportsParseLink).toBe(true)
    expect(search.contextSnippetMaxLength).toBeNull()
  })
})

describe('extractSearxngDocumentPath', () => {
  it('resolves the document path from both download and file-text URLs', () => {
    expect(extractSearxngDocumentPath(INSTANCE, DOC_URL)).toBe(DOC_PATH)
    expect(extractSearxngDocumentPath(INSTANCE, `${INSTANCE}/api/file-text/${DOC_PATH}`)).toBe(DOC_PATH)
  })

  it.each([
    ['another host', 'https://example.com/uploads/a.docx'],
    ['another port', 'http://127.0.0.1:4608/uploads/a.docx'],
    ['a non-document path', `${INSTANCE}/search?q=a`],
    ['a non-URL', '采购合同.docx'],
  ])('returns null for %s', (_label, url) => {
    expect(extractSearxngDocumentPath(INSTANCE, url)).toBeNull()
  })
})

describe('SearxngSearch.parseLink', () => {
  it('reads a document through the instance file-text endpoint', async () => {
    const search = new SearxngSearch(INSTANCE)
    const fetchSpy = vi.spyOn(search, 'fetch').mockResolvedValueOnce({
      file_id: 'a1b2c3',
      filename: '采购合同.docx',
      paragraphs: ['命中的段落一', '   ', '命中的段落二'],
    } as never)

    const result = await search.parseLink(DOC_URL)

    expect(fetchSpy).toHaveBeenCalledWith(`${INSTANCE}/api/file-text/${DOC_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      responseType: 'json',
      signal: undefined,
    })
    expect(result).toEqual({ url: DOC_URL, title: '采购合同.docx', content: '命中的段落一\n\n命中的段落二' })
  })

  it('falls back to the decoded file name when the instance returns no filename', async () => {
    const search = new SearxngSearch(INSTANCE)
    vi.spyOn(search, 'fetch').mockResolvedValueOnce({ paragraphs: ['正文'] } as never)

    const result = await search.parseLink(DOC_URL)

    expect(result).toEqual({ url: DOC_URL, title: '采购合同.docx', content: '正文' })
  })

  it.each([
    ['the request fails', () => Promise.reject(new Error('404'))],
    ['the document has no paragraphs', () => Promise.resolve({ filename: 'x.docx', paragraphs: [] } as never)],
    ['the payload is not a file-text response', () => Promise.resolve('nope' as never)],
  ])('returns null when %s', async (_label, mockImpl) => {
    const search = new SearxngSearch(INSTANCE)
    vi.spyOn(search, 'fetch').mockImplementationOnce(mockImpl as never)

    await expect(search.parseLink(DOC_URL)).resolves.toBeNull()
  })

  it('extracts readable text from a normal web page', async () => {
    const search = new SearxngSearch(INSTANCE)
    const html = [
      '<html><head><title>页面标题</title><script>var a = 1</script></head>',
      '<body><nav>导航</nav><article><h1>大标题</h1><p>第一段</p><p>第二段  &amp; 更多</p></article></body></html>',
    ].join('')
    const fetchSpy = vi.spyOn(search, 'fetch').mockResolvedValueOnce(html as never)

    const result = await search.parseLink('https://example.com/article')

    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/article', {
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      responseType: 'text',
      signal: undefined,
    })
    expect(result?.title).toBe('页面标题')
    expect(result?.content).toBe('大标题\n第一段\n第二段 & 更多')
  })

  it('falls back to the hostname when the page has no title', async () => {
    const search = new SearxngSearch(INSTANCE)
    vi.spyOn(search, 'fetch').mockResolvedValueOnce('<body><p>正文</p></body>' as never)

    const result = await search.parseLink('https://example.com/no-title')

    expect(result).toEqual({ url: 'https://example.com/no-title', title: 'example.com', content: '正文' })
  })

  it.each([
    ['the page is not HTML', '%PDF-1.4 binary'],
    ['the body is empty', '   '],
  ])('returns null when %s', async (_label, body) => {
    const search = new SearxngSearch(INSTANCE)
    vi.spyOn(search, 'fetch').mockResolvedValueOnce(body as never)

    await expect(search.parseLink('https://example.com/file')).resolves.toBeNull()
  })

  it('returns null when fetching the page fails', async () => {
    const search = new SearxngSearch(INSTANCE)
    vi.spyOn(search, 'fetch').mockRejectedValueOnce(new Error('network down'))

    await expect(search.parseLink('https://example.com/down')).resolves.toBeNull()
  })
})

describe('SearxngSearch HTML extraction helpers', () => {
  it('drops scripts, styles and markup from the readable text', () => {
    const html = '<body><style>.a{color:red}</style><p>正文</p><script>alert(1)</script></body>'

    expect(extractReadableText(html)).toBe('正文')
  })

  it('decodes entities in the page title', () => {
    expect(extractHtmlTitle('<html><head><title> A &amp; B </title></head></html>')).toBe('A & B')
  })

  it('returns null when the page has no title element', () => {
    expect(extractHtmlTitle('<html><body><p>无标题</p></body></html>')).toBeNull()
  })
})

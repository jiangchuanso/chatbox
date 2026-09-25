import type { SearchResult, SearchResultItem } from '@shared/types'
import WebSearch, { type ParseLinkResult } from './base'

type SearxngResult = {
  title?: unknown
  url?: unknown
  content?: unknown
  snippet?: unknown
  // 附加字段：SearXNG 协议之外的来源信息，兼容实例（如自建文件搜索）会一并返回，
  // 便于 Agent 判断结果来源与原文定位。
  file_type?: unknown
  file_size?: unknown
  file_id?: unknown
  snippet_count?: unknown
}

type SearxngResponse = {
  results: unknown[]
}

type SearxngFileText = {
  filename?: unknown
  paragraphs?: unknown
}

export function normalizeSearxngBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '')
}

function toNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function toFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isSearxngResult(value: unknown): value is SearxngResult {
  return typeof value === 'object' && value !== null
}

function isSearxngResponse(value: unknown): value is SearxngResponse {
  if (typeof value !== 'object' || value === null || !('results' in value)) {
    return false
  }
  return Array.isArray(value.results)
}

/**
 * 兼容实例把同一份文档同时暴露为下载地址（`/uploads/<相对路径>`）和正文接口
 * （`/api/file-text/<相对路径>`）。两者的 URL 路径都指向实例上的文档。
 */
const INSTANCE_DOCUMENT_PATH_PREFIXES = ['/uploads/', '/api/file-text/'] as const

/**
 * 取实例文档路径（保留原 URL 的百分号编码，直接拼到 `/api/file-text/` 后面即可）。
 * 非本实例地址返回 null，由上层退化为普通网页抓取。
 */
export function extractSearxngDocumentPath(baseUrl: string, url: string): string | null {
  let target: URL
  let instance: URL
  try {
    target = new URL(url)
    instance = new URL(baseUrl)
  } catch {
    return null
  }
  if (target.host !== instance.host) return null

  for (const prefix of INSTANCE_DOCUMENT_PATH_PREFIXES) {
    const index = target.pathname.indexOf(prefix)
    if (index === -1) continue
    const path = target.pathname.slice(index + prefix.length)
    if (path) return path
  }
  return null
}

const HTML_BLOCK_WITH_CONTENT = /<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1>/gi
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const HTML_BLOCK_BOUNDARY = /<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

export function looksLikeHtml(value: string) {
  return /<!doctype\s+html|<html[\s>]|<body[\s>]|<meta[\s>]|<div[\s>]|<p[\s>]/i.test(value)
}

export function extractHtmlTitle(html: string): string | null {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]
  if (!title) return null
  return toNonEmptyString(decodeHtmlEntities(title.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' '))
}

/**
 * 极简正文抽取：优先 `<article>` / `<main>`，否则取 `<body>`。
 * 只做去脚本/样式、按块级标签断行、压缩空白，不做 Readability 级别的正文识别 ——
 * 自建文件搜索实例走 `/api/file-text`，这里只兜底普通网页。
 */
export function extractReadableText(html: string) {
  const container =
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ??
    html

  const text = decodeHtmlEntities(
    container
      .replace(HTML_BLOCK_WITH_CONTENT, ' ')
      .replace(HTML_COMMENT, ' ')
      .replace(HTML_BLOCK_BOUNDARY, '\n')
      .replace(/<[^>]*>/g, ' ')
  )

  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .trim()
}

export class SearxngSearch extends WebSearch {
  private readonly baseUrl: string

  /**
   * 阅读网页：本实例的文档走 `/api/file-text/<相对路径>` 取全文，普通网址退化为抓取正文。
   */
  override supportsParseLink = true

  /**
   * 兼容实例默认返回全部命中段落（不截断），这些段落就是模型要用的证据本身，
   * 不再用摘要预算把它压成 150 字符的提示。
   */
  override contextSnippetMaxLength = null

  constructor(baseUrl: string) {
    super()
    this.baseUrl = normalizeSearxngBaseUrl(baseUrl)
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult> {
    try {
      const response = await this.fetch(`${this.baseUrl}/search`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        query: {
          q: query,
          format: 'json',
        },
        responseType: 'json',
        signal,
      })

      if (!isSearxngResponse(response)) {
        throw new Error('SearXNG returned an invalid JSON search response')
      }

      const results = response.results
      const items = results
        .filter(isSearxngResult)
        .map((result) => {
          const title = toNonEmptyString(result.title)
          const link = toNonEmptyString(result.url)
          if (!title || !link) return null
          const item: SearchResultItem = {
            title,
            link,
            snippet: toNonEmptyString(result.content) ?? toNonEmptyString(result.snippet) ?? '',
          }
          // 协议携带的附加字段原样透传（缺失则不写入，保持其它提供方的结果形状不变）
          const fileType = toNonEmptyString(result.file_type)
          if (fileType) item.fileType = fileType
          const fileSize = toFiniteNumber(result.file_size)
          if (fileSize !== null) item.fileSize = fileSize
          const fileId = toNonEmptyString(result.file_id)
          if (fileId) item.fileId = fileId
          const snippetCount = toFiniteNumber(result.snippet_count)
          if (snippetCount !== null) item.snippetCount = snippetCount
          return item
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)

      return { items }
    } catch (error) {
      console.error('SearXNG search error:', error)
      throw error
    }
  }

  async parseLink(url: string, signal?: AbortSignal): Promise<ParseLinkResult | null> {
    const documentPath = extractSearxngDocumentPath(this.baseUrl, url)
    if (documentPath) {
      return await this.parseInstanceDocument(url, documentPath, signal)
    }
    return await this.parseWebPage(url, signal)
  }

  /** 实例文档：`/api/file-text/<路径>` 返回 {file_id, filename, paragraphs}。 */
  private async parseInstanceDocument(
    url: string,
    documentPath: string,
    signal?: AbortSignal
  ): Promise<ParseLinkResult | null> {
    let response: unknown
    try {
      response = await this.fetch(`${this.baseUrl}/api/file-text/${documentPath}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        responseType: 'json',
        signal,
      })
    } catch (error) {
      console.error('SearXNG parseLink error:', error)
      return null
    }

    if (typeof response !== 'object' || response === null) return null
    const fileText = response as SearxngFileText
    const paragraphs = Array.isArray(fileText.paragraphs)
      ? fileText.paragraphs.map(toNonEmptyString).filter((paragraph): paragraph is string => paragraph !== null)
      : []
    const content = paragraphs.join('\n\n')
    if (!content) return null

    const fileName = toNonEmptyString(decodeURIComponentSafe(documentPath.split('/').pop() ?? ''))
    return { url, title: toNonEmptyString(fileText.filename) ?? fileName ?? url, content }
  }

  /** 普通网页：抓取 HTML 并抽取可读正文。二进制/非 HTML 返回 null。 */
  private async parseWebPage(url: string, signal?: AbortSignal): Promise<ParseLinkResult | null> {
    let body: unknown
    try {
      body = await this.fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
        responseType: 'text',
        signal,
      })
    } catch (error) {
      console.error('SearXNG parseLink error:', error)
      return null
    }

    if (typeof body !== 'string' || !body.trim() || !looksLikeHtml(body)) return null

    const content = extractReadableText(body)
    if (!content) return null

    return { url, title: extractHtmlTitle(body) ?? hostnameOf(url) ?? url, content }
  }
}

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

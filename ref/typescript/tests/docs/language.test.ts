import type { Mock } from 'vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { applyLanguagePreference } from '../../docs/.vitepress/language.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function browser(
  pathname: string,
  languages: readonly string[],
  saved: string | null = null
): { replace: Mock; getItem: Mock<() => string | null>; setItem: Mock } {
  const replace = vi.fn()
  const getItem = vi.fn(() => saved)
  const setItem = vi.fn()
  vi.stubGlobal('location', {
    pathname,
    search: '?source=docs',
    hash: '#start',
    replace
  })
  vi.stubGlobal('localStorage', { getItem, setItem })
  vi.stubGlobal('navigator', { languages, language: 'en-US' })
  return { replace, getItem, setItem }
}

it.each([
  { languages: ['zh-CN', 'en-US'], destination: 'zh-CN' },
  { languages: ['en-US', 'zh-cn'], destination: 'zh-CN' },
  { languages: ['zh-TW', 'zh', 'en'], destination: 'en' },
  { languages: ['zh-HK', 'zh-Hans', 'fr'], destination: 'en' },
  { languages: ['de-DE'], destination: 'en' },
  { languages: [], destination: 'en' }
])(
  'routes the entry for $languages to $destination',
  ({ languages, destination }) => {
    const { replace } = browser('/', languages)
    applyLanguagePreference('/')
    expect(replace).toHaveBeenCalledExactlyOnceWith(
      `/${destination}/?source=docs#start`
    )
  }
)

it.each([
  { saved: 'en', languages: ['zh-CN'], destination: 'en' },
  { saved: 'zh-CN', languages: ['en-US'], destination: 'zh-CN' },
  { saved: 'invalid', languages: ['zh-CN'], destination: 'zh-CN' }
])(
  'respects a supported stored choice: $saved',
  ({ saved, languages, destination }) => {
    const { replace } = browser('/index.html', languages, saved)
    applyLanguagePreference('/')
    expect(replace).toHaveBeenCalledExactlyOnceWith(
      `/${destination}/?source=docs#start`
    )
  }
)

it.each([
  {
    pathname: '/en/configuration.html',
    locale: 'en',
    languages: ['zh-CN']
  },
  {
    pathname: '/zh-CN/channels/qq.html',
    locale: 'zh-CN',
    languages: ['en']
  }
])(
  'keeps the explicitly selected page $pathname',
  ({ pathname, locale, languages }) => {
    const { replace, setItem } = browser(pathname, languages)
    applyLanguagePreference('/')
    expect(replace).not.toHaveBeenCalled()
    expect(setItem).toHaveBeenCalledExactlyOnceWith(
      'relanox-docs-language:/',
      locale
    )
  }
)

it('continues language detection when storage is unavailable', () => {
  const { getItem, replace } = browser('/', ['zh-CN'])
  getItem.mockImplementation(() => {
    throw new Error('Storage disabled')
  })
  applyLanguagePreference('/')
  expect(replace).toHaveBeenCalledExactlyOnceWith('/zh-CN/?source=docs#start')
})

it('keeps explicit navigation usable when persisting the choice fails', () => {
  const { setItem, replace } = browser('/en/', ['zh-CN'])
  setItem.mockImplementation(() => {
    throw new Error('Storage disabled')
  })
  expect(() => {
    applyLanguagePreference('/')
  }).not.toThrow()
  expect(replace).not.toHaveBeenCalled()
})

it.each(['/elsewhere/', '/not-found.html'])(
  'does not redirect unrelated %s',
  (path) => {
    const { replace, setItem } = browser(path, ['zh-CN'])
    applyLanguagePreference('/')
    expect(replace).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  }
)

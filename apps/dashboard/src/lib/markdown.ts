import { createElement, Fragment, type ReactElement } from 'react'
import Markdown, { type Components } from 'react-markdown'

export const allowedProtocols = ['http:', 'https:', 'mailto:']

export const safeUrl = (url: string) => {
  try {
    return allowedProtocols.includes(new URL(url).protocol) ? url : ''
  } catch {
    return ''
  }
}

const anchor: Components['a'] = ({ href, children }) =>
  href
    ? createElement(
        Fragment,
        null,
        createElement(
          'a',
          {
            href,
            target: '_blank',
            rel: 'noreferrer noopener nofollow',
            className: 'underline underline-offset-2',
          },
          children,
        ),
        children === href
          ? null
          : createElement(
              'span',
              {
                className: 'text-muted-foreground',
              },
              ` (${href})`,
            ),
      )
    : createElement(Fragment, null, children)

const image: Components['img'] = ({ src, alt }) => {
  const target = typeof src === 'string' ? safeUrl(src) : ''

  return target
    ? createElement(
        'a',
        {
          href: target,
          target: '_blank',
          rel: 'noreferrer noopener nofollow',
          className: 'underline underline-offset-2',
        },
        alt || target,
      )
    : createElement(Fragment, null, alt ?? '')
}

export const renderMarkdown = (text: string): ReactElement =>
  createElement(
    Markdown,
    {
      skipHtml: true,
      urlTransform: safeUrl,
      components: {
        a: anchor,
        img: image,
      },
    },
    text,
  )

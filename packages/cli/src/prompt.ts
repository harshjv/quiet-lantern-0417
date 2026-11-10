import { createInterface } from 'node:readline/promises'
import { text } from 'node:stream/consumers'
import { isatty } from 'node:tty'

import { Exit, inputRequired } from './errors.ts'

export const interactive = () => isatty(0) && isatty(2)

const askVisible = async (question: string) => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

const askHidden = (question: string) =>
  new Promise<string>((resolve, reject) => {
    const stdin = process.stdin
    process.stderr.write(question)
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    let value = ''
    const finish = (error?: Exit) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish()
        if (char === '\u0003') return finish(new Exit(130))
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on('data', onData)
  })

export type Need = { what: string; flag: string; secret?: boolean }

export const need = async (value: string | undefined, spec: Need): Promise<string> => {
  if (value !== undefined && value !== '') return value
  if (!interactive()) throw inputRequired(spec.what, spec.flag)
  const answer = spec.secret
    ? await askHidden(`${spec.what}: `)
    : await askVisible(`${spec.what}: `)
  if (!answer) throw inputRequired(spec.what, spec.flag)
  return answer
}

export const readStdin = async () => (await text(process.stdin)).trim()

export const ask = async (question: string, fallback = '') =>
  (await askVisible(fallback ? `${question} [${fallback}]: ` : `${question}: `)) || fallback

export const askSecret = (question: string) => askHidden(`${question}: `)

export const confirm = async (question: string, yes = true) => {
  const answer = (await askVisible(`${question} ${yes ? '[Y/n]' : '[y/N]'}: `)).toLowerCase()
  return answer ? answer.startsWith('y') : yes
}

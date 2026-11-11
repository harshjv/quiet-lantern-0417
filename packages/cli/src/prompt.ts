import { text as readText } from 'node:stream/consumers'
import { isatty } from 'node:tty'

import {
  confirm as askConfirm,
  isCancel,
  password,
  select,
  text,
  type Option,
} from '@clack/prompts'

import { Exit, inputRequired } from './errors.ts'

export const interactive = () => isatty(0) && isatty(2)

const output = process.stderr

const answered = <T>(answer: T): Exclude<T, symbol> => {
  if (isCancel(answer)) {
    throw new Exit(130)
  }

  return answer as Exclude<T, symbol>
}

export type Ask = { fallback?: string; valid?: (value: string) => string | null }

export const ask = async (question: string, { fallback = '', valid }: Ask = {}) =>
  answered(
    await text({
      message: question,
      placeholder: fallback,
      defaultValue: fallback,
      validate: (value) => valid?.(value?.trim() || fallback) ?? undefined,
      output,
    }),
  ).trim()

export const askSecret = async (question: string, valid?: (value: string) => string | null) =>
  answered(
    await password({
      message: question,
      validate: (value) => valid?.(value ?? '') ?? undefined,
      output,
    }),
  )

export const confirm = async (question: string, yes = true) =>
  answered(
    await askConfirm({
      message: question,
      initialValue: yes,
      output,
    }),
  )

export const choose = async <T extends string>(
  question: string,
  choices: Option<T>[],
  initial: T,
) =>
  answered(
    await select({
      message: question,
      options: choices,
      initialValue: initial,
      output,
    }),
  ) as T

export type Need = { what: string; flag: string; secret?: boolean }

export const need = async (value: string | undefined, spec: Need): Promise<string> => {
  if (value !== undefined && value !== '') {
    return value
  }

  if (!interactive()) {
    throw inputRequired(spec.what, spec.flag)
  }

  const answer = spec.secret ? await askSecret(spec.what) : await ask(spec.what)

  if (!answer) {
    throw inputRequired(spec.what, spec.flag)
  }

  return answer
}

export const readStdin = async () => (await readText(process.stdin)).trim()

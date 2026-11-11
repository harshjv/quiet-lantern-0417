const errorPattern = /\b(error|fatal|panic|exception|traceback)\b|npm ERR!/i

export type LogSelector =
  { deployment: string } | { build: string } | { sandbox: string; role: 'init' | 'runtime' }

export const logTail = 500

export const logFollowUrl = (selector: LogSelector) =>
  `/v1/logs?${new URLSearchParams({
    ...selector,
    tail: String(logTail),
    follow: 'true',
  })}`

export const isErrorLine = (text: string) => errorPattern.test(text)

export const firstErrorIndex = (lines: readonly { text: string }[]) =>
  lines.findIndex((line) => isErrorLine(line.text))

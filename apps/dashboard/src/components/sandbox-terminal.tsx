import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'

import '@xterm/xterm/css/xterm.css'

import { Copy, Loader2, Moon, RotateCw, TerminalSquare } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useRef, useState } from 'react'

import { ErrorState } from '@/components/page'
import { StartSandbox } from '@/components/sandbox-actions'
import { TimeLeft } from '@/components/sandbox-clock'
import { Button } from '@/components/ui/button'
import { api, ApiFailure, failureText, idempotency, unwrap, type Sandbox } from '@/lib/api'
import { attachUrl, outputFrame, stdinFrame } from '@/lib/sandbox'
import { isIdle, isTransient } from '@/lib/status'
import { cn } from '@/lib/utils'

type Phase = 'connecting' | 'live' | 'ended' | 'error'

type Control =
  | { type: 'attached' }
  | { type: 'exit'; status: string; exit_code: number | null; reason: string }
  | { type: 'error'; code: string; explanation: string }

const themes = {
  light: {
    background: '#fafafa',
    foreground: '#18181b',
    cursor: '#18181b',
    cursorAccent: '#fafafa',
    selectionBackground: '#bfdbfe',
  },
  dark: {
    background: '#09090b',
    foreground: '#e4e4e7',
    cursor: '#e4e4e7',
    cursorAccent: '#09090b',
    selectionBackground: '#1e3a8a',
  },
}

const dim = (text: string) => `\r\n\x1b[2m${text}\x1b[0m\r\n`

function ShellSession({ sandbox }: { sandbox: Pick<Sandbox, 'id' | 'name'> }) {
  const { resolvedTheme } = useTheme()
  const container = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const [phase, setPhase] = useState<Phase>('connecting')
  const [detail, setDetail] = useState('')
  const [failure, setFailure] = useState<unknown>(null)
  const [epoch, setEpoch] = useState(0)
  const [copied, setCopied] = useState(false)
  const palette = resolvedTheme === 'dark' ? themes.dark : themes.light

  useEffect(() => {
    const node = container.current
    if (!node) return
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(node)
    fit.fit()
    termRef.current = term
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'c' &&
        term.hasSelection()
      ) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      return true
    })
    const input = term.onData((data) => {
      const socket = socketRef.current
      if (socket?.readyState === WebSocket.OPEN) socket.send(stdinFrame(data))
    })
    const resized = term.onResize(({ rows, cols }) => {
      const socket = socketRef.current
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: 'resize',
            rows,
            cols,
          }),
        )
    })
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        if (node.clientWidth > 0 && node.clientHeight > 0) fit.fit()
      })
    })
    observer.observe(node)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      input.dispose()
      resized.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = palette
  }, [palette])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    let cancelled = false
    let finished = false
    let socket: WebSocket | null = null
    const finish = (next: Phase, text: string) => {
      if (finished) return
      finished = true
      setPhase(next)
      setDetail(text)
      term.write(dim(text))
    }
    const open = async () => {
      setPhase('connecting')
      setDetail('')
      setFailure(null)
      try {
        const shell = await unwrap(
          api.v1
            .sandboxes({
              sandbox: sandbox.id,
            })
            .shells.post({}, idempotency()),
        )
        if (cancelled) return
        socket = new WebSocket(
          attachUrl(shell.attach_url, window.location.origin, {
            rows: term.rows,
            cols: term.cols,
          }),
        )
        socket.binaryType = 'arraybuffer'
        socketRef.current = socket
        socket.onmessage = (message) => {
          if (typeof message.data === 'string') {
            const control = JSON.parse(message.data) as Control
            if (control.type === 'attached') {
              setPhase('live')
              term.focus()
            } else if (control.type === 'exit') {
              finish(
                'ended',
                control.exit_code === null
                  ? `Session ended (${control.reason.replaceAll('_', ' ')}).`
                  : `Session ended with exit code ${control.exit_code}.`,
              )
            } else if (control.type === 'error') {
              setFailure(
                new ApiFailure(503, {
                  code: control.code,
                  explanation: control.explanation,
                  fix: 'Reconnect to open a new shell.',
                }),
              )
              finish('error', `The terminal could not attach: ${control.code}.`)
            }
            return
          }
          term.write(outputFrame(message.data as ArrayBuffer).bytes)
        }
        socket.onclose = () => finish('ended', 'Connection closed.')
      } catch (error) {
        if (cancelled) return
        setFailure(error)
        finish('error', failureText(error))
      }
    }
    const timer = window.setTimeout(() => void open(), 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (socket) {
        socket.onclose = null
        socket.close()
      }
      socketRef.current = null
    }
  }, [sandbox.id, epoch])

  const reconnect = () => {
    termRef.current?.write(dim('Starting a new shell'))
    setEpoch((e) => e + 1)
  }

  const copy = () => {
    const term = termRef.current
    if (!term?.hasSelection()) return
    void navigator.clipboard.writeText(term.getSelection()).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">Terminal</span>
        <span
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          role="status"
          data-testid="terminal-state"
          data-phase={phase}
        >
          {phase === 'connecting' && (
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
          )}
          {phase === 'live' && (
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
          )}
          {phase === 'connecting' ? 'connecting' : phase === 'live' ? 'connected' : detail}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={copy}>
            <Copy /> {copied ? 'Copied' : 'Copy selection'}
          </Button>
          {(phase === 'ended' || phase === 'error') && (
            <Button type="button" size="sm" onClick={reconnect}>
              <RotateCw /> Reconnect
            </Button>
          )}
        </div>
      </div>
      {phase === 'error' && failure !== null && (
        <div className="p-3">
          <ErrorState error={failure} title="The terminal is unavailable" />
        </div>
      )}
      <div
        ref={container}
        data-testid="terminal"
        className={cn('h-[26rem] p-2 sm:h-[32rem]')}
        style={{
          backgroundColor: palette.background,
        }}
      />
    </div>
  )
}

export function SandboxTerminal({
  sandbox,
}: {
  sandbox: Pick<Sandbox, 'id' | 'name' | 'status' | 'stop_at' | 'delete_at' | 'environment_id'> & {
    failure?: Sandbox['failure']
  }
}) {
  if (sandbox.status === 'running') return <ShellSession sandbox={sandbox} />
  const busy = isTransient(sandbox.status)
  const idle = isIdle(sandbox.status)
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center"
      data-testid="terminal-stopped"
    >
      {busy ? (
        <Loader2
          className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
          aria-hidden
        />
      ) : sandbox.status === 'stopped' ? (
        <Moon className="size-5 text-muted-foreground" aria-hidden />
      ) : (
        <TerminalSquare className="size-5 text-muted-foreground" aria-hidden />
      )}
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {busy
            ? `Sandbox is ${sandbox.status}`
            : sandbox.status === 'stopped'
              ? 'Sandbox stopped'
              : 'Sandbox failed'}
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          {sandbox.status === 'failed' && sandbox.failure?.summary
            ? sandbox.failure.summary
            : idle
              ? 'The terminal opens when the sandbox runs. Its disk is kept; the sandbox is deleted if it stays stopped, in '
              : 'The terminal opens as soon as the sandbox is running.'}
          {idle && sandbox.status === 'stopped' && (
            <TimeLeft sandbox={sandbox} className="font-medium text-foreground" />
          )}
          {idle && sandbox.status === 'stopped' && '.'}
        </p>
      </div>
      {idle && <StartSandbox sandbox={sandbox} />}
    </div>
  )
}

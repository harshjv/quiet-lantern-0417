export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

export const toneText: Record<Tone, string> = {
  success: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-amber-700 dark:text-amber-400',
  danger: 'text-red-700 dark:text-red-400',
  info: 'text-sky-700 dark:text-sky-400',
  neutral: 'text-muted-foreground'
}

export const toneBadge: Record<Tone, string> = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  warning: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  danger: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200',
  info: 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200',
  neutral: 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400'
}

export const toneOutline: Record<Tone, string> = {
  success: 'border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300',
  warning: 'border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300',
  danger: 'border-red-300 text-red-800 dark:border-red-800 dark:text-red-300',
  info: 'border-sky-300 text-sky-800 dark:border-sky-800 dark:text-sky-300',
  neutral: 'border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300'
}

export const tonePanel: Record<Tone, string> = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100',
  warning: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100',
  danger: 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100',
  info: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-100',
  neutral: 'border-zinc-300 bg-zinc-50 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100'
}

export const toneDot: Record<Tone, string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-sky-500',
  neutral: 'bg-zinc-400 dark:bg-zinc-500'
}

export const warningAlert = 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-50'

export const countPill = 'inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[0.6875rem] font-semibold text-amber-950'

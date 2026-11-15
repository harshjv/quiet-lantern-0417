export const typeScale = [
  ['text-2xl', '24 px', 'Page greeting, composer heading'],
  ['text-xl', '20 px', 'Page title'],
  ['text-lg', '18 px', 'Task title'],
  ['text-base', '16 px', 'Rare: long reading text'],
  ['text-sm', '14 px', 'Default for everything'],
  ['text-xs', '12 px', 'Second lines, meta, code, badges'],
] as const

export const spaceScale = [
  ['0', '0 px', 'flush, such as a toggle group with no gaps', 'w-0'],
  ['0.5', '2 px', 'between pixel bars', 'w-0.5'],
  ['1', '4 px', 'icon to label', 'w-1'],
  ['1.5', '6 px', 'pill dot gap', 'w-1.5'],
  ['2', '8 px', 'inline groups', 'w-2'],
  ['3', '12 px', 'row padding, small stacks', 'w-3'],
  ['4', '16 px', 'card padding, page gutter on phones', 'w-4'],
  ['6', '24 px', 'page padding', 'w-6'],
  ['8', '32 px', 'between sections', 'w-8'],
] as const

export const separators = ['·', '•', '—', '|']

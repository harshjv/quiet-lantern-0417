import { persistedFlag } from './persisted-flag.ts'

const collapsed = persistedFlag('stationly.sidebar.collapsed')

export const setSidebarCollapsed = collapsed.set

export const useSidebarCollapsed = collapsed.use

import {
  Blocks,
  Bot,
  Box,
  Braces,
  FolderGit2,
  Globe,
  Inbox,
  Layers,
  MessagesSquare,
  Rocket,
  Server,
  type LucideIcon,
} from 'lucide-react'

export const entityIcon = {
  project: FolderGit2,
  task: Blocks,
  preview: Layers,
  app: Box,
  deployment: Rocket,
  domain: Globe,
  agent: Bot,
  conversation: MessagesSquare,
  server: Server,
  environment_variable: Braces,
  approval: Inbox,
} satisfies Record<string, LucideIcon>

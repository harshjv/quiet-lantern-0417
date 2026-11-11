import {
  Bot,
  Box,
  Braces,
  Camera,
  Container,
  FolderGit2,
  Globe,
  Inbox,
  Layers,
  Rocket,
  Server,
  type LucideIcon,
} from 'lucide-react'

export const entityIcon = {
  project: FolderGit2,
  environment: Layers,
  service: Box,
  deployment: Rocket,
  sandbox: Container,
  snapshot: Camera,
  domain: Globe,
  agent: Bot,
  station: Server,
  variable: Braces,
  stagedChange: Inbox,
} satisfies Record<string, LucideIcon>

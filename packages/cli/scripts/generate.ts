import { writeFileSync } from 'node:fs'

import { helpTree, helpTreePath } from '../src/help-tree.ts'

writeFileSync(helpTreePath, helpTree())

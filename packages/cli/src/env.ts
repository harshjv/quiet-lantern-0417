import { homedir } from 'node:os'
import { join } from 'node:path'

import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { workspaceEnv } from '@stationly/protocol'

import packageJson from '../package.json' with { type: 'json' }

export const tokenEnv = workspaceEnv.token
export const apiUrlEnv = workspaceEnv.apiUrl
export const projectEnv = workspaceEnv.project
export const environmentEnv = workspaceEnv.environment
export const sandboxIdEnv = 'STATIONLY_SANDBOX_ID'

const optional = z.string().optional()
const blankAsUnset = optional.transform((v) => v || undefined)

export const env = createEnv({
  server: {
    STATIONLY_BUILD_VERSION: z.string().default(packageJson.version),
    [tokenEnv]: blankAsUnset,
    [apiUrlEnv]: blankAsUnset,
    [projectEnv]: blankAsUnset,
    [environmentEnv]: blankAsUnset,
    [sandboxIdEnv]: blankAsUnset,
    APPDATA: z.string().default(join(homedir(), 'AppData', 'Roaming')),
    XDG_CONFIG_HOME: optional.transform((v) => v || join(homedir(), '.config')),
    LITESTREAM_SECRET_ACCESS_KEY: optional,
  },
  runtimeEnvStrict: {
    STATIONLY_BUILD_VERSION: process.env.STATIONLY_BUILD_VERSION,
    [tokenEnv]: process.env[tokenEnv],
    [apiUrlEnv]: process.env[apiUrlEnv],
    [projectEnv]: process.env[projectEnv],
    [environmentEnv]: process.env[environmentEnv],
    [sandboxIdEnv]: process.env[sandboxIdEnv],
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    LITESTREAM_SECRET_ACCESS_KEY: process.env.LITESTREAM_SECRET_ACCESS_KEY,
  },
})

export const version = env.STATIONLY_BUILD_VERSION

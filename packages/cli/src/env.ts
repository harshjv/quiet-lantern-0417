import { homedir } from 'node:os'
import { join } from 'node:path'

import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import packageJson from '../package.json' with { type: 'json' }

export const tokenEnv = 'STATIONLY_TOKEN'
export const apiUrlEnv = 'STATIONLY_API_URL'

const optional = z.string().optional()
const blankAsUnset = optional.transform((v) => v || undefined)

export const env = createEnv({
  server: {
    STATIONLY_BUILD_VERSION: z.string().default(packageJson.version),
    [tokenEnv]: blankAsUnset,
    [apiUrlEnv]: blankAsUnset,
    APPDATA: z.string().default(join(homedir(), 'AppData', 'Roaming')),
    XDG_CONFIG_HOME: optional.transform((v) => v || join(homedir(), '.config')),
    LITESTREAM_SECRET_ACCESS_KEY: optional,
  },
  runtimeEnvStrict: {
    STATIONLY_BUILD_VERSION: process.env.STATIONLY_BUILD_VERSION,
    [tokenEnv]: process.env[tokenEnv],
    [apiUrlEnv]: process.env[apiUrlEnv],
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    LITESTREAM_SECRET_ACCESS_KEY: process.env.LITESTREAM_SECRET_ACCESS_KEY,
  },
})

export const version = env.STATIONLY_BUILD_VERSION

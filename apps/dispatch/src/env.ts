import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

import { networkLayout } from '@stationly/protocol'
import { releaseConfig, releaseRepositories } from '@stationly/protocol/release-config'

import packageJson from '../package.json' with { type: 'json' }

const optional = z.string().optional()
const blankAs = <T>(fallback: T) => optional.transform((v) => v || fallback)
const withoutTrailingSlashes = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) => v.replace(/\/+$/, ''))

export const env = () =>
  createEnv({
    runtimeEnv: process.env,
    server: {
      STATIONLY_PORT: z.string().default(String(networkLayout.dispatchPort)).transform(Number),
      STATIONLY_DATABASE: optional,
      STATIONLY_DISPATCH_VERSION: blankAs(packageJson.version),
      STATIONLY_DISPATCH_DIGEST: optional,
      STATIONLY_MASTER_KEY: optional,
      STATIONLY_LITESTREAM: optional.transform((v) => v === '1'),
      STATIONLY_RESOLVER: blankAs(null),
      STATIONLY_BOOTSTRAP_ENROLL_SHA256: optional,
      STATIONLY_GITHUB_URL: withoutTrailingSlashes('https://github.com'),
      STATIONLY_GITHUB_API_URL: withoutTrailingSlashes('https://api.github.com'),
      STATIONLY_GITHUB_SWEEP_MS: z.string().default('600000').transform(Number),
      STATIONLY_SIGSTORE_TUF_MIRROR: z
        .string()
        .default(releaseConfig.tuf_mirror)
        .transform((v) => v.replace(/\/$/, '')),
      STATIONLY_SIGNATURES_REPOSITORY: z.string().default(releaseRepositories.signatures),
      STATIONLY_RELEASES_REPOSITORY: z.string().default(releaseRepositories.release),
      STATIONLY_INSECURE_REGISTRIES: z
        .string()
        .default('')
        .transform(
          (v) =>
            new Set(
              v
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            ),
        ),
    },
  })

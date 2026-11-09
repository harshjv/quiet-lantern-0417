import packageJson from '../package.json' with { type: 'json' }

export const version = process.env.STATIONLY_BUILD_VERSION ?? packageJson.version

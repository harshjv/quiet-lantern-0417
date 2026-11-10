import { variableKeyPattern } from '@stationly/protocol'
import { isIPv4, isIPv6 } from 'node:net'

export type S3Target = { type: 's3'; endpoint: string; bucket: string; prefix: string; credentials_variable: string }

const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const prefixPattern = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/
const variablePattern = new RegExp(variableKeyPattern)

const privateIPv4 = (host: string) => {
  const [a, b] = host.split('.').map(Number) as [number, number]
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

const privateIPv6 = (host: string) => host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host)

export const endpointIssue = (endpoint: string): string | null => {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return `endpoint ${endpoint} is not a URL`
  }
  const origin = url.username === '' && url.password === '' && (url.pathname === '' || url.pathname === '/') && url.search === '' && url.hash === ''
  if (!origin || !url.host || !/^https?:$/.test(url.protocol)) return `endpoint ${endpoint} is not an origin URL`
  if (url.protocol === 'https:') return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if ((isIPv4(host) && privateIPv4(host)) || (isIPv6(host) && privateIPv6(host))) return null
  return `endpoint ${endpoint} is not an https URL, nor an http URL on a private or loopback address`
}

export const s3TargetIssues = (target: S3Target): string[] => {
  const issues: string[] = []
  const endpoint = endpointIssue(target.endpoint)
  if (endpoint) issues.push(endpoint)
  if (!bucketPattern.test(target.bucket)) issues.push(`bucket ${target.bucket} is not a bucket name`)
  if (target.prefix !== '' && (!prefixPattern.test(target.prefix) || target.prefix.split('/').some(part => part === '.' || part === '..'))) {
    issues.push(`prefix ${target.prefix} must be empty or slash-separated names of letters, digits, '.', '_' and '-'`)
  }
  if (!variablePattern.test(target.credentials_variable)) issues.push(`credentials_variable ${target.credentials_variable} must match [A-Z_][A-Z0-9_]*`)
  return issues
}

export const s3Location = (target: S3Target, name: string) => `s3://${target.bucket}/${target.prefix === '' ? '' : `${target.prefix}/`}${name}`

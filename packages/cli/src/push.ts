import { readFile, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import dockerignore from '@balena/dockerignore'
import { create } from 'tar'
import { usage } from './errors.ts'

export const maxPushBytes = 512 * 1024 * 1024

const dockerignoreOf = async (dir: string) => {
  try {
    return (await readFile(resolve(dir, '.dockerignore'), 'utf8')).split(/\r?\n/)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export const packDirectory = async (path: string) => {
  const dir = resolve(path)
  const info = await stat(dir).catch(() => null)
  if (!info?.isDirectory()) throw usage(`${path} is not a directory.`, 'Pass the directory to push, or run sly push inside it.')
  const rules = dockerignore.default().add(await dockerignoreOf(dir))
  let files = 0
  const chunks: Buffer[] = []
  let size = 0
  const stream = create(
    {
      gzip: true,
      cwd: dir,
      portable: true,
      filter: (entry: string) => {
        const rel = relative(dir, resolve(dir, entry)).split(sep).join('/')
        if (rel === '' || rel === '.') return true
        if (rel === '.git' || rel.startsWith('.git/') || rules.ignores(rel)) return false
        files += 1
        return true
      }
    },
    ['.']
  )
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxPushBytes) throw usage(`The directory packs to more than ${maxPushBytes} bytes.`, 'Add large build inputs to .dockerignore.')
    chunks.push(chunk)
  }
  return { bytes: Buffer.concat(chunks), entries: files, dir }
}

export type PushApi = { raw: (path: string, init?: RequestInit) => Promise<Response> }

export const uploadSource = async (api: PushApi, serviceId: string, path: string, onProgress: (message: string) => void = () => {}) => {
  const started = Date.now()
  const packed = await packDirectory(path)
  onProgress(`packed ${packed.entries} entries of ${packed.dir} into ${packed.bytes.length} bytes in ${Date.now() - started} ms`)
  const upload = await api.raw('/v1/blobs', {
    method: 'POST',
    headers: { 'content-type': 'application/gzip', 'content-length': String(packed.bytes.length), 'x-stationly-service': serviceId },
    body: packed.bytes
  })
  const blob = (await upload.json()) as { blob_id: string; size_bytes: number }
  if (upload.ok) onProgress(`uploaded ${blob.size_bytes} bytes as ${blob.blob_id} in ${Date.now() - started} ms`)
  return { status: upload.status, body: blob as unknown, blob: upload.ok ? blob : null }
}

export const uploadAndDeploy = async (api: PushApi, serviceId: string, path: string, onProgress: (message: string) => void = () => {}) => {
  const uploaded = await uploadSource(api, serviceId, path, onProgress)
  if (!uploaded.blob) return { status: uploaded.status, body: uploaded.body }
  const deploy = await api.raw(`/v1/services/${serviceId}/deployments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob_id: uploaded.blob.blob_id }) })
  return { status: deploy.status, body: (await deploy.json()) as unknown }
}

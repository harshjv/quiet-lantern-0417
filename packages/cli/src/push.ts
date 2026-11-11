import { readFile, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import dockerignore from '@balena/dockerignore'
import { create } from 'tar'

import { usage } from './errors.ts'
import { send, type Run } from './kit.ts'

export const maxPushBytes = 512 * 1024 * 1024

const dockerignoreOf = async (dir: string) => {
  try {
    return (await readFile(resolve(dir, '.dockerignore'), 'utf8')).split(/\r?\n/)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }
}

export const packDirectory = async (path: string) => {
  const dir = resolve(path)
  const info = await stat(dir).catch(() => null)

  if (!info?.isDirectory()) {
    throw usage(
      `${path} is not a directory.`,
      'Pass the directory to push, or run sly push inside it.',
    )
  }

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

        if (rel === '' || rel === '.') {
          return true
        }

        if (rel === '.git' || rel.startsWith('.git/') || rules.ignores(rel)) {
          return false
        }

        files += 1

        return true
      },
    },
    ['.'],
  )

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.length

    if (size > maxPushBytes) {
      throw usage(
        `The directory packs to more than ${maxPushBytes} bytes.`,
        'Add large build inputs to .dockerignore.',
      )
    }

    chunks.push(chunk)
  }

  return {
    bytes: Buffer.concat(chunks),
    entries: files,
    dir,
  }
}

export const uploadSource = async (
  run: Run,
  serviceId: string,
  path: string,
  onProgress: (message: string) => void = () => {},
) => {
  const started = Date.now()
  const packed = await packDirectory(path)

  onProgress(
    `packed ${packed.entries} entries of ${packed.dir} into ${packed.bytes.length} bytes in ${Date.now() - started} ms`,
  )
  const upload = await send(
    run.api.v1.blobs.post(undefined, {
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(packed.bytes.length),
        'x-stationly-service': serviceId,
      },
      fetch: {
        body: packed.bytes,
      },
    }),
  )

  onProgress(
    `uploaded ${upload.data.size_bytes} bytes as ${upload.data.blob_id} in ${Date.now() - started} ms`,
  )

  return upload
}

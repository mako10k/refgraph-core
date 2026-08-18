import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRepository } from '../src/index.js'

const parent = await mkdtemp(join(tmpdir(), 'refgraph-core-example-'))
const path = join(parent, 'repository')

try {
  const writer = await LocalRepository.create(path)
  const leaf = await writer.putRaw(new TextEncoder().encode('hello'))
  const root = await writer.putValue({ arbitraryField: leaf })
  await writer.addRoot(root)
  await writer.close()

  const reader = await LocalRepository.open(path, { mode: 'read-only' })
  console.log({
    roots: (await reader.roots()).map(String),
    reachable: (await reader.reachable()).map(String),
    incoming: (await reader.incoming(leaf)).map(({ cid }) => cid.toString()),
    openingErrors: reader.openingErrors.map(({ name, message }) => ({ name, message })),
    fsck: await reader.fsck(),
  })
  await reader.close()
} finally {
  await rm(parent, { recursive: true, force: true })
}

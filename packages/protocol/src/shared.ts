export const sharedTestdataDir = 'packages/protocol/testdata'

export type SharedComputation = {
  id: string
  vectors: string[]
  goTest: string
  tsTest: string
}

export const sharedComputations: SharedComputation[] = [
  {
    id: 'handshake-signature',
    vectors: ['handshake-vectors.ts.json', 'handshake-vectors.go.json'],
    goTest: 'go/internal/dispatch/handshake_test.go',
    tsTest: 'apps/dispatch/test/handshake-vectors.test.ts',
  },
  {
    id: 'redaction',
    vectors: ['redaction-vectors.json'],
    goTest: 'go/internal/secrets/vectors_test.go',
    tsTest: 'apps/dispatch/test/secrets-vectors.test.ts',
  },
  {
    id: 'env-digest',
    vectors: ['env-digest-vectors.json'],
    goTest: 'go/internal/secrets/vectors_test.go',
    tsTest: 'apps/dispatch/test/secrets-vectors.test.ts',
  },
  {
    id: 'generation-hash',
    vectors: ['generation-hash-vectors.json'],
    goTest: 'go/internal/deploy/vectors_test.go',
    tsTest: 'apps/dispatch/test/derivation-vectors.test.ts',
  },
  {
    id: 'network-layout',
    vectors: ['network-vectors.json'],
    goTest: 'go/internal/deploy/vectors_test.go',
    tsTest: 'apps/dispatch/test/derivation-vectors.test.ts',
  },
  {
    id: 'depot-names',
    vectors: ['depot-vectors.json'],
    goTest: 'go/internal/depot/vectors_test.go',
    tsTest: 'apps/dispatch/test/derivation-vectors.test.ts',
  },
]

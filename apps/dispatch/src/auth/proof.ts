import { createDpopReplayStore, isDpopProofError, verifyDpopProof } from 'better-auth/oauth2'
import type { DpopReplayReservations } from 'better-auth/oauth2'

export const proofHeader = 'dpop'
export const proofMaxAgeSeconds = 60
export const proofAlgorithms = ['EdDSA'] as const

export type ProofCheck = { proof: string | null; method: string; url: string; accessToken?: string; expectedJkt?: string }

export const verifyProof = async (reservations: DpopReplayReservations, check: ProofCheck) => {
  if (!check.proof) throw new ProofError('the request carries no DPoP proof header')
  try {
    return await verifyDpopProof({
      proofJwt: check.proof,
      method: check.method,
      url: check.url,
      accessToken: check.accessToken,
      expectedJkt: check.expectedJkt,
      requireAth: check.accessToken !== undefined,
      proofMaxAgeSeconds,
      signingAlgorithms: proofAlgorithms,
      replayStore: createDpopReplayStore(reservations)
    })
  } catch (error) {
    if (isDpopProofError(error)) throw new ProofError(error.message)
    throw error
  }
}

export class ProofError extends Error {}

const sentUrls = new WeakMap<Request, string>()

export const rememberSentUrl = (rewritten: Request, sent: string) => sentUrls.set(rewritten, sent)

export const publicUrl = (request: Request, canonicalOrigin: string | null) => {
  const url = new URL(sentUrls.get(request) ?? request.url)
  if (url.protocol === 'ws:') url.protocol = 'http:'
  if (url.protocol === 'wss:') url.protocol = 'https:'
  if (!canonicalOrigin) return url.href
  return `${canonicalOrigin}${url.pathname}${url.search}`
}

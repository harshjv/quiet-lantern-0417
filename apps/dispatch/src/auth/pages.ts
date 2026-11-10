import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import { and, asc, count, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'

import { tokenLevelValues } from '@stationly/protocol'

import { audit, requestIdOf, type Deps } from '../api/context.ts'
import { newId } from '../db/ids.ts'
import { environment, passkey, project, token, user } from '../db/schema.ts'

import { canonicalOrigin, type Auth } from './auth.ts'
import { levelOfScope, levelScopes, oauthRefreshSeconds, withPendingGrant } from './grants.ts'
import { surfaceOf, type Principal } from './principal.ts'
import { fullAdmin, type Level, type Scope } from './scopes.ts'

const escape = (value: string | null | undefined) =>
  (value ?? '').replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch]!,
  )

const pagePolicy =
  "default-src 'none'; style-src 'unsafe-inline'; img-src https:; frame-ancestors 'none'; base-uri 'none'"

const loginPolicy =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"

const securityHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=()',
}

const loginScripts = {
  '/auth/assets/webauthn.js': readFileSync(
    fileURLToPath(
      new URL('../dist/bundle/index.umd.min.js', import.meta.resolve('@simplewebauthn/browser')),
    ),
  ),
  '/auth/assets/login.js': readFileSync(fileURLToPath(new URL('./login.js', import.meta.url))),
}

const script = (body: Buffer) =>
  new Response(new Uint8Array(body), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    },
  })

const page = (
  title: string,
  body: string,
  status = 200,
  extra: Headers = new Headers(),
  policy = pagePolicy,
) => {
  const headers = new Headers({
    ...securityHeaders,
    'content-security-policy': policy,
  })
  for (const cookie of extra.getSetCookie()) headers.append('set-cookie', cookie)
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Stationly</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}label{display:block;margin:.75rem 0 .25rem}input[type=email],input[type=password],input[type=text]{width:100%;padding:.5rem;font:inherit;box-sizing:border-box}button{font:inherit;padding:.5rem 1rem;margin:1rem .5rem 0 0}.or{color:#555;margin:1.5rem 0 0}.error{color:#a00}.box{border:1px solid #ccc;padding:.75rem 1rem;border-radius:6px;margin:1rem 0}code{font-size:.95em}fieldset{border:1px solid #ccc;border-radius:6px;margin:1rem 0}</style></head><body><h1>${escape(title)}</h1>${body}</body></html>`,
    {
      status,
      headers,
    },
  )
}

const redirect = (location: string, extra: Headers = new Headers()) => {
  const headers = new Headers({
    location,
    'cache-control': 'no-store',
  })
  for (const cookie of extra.getSetCookie()) headers.append('set-cookie', cookie)
  return new Response(null, {
    status: 303,
    headers,
  })
}

const formOf = async (request: Request) => new URLSearchParams(await request.text())

const signedQueryParams = new Set(['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param'])

const authorizeQuery = (oauthQuery: string) => {
  const params = new URLSearchParams(oauthQuery)
  for (const key of [...params.keys()]) if (signedQueryParams.has(key)) params.delete(key)
  return params.toString()
}

type Area = 'api' | 'dashboard'

type PasskeyBody = NonNullable<Parameters<Auth['api']['verifyPasskeyAuthentication']>[0]>['body']

export const createAuthPages = (deps: Deps) => {
  const { db } = deps
  const auth = () => deps.auth.current

  const allowed = (request: Request, area: Area) => {
    const surface = surfaceOf(request, deps.auth)
    return surface === 'local' || surface === area
  }

  const originOf = (request: Request) =>
    canonicalOrigin(deps.auth.surface, request) ?? new URL(request.url).origin

  const sameOrigin = (request: Request) => request.headers.get('origin') === originOf(request)

  const wrongHost = (request: Request) =>
    page(
      'Wrong host',
      `<p>This host does not serve ${escape(new URL(request.url).pathname)}.</p>`,
      404,
    )

  const forbidden = () =>
    page(
      'Refused',
      '<p class="error">This form must be submitted from the page this server rendered (the Origin header did not match).</p>',
      403,
    )

  const apiHeaders = (request: Request) => {
    const headers = new Headers(request.headers)
    headers.delete('authorization')
    headers.delete('sec-fetch-mode')
    headers.delete('content-type')
    headers.delete('content-length')
    headers.set('accept', 'application/json')
    return headers
  }

  const sessionOf = (request: Request) =>
    auth().api.getSession({
      headers: apiHeaders(request),
    })

  const enrolled = (userId: string) => {
    const row = db
      .select({
        twoFactorEnabled: user.twoFactorEnabled,
      })
      .from(user)
      .where(eq(user.id, userId))
      .get()
    const passkeys =
      db
        .select({
          n: count(),
        })
        .from(passkey)
        .where(eq(passkey.userId, userId))
        .get()?.n ?? 0
    return Boolean(row?.twoFactorEnabled) || passkeys > 0
  }

  const enrollFirst = () =>
    page(
      'Enroll a second factor first',
      '<p class="error">Approving <code>sly login</code> or an OAuth client needs a passkey or TOTP on this account.</p><p>Enroll TOTP from the dashboard account page, or call <code>POST /auth/two-factor/enable</code> and verify the code, then try again.</p>',
      403,
    )

  const passkeysHere = (request: Request) =>
    deps.auth.surface.apiOrigin.startsWith('https://') &&
    canonicalOrigin(deps.auth.surface, request) === deps.auth.surface.apiOrigin

  const loginForm = (request: Request, oauthQuery: string, error: string | null, status = 200) => {
    const hidden = `<input type="hidden" name="oauth_query" value="${escape(oauthQuery)}">`
    const passkeyForm = `<form method="post" action="/auth/login">${hidden}<input type="hidden" name="passkey" value=""><button type="button" id="passkey-button" hidden>Sign in with a passkey</button></form><p id="passkey-error" class="error" role="alert" hidden></p><p class="or">Or sign in with your password and TOTP code.</p>`
    const passwordForm = `<form method="post" action="/auth/login">${hidden}<label for="email">Email</label><input id="email" type="email" name="email" autocomplete="username" required><label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required><label for="code">TOTP code</label><input id="code" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}"><button type="submit">Sign in</button></form>`
    const errorLine = error ? `<p class="error">${escape(error)}</p>` : ''
    if (!passkeysHere(request))
      return page(
        'Sign in',
        `${errorLine}${passwordForm}<p>Passkeys need the API hostname over HTTPS. On this address sign in with your password and TOTP code.</p>`,
        status,
      )
    return page(
      'Sign in',
      `${errorLine}${passkeyForm}${passwordForm}<script src="/auth/assets/webauthn.js"></script><script src="/auth/assets/login.js"></script>`,
      status,
      new Headers(),
      loginPolicy,
    )
  }

  const passkeySignIn = async (
    request: Request,
    form: URLSearchParams,
  ): Promise<{ ok: true; cookies: Headers; userId: string } | { ok: false; error: string }> => {
    if (!passkeysHere(request))
      return {
        ok: false,
        error: 'Passkeys need the API hostname over HTTPS.',
      }
    const response = (() => {
      try {
        return JSON.parse(form.get('passkey') ?? '') as unknown
      } catch {
        return null
      }
    })()
    if (!response || typeof response !== 'object' || Array.isArray(response))
      return {
        ok: false,
        error: 'The passkey response was malformed.',
      }
    const verified = await auth().api.verifyPasskeyAuthentication({
      body: {
        response,
      } as PasskeyBody,
      headers: apiHeaders(request),
      asResponse: true,
    })
    const body = (await verified.json().catch(() => null)) as {
      user?: { id: string }
      message?: string
    } | null
    if (!verified.ok || !body?.user)
      return {
        ok: false,
        error: body?.message ?? 'The passkey was not accepted.',
      }
    return {
      ok: true,
      cookies: verified.headers,
      userId: body.user.id,
    }
  }

  const signIn = async (
    request: Request,
    form: URLSearchParams,
  ): Promise<{ ok: true; cookies: Headers; userId: string } | { ok: false; error: string }> => {
    const headers = apiHeaders(request)
    headers.delete('cookie')
    const first = await auth().api.signInEmail({
      body: {
        email: form.get('email') ?? '',
        password: form.get('password') ?? '',
      },
      headers,
      asResponse: true,
    })
    const firstBody = (await first.json().catch(() => null)) as {
      twoFactorRedirect?: boolean
      user?: { id: string }
      message?: string
    } | null
    if (!first.ok)
      return {
        ok: false,
        error: firstBody?.message ?? 'The email or password is wrong.',
      }
    if (!firstBody?.twoFactorRedirect) {
      if (!firstBody?.user)
        return {
          ok: false,
          error: 'Sign-in did not return a user.',
        }
      return {
        ok: true,
        cookies: first.headers,
        userId: firstBody.user.id,
      }
    }
    const code = form.get('code')?.trim()
    if (!code)
      return {
        ok: false,
        error: 'This account has TOTP enrolled; enter the current code.',
      }
    const second = new Headers(headers)
    second.set(
      'cookie',
      first.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; '),
    )
    const verified = await auth().api.verifyTOTP({
      body: {
        code,
      },
      headers: second,
      asResponse: true,
    })
    const verifiedBody = (await verified.json().catch(() => null)) as {
      user?: { id: string }
      message?: string
    } | null
    if (!verified.ok || !verifiedBody?.user)
      return {
        ok: false,
        error: verifiedBody?.message ?? 'The TOTP code was refused.',
      }
    return {
      ok: true,
      cookies: verified.headers,
      userId: verifiedBody.user.id,
    }
  }

  const userCall = (request: Request, userId: string) => {
    const principal: Principal = {
      actor: {
        type: 'user',
        id: userId,
        client: request.headers.get('user-agent')?.split(' ')[0]?.slice(0, 64) ?? null,
      },
      human: true,
      user_id: userId,
      token_kind: 'session',
      token_id: null,
      credential: `page:${userId}`,
      scopes: fullAdmin,
      expires_at: new Date(),
      resource: null,
    }
    return {
      principal,
      request_id: requestIdOf(request),
      idempotency_key: null,
    }
  }

  const targetOptions = () => {
    const projects = db
      .select({
        id: project.id,
        name: project.name,
      })
      .from(project)
      .orderBy(asc(project.name))
      .all()
    const options: { value: string; label: string }[] = [
      {
        value: '*|*',
        label: 'Every project and environment, including ones created later',
      },
    ]
    for (const p of projects) {
      options.push({
        value: `${p.id}|*`,
        label: `${p.name}: every environment`,
      })
      const envs = db
        .select({
          id: environment.id,
          name: environment.name,
        })
        .from(environment)
        .where(eq(environment.project_id, p.id))
        .orderBy(asc(environment.name))
        .all()
      for (const e of envs)
        options.push({
          value: `${p.id}|${e.id}`,
          label: `${p.name} / ${e.name}`,
        })
    }
    return options
  }

  const scopesFrom = (values: string[], level: Level): Scope[] | null => {
    const scopes: Scope[] = []
    for (const value of values) {
      const [projectId, environmentId] = value.split('|')
      if (!projectId || !environmentId) return null
      if (projectId === '*' && environmentId !== '*') return null
      if (
        projectId !== '*' &&
        !db
          .select({
            id: project.id,
          })
          .from(project)
          .where(eq(project.id, projectId))
          .get()
      )
        return null
      if (
        environmentId !== '*' &&
        !db
          .select({
            id: environment.id,
          })
          .from(environment)
          .where(and(eq(environment.id, environmentId), eq(environment.project_id, projectId)))
          .get()
      )
        return null
      scopes.push({
        project_id: projectId,
        environment_id: environmentId,
        level,
      })
    }
    return scopes.length ? scopes : null
  }

  const consentPage = async (request: Request, oauthQuery: string, error: string | null = null) => {
    const query = new URLSearchParams(oauthQuery)
    const clientId = query.get('client_id') ?? ''
    const headers = apiHeaders(request)
    const client = (await auth()
      .api.getOAuthClientPublic({
        query: {
          client_id: clientId,
        },
        headers,
      })
      .catch(() => null)) as { client_name?: string; client_uri?: string; logo_uri?: string } | null
    const requested = (query.get('scope') ?? '').split(' ').filter(Boolean)
    const offered = tokenLevelValues.filter((level) => requested.includes(levelScopes[level]))
    const redirectUri = query.get('redirect_uri') ?? ''
    const redirectHost = (() => {
      try {
        return new URL(redirectUri).host
      } catch {
        return redirectUri
      }
    })()
    const hidden = `<input type="hidden" name="oauth_query" value="${escape(oauthQuery)}">`
    const clientBox = `<div class="box">${client?.logo_uri ? `<img src="${escape(client.logo_uri)}" alt="" width="48" height="48" referrerpolicy="no-referrer">` : ''}<p><strong>${escape(client?.client_name ?? 'Unknown client')}</strong></p><p>Client id <code>${escape(clientId)}</code></p>${client?.client_uri ? `<p>Website <code>${escape(client.client_uri)}</code></p>` : ''}<p>Sends you back to <code>${escape(redirectHost)}</code></p></div>`
    if (!offered.length) {
      return page(
        'Authorize an MCP client',
        `${clientBox}<p class="error">The client asked for no Stationly level (scope ${escape(requested.join(' ') || 'none')}).</p><form method="post" action="/auth/consent">${hidden}<button type="submit" name="decision" value="deny">Deny</button></form>`,
      )
    }
    const options = targetOptions()
    return page(
      'Authorize an MCP client',
      `${error ? `<p class="error">${escape(error)}</p>` : ''}${clientBox}<p>It will act as a non-human OAuth client with the level and targets you choose. Its access token lasts one hour and refreshes for 30 days; revoke it any time with <code>sly tokens revoke</code>.</p><form method="post" action="/auth/consent">${hidden}<fieldset><legend>Level</legend>${offered
        .map(
          (level, i) =>
            `<label><input type="radio" name="level" value="${level}"${i === offered.length - 1 ? ' checked' : ''}> ${level}</label>`,
        )
        .join('')}</fieldset><fieldset><legend>Projects and environments</legend>${options
        .map(
          (option) =>
            `<label><input type="checkbox" name="target" value="${escape(option.value)}"> ${escape(option.label)}</label>`,
        )
        .join(
          '',
        )}</fieldset><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form>`,
    )
  }

  const claimDeviceCode = async (request: Request, userCode: string) => {
    const headers = apiHeaders(request)
    try {
      await auth().api.deviceVerify({
        query: {
          user_code: userCode,
        },
        headers,
      })
      return null
    } catch (error) {
      const body = (error as { body?: { error_description?: string; message?: string } }).body
      return body?.error_description ?? body?.message ?? 'The code is unknown or expired.'
    }
  }

  const consentRequest = (request: Request, headers: Headers) =>
    new Request(`${originOf(request)}/auth/oauth2/consent`, {
      method: 'POST',
      headers,
    })

  const redirectFrom = async (result: unknown) => {
    const body = result instanceof Response ? await result.json().catch(() => null) : result
    const url =
      (body as { url?: string } | null)?.url ??
      (result instanceof Response ? result.headers.get('location') : null)
    if (!url)
      throw new Error(
        `the consent call returned no redirect: ${JSON.stringify(body).slice(0, 200)}`,
      )
    return redirect(url)
  }

  return new Elysia({
    name: 'stationly-auth-pages',
    normalize: false,
  })
    .get(
      '/auth/assets/:name',
      ({ request }) => {
        if (!allowed(request, 'api')) return wrongHost(request)
        const body = loginScripts[new URL(request.url).pathname as keyof typeof loginScripts]
        return body ? script(body) : page('Not found', '<p>No such file.</p>', 404)
      },
      {
        detail: {
          hide: true,
        },
      },
    )
    .get(
      '/auth/login',
      ({ request }) => {
        if (!allowed(request, 'api')) return wrongHost(request)
        return loginForm(request, new URL(request.url).search.slice(1), null)
      },
      {
        detail: {
          hide: true,
        },
      },
    )
    .post(
      '/auth/login',
      async ({ request }) => {
        if (!allowed(request, 'api')) return wrongHost(request)
        if (!sameOrigin(request)) return forbidden()
        const form = await formOf(request)
        const oauthQuery = form.get('oauth_query') ?? ''
        if (!(await verifyOAuthQueryParams(oauthQuery, deps.auth.secretKey)))
          return page(
            'Sign in',
            '<p class="error">The authorization request expired or was altered; start again from the client.</p>',
            400,
          )
        const result = form.get('passkey')
          ? await passkeySignIn(request, form)
          : await signIn(request, form)
        if (!result.ok) return loginForm(request, oauthQuery, result.error, 401)
        if (!enrolled(result.userId)) return enrollFirst()
        return redirect(`/auth/oauth2/authorize?${authorizeQuery(oauthQuery)}`, result.cookies)
      },
      {
        parse: 'none',
        detail: {
          hide: true,
        },
      },
    )
    .get(
      '/auth/consent',
      async ({ request }) => {
        if (!allowed(request, 'api')) return wrongHost(request)
        const oauthQuery = new URL(request.url).search.slice(1)
        if (!(await verifyOAuthQueryParams(oauthQuery, deps.auth.secretKey)))
          return page(
            'Authorize an MCP client',
            '<p class="error">The authorization request expired or was altered; start again from the client.</p>',
            400,
          )
        const session = await sessionOf(request)
        if (!session) return redirect(`/auth/login?${oauthQuery}`)
        if (!enrolled(session.user.id)) return enrollFirst()
        return consentPage(request, oauthQuery)
      },
      {
        detail: {
          hide: true,
        },
      },
    )
    .post(
      '/auth/consent',
      async ({ request }) => {
        if (!allowed(request, 'api')) return wrongHost(request)
        if (!sameOrigin(request)) return forbidden()
        const form = await formOf(request)
        const oauthQuery = form.get('oauth_query') ?? ''
        if (!(await verifyOAuthQueryParams(oauthQuery, deps.auth.secretKey)))
          return page(
            'Authorize an MCP client',
            '<p class="error">The authorization request expired or was altered; start again from the client.</p>',
            400,
          )
        const session = await sessionOf(request)
        if (!session)
          return page(
            'Authorize an MCP client',
            '<p class="error">Consent needs a signed-in admin session on this host.</p>',
            401,
          )
        if (!enrolled(session.user.id)) return enrollFirst()
        const headers = apiHeaders(request)
        const query = new URLSearchParams(oauthQuery)
        const call = userCall(request, session.user.id)
        if (form.get('decision') !== 'approve') {
          const result = await auth().api.oauth2Consent({
            body: {
              accept: false,
              oauth_query: oauthQuery,
            },
            headers,
            request: consentRequest(request, headers),
          })
          audit(db, call, 'oauth.deny', {
            entity: 'oauth_client',
            id: query.get('client_id') ?? '',
          })
          return redirectFrom(result)
        }
        const requested = (query.get('scope') ?? '').split(' ').filter(Boolean)
        const level = tokenLevelValues.find((l) => l === form.get('level'))
        if (!level || !requested.includes(levelScopes[level]))
          return consentPage(request, oauthQuery, 'Pick one of the levels the client asked for.')
        const scopes = scopesFrom(form.getAll('target'), level)
        if (!scopes)
          return consentPage(request, oauthQuery, 'Pick at least one project or environment.')
        const clientId = query.get('client_id') ?? ''
        const client = (await auth()
          .api.getOAuthClientPublic({
            query: {
              client_id: clientId,
            },
            headers,
          })
          .catch(() => null)) as { client_name?: string } | null
        const id = newId('token')
        db.insert(token)
          .values({
            id,
            user_id: session.user.id,
            name: `oauth/${(client?.client_name ?? clientId).slice(0, 100)}`,
            kind: 'oauth',
            scopes,
            expires_at: new Date(Date.now() + oauthRefreshSeconds * 1000),
            client_id: clientId,
          })
          .run()
        const granted = [
          levelScopes[level],
          ...requested.filter((scope) => levelOfScope(scope) === null),
        ].join(' ')
        try {
          const result = await withPendingGrant(session.session.id, id, () =>
            auth().api.oauth2Consent({
              body: {
                accept: true,
                scope: granted,
                oauth_query: oauthQuery,
              },
              headers,
              request: consentRequest(request, headers),
            }),
          )
          audit(
            db,
            call,
            'oauth.grant',
            {
              entity: 'token',
              id,
            },
            {
              after: {
                client_id: clientId,
                scopes,
                scope: granted,
              },
            },
          )
          return redirectFrom(result)
        } catch (error) {
          db.delete(token).where(eq(token.id, id)).run()
          throw error
        }
      },
      {
        parse: 'none',
        detail: {
          hide: true,
        },
      },
    )
    .get(
      '/device',
      async ({ request }) => {
        if (!allowed(request, 'dashboard')) return wrongHost(request)
        const url = new URL(request.url)
        const session = await sessionOf(request)
        if (!session)
          return redirect(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`)
        if (!enrolled(session.user.id)) return enrollFirst()
        const userCode = (url.searchParams.get('user_code') ?? '').trim().toUpperCase()
        if (userCode) {
          const claimed = await claimDeviceCode(request, userCode)
          if (claimed)
            return page('Approve sly login', `<p class="error">${escape(claimed)}</p>`, 400)
        }
        return page(
          'Approve sly login',
          `<p>Approve only a code you see in your own terminal right now. The machine that started <code>sly login</code> gets a 12 hour session that acts as you.</p><form method="post" action="/device"><label for="user_code">Code</label><input id="user_code" type="text" name="user_code" value="${escape(userCode)}" autocomplete="off" required><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form>`,
        )
      },
      {
        detail: {
          hide: true,
        },
      },
    )
    .post(
      '/device',
      async ({ request }) => {
        if (!allowed(request, 'dashboard')) return wrongHost(request)
        if (!sameOrigin(request)) return forbidden()
        const session = await sessionOf(request)
        if (!session) return page('Approve sly login', '<p class="error">Sign in first.</p>', 401)
        if (!enrolled(session.user.id)) return enrollFirst()
        const form = await formOf(request)
        const userCode = (form.get('user_code') ?? '').trim().toUpperCase()
        const headers = apiHeaders(request)
        const approve = form.get('decision') === 'approve'
        const claimed = await claimDeviceCode(request, userCode)
        if (claimed)
          return page('Approve sly login', `<p class="error">${escape(claimed)}</p>`, 400)
        try {
          if (approve)
            await auth().api.deviceApprove({
              body: {
                userCode,
              },
              headers,
            })
          else
            await auth().api.deviceDeny({
              body: {
                userCode,
              },
              headers,
            })
        } catch (error) {
          const message = (error as { body?: { error_description?: string; message?: string } })
            .body
          return page(
            'Approve sly login',
            `<p class="error">${escape(message?.error_description ?? message?.message ?? 'The code was refused.')}</p>`,
            400,
          )
        }
        audit(
          db,
          userCall(request, session.user.id),
          approve ? 'auth.device_approve' : 'auth.device_deny',
          {
            entity: 'user',
            id: session.user.id,
          },
          {
            after: {
              user_code: userCode,
            },
          },
        )
        return page(
          approve ? 'sly login approved' : 'sly login denied',
          `<p>${approve ? 'Return to your terminal; sly picks up the session within a few seconds.' : 'The terminal that asked is told the request was denied.'}</p>`,
        )
      },
      {
        parse: 'none',
        detail: {
          hide: true,
        },
      },
    )
}

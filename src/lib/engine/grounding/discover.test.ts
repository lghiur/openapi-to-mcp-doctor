import { describe, expect, it } from 'vitest'
import {
  discoverUndocumentedEndpoints,
  extractRegisteredRoutes,
} from '@/lib/engine/grounding/discover'
import type { OperationRef } from '@/lib/engine/operations'

function op(method: string, path: string): OperationRef {
  return { id: `${method}_${path}`, method, path, label: `${method} ${path}`, definition: {} }
}

describe('extractRegisteredRoutes', () => {
  it('extracts gorilla/mux registrations, one entry per method, with the receiver', () => {
    const file = {
      path: 'api.go',
      content: `r.HandleFunc("/org/keys/{keyName}", gw.orgHandler).Methods("POST", "GET")`,
    }
    const routes = extractRegisteredRoutes([file])
    expect(routes).toEqual([
      { method: 'POST', path: '/org/keys/{keyName}', file: 'api.go', line: 1, receiver: 'r' },
      { method: 'GET', path: '/org/keys/{keyName}', file: 'api.go', line: 1, receiver: 'r' },
    ])
  })

  it('extracts net/http 1.22 method-in-pattern registrations', () => {
    const file = { path: 'http.go', content: `mux.HandleFunc("GET /orders/{id}", getOrder)` }
    expect(extractRegisteredRoutes([file])).toEqual([
      { method: 'GET', path: '/orders/{id}', file: 'http.go', line: 1, receiver: 'mux' },
    ])
  })

  it('extracts chi/gin method-named calls and Express routes', () => {
    const files = [
      { path: 'routes.go', content: `r.Get("/settings", getSettings)` },
      { path: 'app.js', content: `app.post('/widgets', createWidget)` },
    ]
    expect(extractRegisteredRoutes(files)).toEqual([
      { method: 'GET', path: '/settings', file: 'routes.go', line: 1, receiver: 'r' },
      { method: 'POST', path: '/widgets', file: 'app.js', line: 1, receiver: 'app' },
    ])
  })

  it('extracts Flask route decorators with a methods list', () => {
    const file = {
      path: 'app.py',
      content: `@app.route("/pets", methods=["GET", "POST"])
def pets():
    pass`,
    }
    expect(extractRegisteredRoutes([file])).toEqual([
      { method: 'GET', path: '/pets', file: 'app.py', line: 1, receiver: 'app' },
      { method: 'POST', path: '/pets', file: 'app.py', line: 1, receiver: 'app' },
    ])
  })

  it('marks method-less registrations as wildcard', () => {
    const file = { path: 'server.go', content: `r.HandleFunc("/reload", gw.resetHandler)` }
    expect(extractRegisteredRoutes([file])).toEqual([
      { method: '*', path: '/reload', file: 'server.go', line: 1, receiver: 'r' },
    ])
  })

  it('ignores non-path strings', () => {
    const file = { path: 'x.js', content: `map.get('cacheKey')` }
    expect(extractRegisteredRoutes([file])).toEqual([])
  })

  it('skips dynamically concatenated paths (the Tyk health-check pattern)', () => {
    const file = {
      path: 'server.go',
      content: `muxer.HandleFunc("/"+gw.GetConfig().HealthCheckEndpointName, gw.liveCheckHandler)`,
    }
    expect(extractRegisteredRoutes([file])).toEqual([])
  })
})

describe('discoverUndocumentedEndpoints', () => {
  it('reports a registered route that no spec operation documents, with a stub fix', () => {
    const file = {
      path: 'server.go',
      content: `r.HandleFunc("/reload/group", gw.groupResetHandler).Methods("GET")
r.HandleFunc("/debug/cache", gw.cacheDebugHandler).Methods("GET")`,
    }
    const findings = discoverUndocumentedEndpoints([op('GET', '/reload/group')], [file])
    expect(findings).toHaveLength(1)
    const finding = findings[0]
    expect(finding).toMatchObject({
      rule: 'SPEC_CODE_UNDOCUMENTED_ENDPOINT',
      severity: 'info',
      confidence: 'MEDIUM',
      path: ['paths', '/debug/cache'],
    })
    expect(finding?.message).toContain('server.go:2')
    const stub = JSON.parse(finding?.after ?? '{}') as Record<string, Record<string, unknown>>
    expect(stub.get).toMatchObject({ operationId: 'get_debug_cache' })
    expect(stub.get?.responses).toBeDefined()
  })

  it('reports a missing method on an already-documented path, targeting the method key', () => {
    const file = {
      path: 'app.js',
      content: `app.get('/widgets', listWidgets)
app.post('/widgets', createWidget)`,
    }
    const findings = discoverUndocumentedEndpoints([op('GET', '/widgets')], [file])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ path: ['paths', '/widgets', 'post'] })
  })

  it('groups multiple undocumented methods on a new path into one insertable stub', () => {
    const file = {
      path: 'app.js',
      content: `app.get('/reports', listReports)
app.post('/reports', createReport)`,
    }
    const findings = discoverUndocumentedEndpoints([op('GET', '/widgets')], [file])
    expect(findings).toHaveLength(1)
    const stub = JSON.parse(findings[0]?.after ?? '{}') as Record<string, unknown>
    expect(Object.keys(stub).sort()).toEqual(['get', 'post'])
  })

  it('does not report routes documented with different param names or syntax', () => {
    const file = { path: 'app.js', content: `app.get('/users/:userId', getUser)` }
    expect(discoverUndocumentedEndpoints([op('GET', '/users/{id}')], [file])).toEqual([])
  })

  it('treats wildcard registrations as documented when any method exists on the path', () => {
    const file = { path: 'server.go', content: `r.HandleFunc("/reload", gw.resetHandler)` }
    expect(discoverUndocumentedEndpoints([op('GET', '/reload')], [file])).toEqual([])
  })

  it('suggests the mount-prefixed external path when spec paths share the prefix (Tyk style)', () => {
    const file = {
      path: 'gateway/server.go',
      content: `http.StripPrefix("/tyk", r)
r.HandleFunc("/reload/group", gw.groupResetHandler).Methods("GET")
r.HandleFunc("/hidden", gw.hiddenHandler).Methods("GET")`,
    }
    const findings = discoverUndocumentedEndpoints([op('GET', '/tyk/reload/group')], [file])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ path: ['paths', '/tyk/hidden'] })
  })

  it('treats server-base-path registrations as documented', () => {
    const file = { path: 'app.js', content: `app.get('/v1/users', listUsers)` }
    const findings = discoverUndocumentedEndpoints([op('GET', '/users')], [file], {
      serverPrefixes: ['/v1'],
    })
    expect(findings).toEqual([])
  })

  it('does not falsely report gorilla regex-param routes that the spec documents', () => {
    const file = {
      path: 'server.go',
      content: `http.StripPrefix("/tyk", r)
r.HandleFunc("/org/keys/{keyName:[^/]*}", gw.orgHandler).Methods("POST")`,
    }
    const findings = discoverUndocumentedEndpoints([op('POST', '/tyk/org/keys/{keyID}')], [file])
    expect(findings).toEqual([])
  })

  it('suggests a clean OpenAPI path for undocumented gorilla regex-param routes', () => {
    const file = {
      path: 'server.go',
      content: `r.HandleFunc("/oauth/{clientId:[^/]*}/rotate", gw.rotateHandler).Methods("PUT")`,
    }
    const findings = discoverUndocumentedEndpoints([op('GET', '/other')], [file])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.path).toEqual(['paths', '/oauth/{clientId}/rotate'])
  })

  it('only prefixes receivers whose documented routes carry the mount (muxer vs r)', () => {
    const file = {
      path: 'gateway/server.go',
      content: `muxer.HandleFunc("/debug/pprof/profile", pprofhttp.Profile)
http.StripPrefix("/tyk", r)
r.HandleFunc("/reload/group", gw.groupResetHandler).Methods("GET")
r.HandleFunc("/hidden", gw.hiddenHandler).Methods("GET")`,
    }
    const findings = discoverUndocumentedEndpoints([op('GET', '/tyk/reload/group')], [file])
    const paths = findings.map((f) => f.path?.[1])
    // r's routes are documented under /tyk, so its undocumented route is prefixed;
    // muxer has no such evidence, so its route is reported at the root.
    expect(paths).toContain('/tyk/hidden')
    expect(paths).toContain('/debug/pprof/profile')
  })

  it('dedupes a route registered identically in multiple files', () => {
    const files = [
      { path: 'a.js', content: `app.get('/dup', h)` },
      { path: 'b.js', content: `app.get('/dup', h)` },
    ]
    const findings = discoverUndocumentedEndpoints([op('GET', '/other')], files)
    expect(findings).toHaveLength(1)
  })
})

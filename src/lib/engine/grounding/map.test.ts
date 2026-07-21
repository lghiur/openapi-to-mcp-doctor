import { describe, expect, it } from 'vitest'
import { findSymbolDefinition, mapOperationsToHandlers } from '@/lib/engine/grounding/map'
import type { OperationRef } from '@/lib/engine/operations'

function op(method: string, path: string): OperationRef {
  return { id: `${method} ${path}`, method, path, label: `${method} ${path}`, definition: {} }
}

const GIN = {
  path: 'routes/gin.go',
  content: `func register(r *gin.Engine) {
  r.GET("/users/:id", handlers.GetUser)
  r.POST("/users", handlers.CreateUser)
}`,
}

const NET_HTTP = {
  path: 'routes/http.go',
  content: `func register(mux *http.ServeMux) {
  mux.HandleFunc("GET /orders/{id}", getOrder)
}`,
}

const GORILLA = {
  path: 'routes/gorilla.go',
  content: `r.HandleFunc("/things/{id}", GetThing).Methods("GET")`,
}

const EXPRESS = {
  path: 'routes/app.js',
  content: `app.get('/widgets/:id', getWidget)`,
}

describe('mapOperationsToHandlers (Go-first)', () => {
  it('maps a Gin GET route to its handler symbol', () => {
    const [result] = mapOperationsToHandlers([op('GET', '/users/{id}')], [GIN])
    expect(result).toMatchObject({
      matched: true,
      file: 'routes/gin.go',
      symbol: 'handlers.GetUser',
    })
  })

  it('does not confuse /users with /users/{id}', () => {
    const [result] = mapOperationsToHandlers([op('POST', '/users')], [GIN])
    expect(result).toMatchObject({ matched: true, symbol: 'handlers.CreateUser' })
  })

  it('maps a net/http 1.22 method-in-pattern route', () => {
    const [result] = mapOperationsToHandlers([op('GET', '/orders/{id}')], [NET_HTTP])
    expect(result).toMatchObject({ matched: true, symbol: 'getOrder' })
  })

  it('maps a gorilla/mux route with .Methods()', () => {
    const [result] = mapOperationsToHandlers([op('GET', '/things/{id}')], [GORILLA])
    expect(result).toMatchObject({ matched: true, symbol: 'GetThing' })
  })

  it('maps an Express route (secondary target)', () => {
    const [result] = mapOperationsToHandlers([op('GET', '/widgets/{id}')], [EXPRESS])
    expect(result).toMatchObject({ matched: true, symbol: 'getWidget' })
  })

  it('marks an operation with no matching route as unmapped (no crash)', () => {
    const [result] = mapOperationsToHandlers([op('DELETE', '/nonexistent')], [GIN, NET_HTTP])
    expect(result?.matched).toBe(false)
    expect(result?.file).toBeNull()
  })
})

describe('mapOperationsToHandlers — param syntax variants', () => {
  it('matches gorilla regex-constrained params like {keyName:[^/]*}', () => {
    const file = {
      path: 'gateway/api.go',
      content: `r.HandleFunc("/org/keys/{keyName:[^/]*}", gw.orgHandler).Methods("POST", "PUT", "GET", "DELETE")`,
    }
    const [result] = mapOperationsToHandlers([op('GET', '/org/keys/{keyID}')], [file])
    expect(result).toMatchObject({ matched: true, symbol: 'gw.orgHandler' })
  })

  it('matches Flask converter params like <int:user_id>', () => {
    const file = {
      path: 'app.py',
      content: `@app.route("/users/<int:user_id>", methods=["GET"])`,
    }
    const [result] = mapOperationsToHandlers([op('GET', '/users/{userId}')], [file])
    expect(result).toMatchObject({ matched: true, file: 'app.py' })
  })

  it('tolerates a trailing slash in the registered path', () => {
    const file = { path: 'app.js', content: `app.get('/widgets/', listWidgets)` }
    const [result] = mapOperationsToHandlers([op('GET', '/widgets')], [file])
    expect(result).toMatchObject({ matched: true, symbol: 'listWidgets' })
  })

  it('matches Go http.MethodGet constants as an explicit method', () => {
    const file = {
      path: 'api.go',
      content: `r.HandleFunc("/apis", gw.apiHandler).Methods(http.MethodGet)`,
    }
    const [result] = mapOperationsToHandlers([op('GET', '/apis')], [file])
    expect(result).toMatchObject({ matched: true, symbol: 'gw.apiHandler' })
  })
})

describe('mapOperationsToHandlers — method placement', () => {
  it('finds the method on a following line (multiline chain)', () => {
    const file = {
      path: 'routes.js',
      content: `router.route('/reports')
  .get(listReports)
  .post(createReport)`,
    }
    const [result] = mapOperationsToHandlers([op('GET', '/reports')], [file])
    expect(result).toMatchObject({ matched: true, file: 'routes.js', line: 1 })
  })

  it('matches a method-less registration (catch-all HandleFunc, Flask default)', () => {
    const file = {
      path: 'server.go',
      content: `r.HandleFunc("/reload", gw.resetHandler)`,
    }
    const [result] = mapOperationsToHandlers([op('GET', '/reload')], [file])
    expect(result).toMatchObject({ matched: true, symbol: 'gw.resetHandler' })
  })

  it('prefers an explicit method match over a method-less registration', () => {
    const file = {
      path: 'server.go',
      content: `r.HandleFunc("/dual", genericHandler)
r.HandleFunc("/dual", postDual).Methods("POST")`,
    }
    const [result] = mapOperationsToHandlers([op('POST', '/dual')], [file])
    expect(result).toMatchObject({ matched: true, symbol: 'postDual', line: 2 })
  })
})

describe('mapOperationsToHandlers — mount prefixes', () => {
  it('maps a spec path through a Go StripPrefix mount (the Tyk pattern)', () => {
    const file = {
      path: 'gateway/server.go',
      content: `muxer.PathPrefix("/tyk/").Handler(http.StripPrefix("/tyk",
  stripSlashes(gw.checkIsAPIOwner(InstrumentationMW(r))),
))
r.HandleFunc("/reload/group", gw.groupResetHandler).Methods("GET")`,
    }
    const [result] = mapOperationsToHandlers([op('GET', '/tyk/reload/group')], [file])
    expect(result).toMatchObject({
      matched: true,
      file: 'gateway/server.go',
      line: 4,
      symbol: 'gw.groupResetHandler',
    })
  })

  it('maps through an Express router mount in a different file', () => {
    const index = { path: 'index.js', content: `app.use('/api', usersRouter)` }
    const users = { path: 'users.js', content: `router.get('/users/:id', getUser)` }
    const [result] = mapOperationsToHandlers([op('GET', '/api/users/{id}')], [index, users])
    expect(result).toMatchObject({ matched: true, file: 'users.js', symbol: 'getUser' })
  })

  it('maps through two nested mounts', () => {
    const index = { path: 'index.js', content: `app.use('/api', v1Router)` }
    const v1 = { path: 'v1.js', content: `router.use('/v1', usersRouter)` }
    const users = { path: 'users.js', content: `router.get('/users', listUsers)` }
    const [result] = mapOperationsToHandlers([op('GET', '/api/v1/users')], [index, v1, users])
    expect(result).toMatchObject({ matched: true, file: 'users.js', symbol: 'listUsers' })
  })

  it('maps through a chi Mount', () => {
    const file = {
      path: 'routes.go',
      content: `r.Mount("/admin", adminRouter)
adminRouter.Get("/settings", getSettings)`,
    }
    const [result] = mapOperationsToHandlers([op('GET', '/admin/settings')], [file])
    expect(result).toMatchObject({ matched: true, symbol: 'getSettings' })
  })

  it('maps through a Flask blueprint url_prefix', () => {
    const file = {
      path: 'pets.py',
      content: `bp = Blueprint("pets", __name__, url_prefix="/pets")
@bp.get("/list")
def list_pets():
    return pets`,
    }
    const [result] = mapOperationsToHandlers([op('GET', '/pets/list')], [file])
    expect(result).toMatchObject({ matched: true, file: 'pets.py', line: 2 })
  })

  it('still prefers an exact full-path match over a prefix-stripped one', () => {
    const file = {
      path: 'server.go',
      content: `r2.HandleFunc("/tyk/reload", fullPathHandler).Methods("GET")
http.StripPrefix("/tyk", r)
r.HandleFunc("/reload", strippedHandler).Methods("GET")`,
    }
    const [result] = mapOperationsToHandlers([op('GET', '/tyk/reload')], [file])
    expect(result).toMatchObject({ matched: true, symbol: 'fullPathHandler' })
  })
})

describe('mapOperationsToHandlers — server-URL base path', () => {
  it('matches code that registers the server base path explicitly', () => {
    const file = { path: 'app.js', content: `app.get('/v1/users', listUsers)` }
    const [result] = mapOperationsToHandlers([op('GET', '/users')], [file], {
      serverPrefixes: ['/v1'],
    })
    expect(result).toMatchObject({ matched: true, symbol: 'listUsers' })
  })
})

describe('findSymbolDefinition', () => {
  const HANDLERS_GO = {
    path: 'handlers/users.go',
    content: `package handlers

func GetUser(c *gin.Context) {
  c.JSON(200, user)
}

func (s *Server) CreateUser(c *gin.Context) {}
`,
  }

  const HANDLERS_JS = {
    path: 'handlers/widgets.js',
    content: `const getWidget = async (req, res) => res.json(widget)
export function listWidgets(req, res) {}
`,
  }

  const HANDLERS_PY = {
    path: 'handlers/orders.py',
    content: `def get_order(order_id):
    return order
`,
  }

  it('finds a Go func by the last segment of a dotted symbol', () => {
    expect(findSymbolDefinition('handlers.GetUser', [GIN, HANDLERS_GO])).toEqual({
      file: 'handlers/users.go',
      line: 3,
    })
  })

  it('finds a Go method with a receiver', () => {
    expect(findSymbolDefinition('handlers.CreateUser', [HANDLERS_GO])).toMatchObject({
      file: 'handlers/users.go',
    })
  })

  it('finds a JS const binding and a function declaration', () => {
    expect(findSymbolDefinition('getWidget', [HANDLERS_JS])).toMatchObject({
      file: 'handlers/widgets.js',
      line: 1,
    })
    expect(findSymbolDefinition('listWidgets', [HANDLERS_JS])).toMatchObject({ line: 2 })
  })

  it('finds a Python def', () => {
    expect(findSymbolDefinition('get_order', [HANDLERS_PY])).toMatchObject({
      file: 'handlers/orders.py',
    })
  })

  it('returns null when no definition exists in the provided files', () => {
    expect(findSymbolDefinition('handlers.DeleteUser', [GIN, HANDLERS_GO])).toBeNull()
  })
})

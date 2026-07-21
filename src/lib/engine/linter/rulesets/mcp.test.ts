import { describe, expect, it } from 'vitest'
import { runStructuralLint } from '@/lib/engine/linter/spectral'
import { mcpRuleset } from '@/lib/engine/linter/rulesets/mcp'
import type { OpenApiVersion } from '@/types/domain'

/** Run only the MCP ruleset against a spec and return the rule codes that fired. */
async function rulesFor(spec: string, version: OpenApiVersion = '3.0'): Promise<string[]> {
  const result = await runStructuralLint(spec, mcpRuleset(version))
  return result.findings.map((f) => f.rule)
}

const HEAD = `openapi: 3.0.3
info:
  title: Test API
  version: 1.0.0
paths:`

const okResponse = `
      responses:
        '200':
          description: A user object.
          content:
            application/json:
              schema:
                type: object
                description: The user.`

function specWithOperations(count: number): string {
  let paths = ''
  for (let i = 0; i < count; i++) {
    paths += `
  /resource${i}:
    get:
      operationId: get_resource_${i}
      description: Returns resource ${i} with all of its descriptive fields populated.${okResponse}`
  }
  return `${HEAD}${paths}\n`
}

describe('mcpRuleset — operationId rules', () => {
  it('flags a missing operationId', async () => {
    const spec = `${HEAD}
  /users:
    get:
      description: Returns the full list of users for the current account context.${okResponse}
`
    expect(await rulesFor(spec)).toContain('mcp-operationid-required')
  })

  it('flags a non-snake_case operationId', async () => {
    const spec = `${HEAD}
  /users:
    post:
      operationId: CreateUser
      description: Creates a new user from the supplied attributes and returns the record.${okResponse}
`
    expect(await rulesFor(spec)).toContain('mcp-operationid-format')
  })

  it('flags duplicate operationIds across operations', async () => {
    const spec = `${HEAD}
  /users:
    get:
      operationId: get_thing
      description: Returns the list of users in the account, newest first, paginated.${okResponse}
  /items:
    get:
      operationId: get_thing
      description: Returns the list of items in the account, newest first, paginated.${okResponse}
`
    expect(await rulesFor(spec)).toContain('mcp-operationid-unique')
  })

  it('accepts a well-formed snake_case unique operationId', async () => {
    const spec = `${HEAD}
  /users:
    get:
      operationId: list_users
      description: Returns the list of users in the account, newest first, paginated.${okResponse}
`
    const rules = await rulesFor(spec)
    expect(rules).not.toContain('mcp-operationid-required')
    expect(rules).not.toContain('mcp-operationid-format')
    expect(rules).not.toContain('mcp-operationid-unique')
  })
})

describe('mcpRuleset — description requirements', () => {
  it('flags a parameter without a description', async () => {
    const spec = `${HEAD}
  /users/{id}:
    get:
      operationId: get_user
      description: Returns the full profile for the user with the given identifier.
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string${okResponse}
`
    expect(await rulesFor(spec)).toContain('mcp-param-description-required')
  })

  it('flags an enum schema without a description', async () => {
    const spec = `${HEAD}
  /users:
    get:
      operationId: list_users
      description: Returns the list of users filtered by the given status value.
      parameters:
        - name: status
          in: query
          description: Filter users by their status.
          schema:
            type: string
            enum: [active, inactive]${okResponse}
`
    expect(await rulesFor(spec)).toContain('mcp-enum-description-required')
  })

  it('does not crash on a spec containing literal null values, still flags the enum', async () => {
    // Real-world specs (e.g. Tyk) carry literal `null`s; the old `$..[?(@.enum)]`
    // JSONPath made nimma evaluate `null.enum` and throw, aborting the whole run.
    const spec = `${HEAD}
  /users:
    get:
      operationId: list_users
      description: Returns the list of users filtered by the given status value here.
      parameters:
        - name: status
          in: query
          description: Filter users by their status.
          schema:
            type: string
            enum: [active, inactive]${okResponse}
components:
  schemas:
    Address:
      type: object
      properties:
        locality: null
        province: null
        status:
          enum: [a, b]
`
    const rules = await rulesFor(spec)
    expect(rules).toContain('mcp-enum-description-required')
  })

  it('flags a nested object property without a description', async () => {
    const spec = `${HEAD}
  /users:
    post:
      operationId: create_user
      description: Creates a new user from the supplied request body attributes.
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string${okResponse}
`
    expect(await rulesFor(spec)).toContain('mcp-nested-description-required')
  })
})

describe('mcpRuleset — response schema', () => {
  it('flags a 2xx response with no schema', async () => {
    const spec = `${HEAD}
  /users:
    get:
      operationId: list_users
      description: Returns the list of users in the account, newest first, paginated.
      responses:
        '200':
          description: ok
`
    expect(await rulesFor(spec)).toContain('mcp-response-schema-required')
  })

  it('does not flag a bodyless 204 response', async () => {
    const spec = `${HEAD}
  /users/{id}:
    delete:
      operationId: delete_user
      description: Deletes the user with the given identifier and returns no content.
      responses:
        '204':
          description: No Content
`
    expect(await rulesFor(spec)).not.toContain('mcp-response-schema-required')
  })

  it('does not flag the default response (anchored 2xx matcher)', async () => {
    const spec = `${HEAD}
  /users:
    get:
      operationId: list_users
      description: Returns the list of users in the account, newest first, paginated.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                description: The list of users.
        default:
          description: Unexpected error
`
    // 'default' must not be treated as a 2xx response needing a schema.
    expect(await rulesFor(spec)).not.toContain('mcp-response-schema-required')
  })
})

describe('mcpRuleset — operation count (honest provenance)', () => {
  it('warns above 40 operations (Cursor 40-tool client limit)', async () => {
    const rules = await rulesFor(specWithOperations(41))
    expect(rules).toContain('mcp-operation-count-warn')
    expect(rules).not.toContain('mcp-operation-count-error')
  })

  it('errors above 80 operations (heuristic upper bound)', async () => {
    const rules = await rulesFor(specWithOperations(81))
    expect(rules).toContain('mcp-operation-count-error')
    expect(rules).not.toContain('mcp-operation-count-warn')
  })

  it('does not warn at or below 40 operations', async () => {
    const rules = await rulesFor(specWithOperations(40))
    expect(rules).not.toContain('mcp-operation-count-warn')
    expect(rules).not.toContain('mcp-operation-count-error')
  })
})

describe('mcpRuleset — description heuristics', () => {
  it('flags a description that is just the method and path', async () => {
    const spec = `${HEAD}
  /users:
    get:
      operationId: list_users
      description: GET /users${okResponse}
`
    const rules = await rulesFor(spec)
    expect(rules).toContain('mcp-description-is-just-path')
  })

  it('flags a too-short description', async () => {
    const spec = `${HEAD}
  /users:
    get:
      operationId: list_users
      description: Lists users.${okResponse}
`
    expect(await rulesFor(spec)).toContain('mcp-description-too-short')
  })
})

describe('mcpRuleset — provenance in messages', () => {
  it('attributes the operationId format rule to LLM tool-API compatibility, not the MCP spec', async () => {
    const spec = `${HEAD}
  /users:
    get:
      operationId: ListUsers
      description: Returns the list of users in the account, newest first, paginated.${okResponse}
`
    const result = await runStructuralLint(spec, mcpRuleset('3.0'))
    const finding = result.findings.find((f) => f.rule === 'mcp-operationid-format')
    expect(finding?.message.toLowerCase()).toContain('llm tool-api')
    expect(finding?.message).toMatch(/SEP-986|128/)
  })
})

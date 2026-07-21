import { describe, expect, it } from 'vitest'
import { runStructuralLint } from '@/lib/engine/linter/spectral'
import { mcpRuleset } from '@/lib/engine/linter/rulesets/mcp'
import type { Finding, OpenApiVersion } from '@/types/domain'

async function findingsFor(spec: string, version: OpenApiVersion): Promise<Finding[]> {
  const result = await runStructuralLint(spec, mcpRuleset(version))
  return result.findings
}

async function rulesFor(spec: string, version: OpenApiVersion): Promise<string[]> {
  return (await findingsFor(spec, version)).map((f) => f.rule)
}

const PING = `
  /ping:
    get:
      operationId: ping
      description: Health check endpoint returning a simple ok payload for monitoring.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                description: ok envelope`

function spec30(body: string): string {
  return `openapi: 3.0.3
info:
  title: Test
  version: 1.0.0
paths:${PING}
${body}`
}

function spec31(body: string): string {
  return `openapi: 3.1.0
info:
  title: Test
  version: 1.0.0
paths:${PING}
${body}`
}

describe('mcp-nullable-deprecated (3.1 only)', () => {
  const components = `components:
  schemas:
    Foo:
      type: object
      properties:
        name:
          type: string
          nullable: true
          description: The name.`

  it('flags nullable: true in a 3.1 spec', async () => {
    expect(await rulesFor(spec31(components), '3.1')).toContain('mcp-nullable-deprecated')
  })

  it('does not flag nullable: true in a 3.0 spec (valid there)', async () => {
    expect(await rulesFor(spec30(components), '3.0')).not.toContain('mcp-nullable-deprecated')
  })
})

describe('mcp-xnullable-not-standard', () => {
  it('flags the non-standard x-nullable extension', async () => {
    const components = `components:
  schemas:
    Foo:
      type: object
      properties:
        name:
          type: string
          x-nullable: true
          description: The name.`
    expect(await rulesFor(spec30(components), '3.0')).toContain('mcp-xnullable-not-standard')
  })
})

describe('mcp-schema-examples-array (3.0 only)', () => {
  it('flags a schema-level array `examples` in a 3.0 spec', async () => {
    const components = `components:
  schemas:
    Foo:
      type: object
      description: foo
      examples:
        - a: 1`
    expect(await rulesFor(spec30(components), '3.0')).toContain('mcp-schema-examples-array')
  })

  it('does not flag a parameter-level `examples` map (that is valid in 3.0)', async () => {
    const body = `  /search:
    get:
      operationId: search_things
      description: Searches things by the provided query string and returns the matches.
      parameters:
        - name: q
          in: query
          description: The query.
          schema:
            type: string
          examples:
            sample:
              value: hello
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                description: results`
    expect(await rulesFor(spec30(body), '3.0')).not.toContain('mcp-schema-examples-array')
  })

  it('does not flag schema-level array `examples` in a 3.1 spec (valid there)', async () => {
    const components = `components:
  schemas:
    Foo:
      type: object
      description: foo
      examples:
        - a: 1`
    expect(await rulesFor(spec31(components), '3.1')).not.toContain('mcp-schema-examples-array')
  })
})

describe('mcp-external-ref', () => {
  it('flags a $ref that points outside the document', async () => {
    const components = `components:
  schemas:
    User:
      type: object
      properties:
        org:
          $ref: './org.yaml#/Org'`
    expect(await rulesFor(spec30(components), '3.0')).toContain('mcp-external-ref')
  })

  it('does not flag an internal $ref', async () => {
    const components = `components:
  schemas:
    Org:
      type: object
      description: org
    User:
      type: object
      properties:
        org:
          $ref: '#/components/schemas/Org'`
    expect(await rulesFor(spec30(components), '3.0')).not.toContain('mcp-external-ref')
  })
})

describe('mcp-recursive-ref', () => {
  it('flags a self-referential schema', async () => {
    const components = `components:
  schemas:
    Node:
      type: object
      properties:
        children:
          type: array
          items:
            $ref: '#/components/schemas/Node'`
    expect(await rulesFor(spec30(components), '3.0')).toContain('mcp-recursive-ref')
  })

  it('does not flag a non-recursive schema graph', async () => {
    const components = `components:
  schemas:
    Org:
      type: object
      description: org
    User:
      type: object
      properties:
        org:
          $ref: '#/components/schemas/Org'`
    expect(await rulesFor(spec30(components), '3.0')).not.toContain('mcp-recursive-ref')
  })
})

describe('mcp-param-conflict', () => {
  it('flags a parameter name that also appears in the request body', async () => {
    const body = `  /users/{id}:
    post:
      operationId: update_user
      description: Updates the user identified by the path id using the supplied body fields.
      parameters:
        - name: id
          in: path
          required: true
          description: The user id.
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                id:
                  type: string
                  description: The body id, which collides with the path id.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                description: updated`
    expect(await rulesFor(spec30(body), '3.0')).toContain('mcp-param-conflict')
  })
})

describe('mcp-binary-no-mcp-equivalent', () => {
  it('flags a binary upload as an error', async () => {
    const body = `  /files:
    post:
      operationId: upload_file
      description: Uploads a single raw binary file to the server for later retrieval.
      requestBody:
        content:
          application/octet-stream:
            schema:
              type: string
              format: binary
              description: The raw file bytes.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                description: uploaded`
    const findings = await findingsFor(spec30(body), '3.0')
    const binary = findings.find((f) => f.rule === 'mcp-binary-no-mcp-equivalent')
    expect(binary).toBeDefined()
    expect(binary?.severity).toBe('error')
  })
})

describe('mcp-multipart-partial-support', () => {
  it('warns on multipart/form-data request bodies', async () => {
    const body = `  /forms:
    post:
      operationId: submit_form
      description: Submits a multipart form with several plain text fields for processing.
      requestBody:
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                name:
                  type: string
                  description: A field.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                description: submitted`
    expect(await rulesFor(spec30(body), '3.0')).toContain('mcp-multipart-partial-support')
  })
})

describe('mcp-form-urlencoded', () => {
  it('warns on application/x-www-form-urlencoded request bodies', async () => {
    const body = `  /login:
    post:
      operationId: login
      description: Authenticates a user from form-encoded credentials and returns a token.
      requestBody:
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              properties:
                username:
                  type: string
                  description: The username.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                description: token`
    expect(await rulesFor(spec30(body), '3.0')).toContain('mcp-form-urlencoded')
  })
})

describe('mcp-auth-not-in-description', () => {
  it('flags a secured operation whose description never mentions auth', async () => {
    const body = `  /secret:
    get:
      operationId: get_secret
      description: Returns the secret configuration value for the current account context.
      security:
        - apiKey: []
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                description: secret`
    expect(await rulesFor(spec30(body), '3.0')).toContain('mcp-auth-not-in-description')
  })

  it('does not flag when the description explains the auth requirement', async () => {
    const body = `  /secret:
    get:
      operationId: get_secret
      description: Returns the secret value. Requires a valid bearer token in the Authorization header.
      security:
        - apiKey: []
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                description: secret`
    expect(await rulesFor(spec30(body), '3.0')).not.toContain('mcp-auth-not-in-description')
  })
})

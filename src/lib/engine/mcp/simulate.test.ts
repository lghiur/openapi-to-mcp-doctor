import { describe, expect, it } from 'vitest'
import { simulateMcpTools } from '@/lib/engine/mcp/simulate'

const CLEAN_SPEC = `openapi: 3.0.3
info:
  title: Pets
  version: 1.0.0
paths:
  /pets/{petId}:
    get:
      operationId: get_pet
      description: Fetch one pet by id.
      parameters:
        - name: petId
          in: path
          required: true
          description: Unique pet identifier.
          schema:
            type: string
      responses:
        '200':
          description: A pet.
    delete:
      operationId: delete_pet
      summary: Delete a pet.
      responses:
        '204':
          description: Deleted.
`

describe('simulateMcpTools', () => {
  it('converts every clean operation into a loadable MCP tool', () => {
    const result = simulateMcpTools(CLEAN_SPEC)
    expect(result.total).toBe(2)
    expect(result.loadable).toBe(2)
    const get = result.tools.find((t) => t.name === 'get_pet')
    expect(get).toBeDefined()
    expect(get?.description).toBe('Fetch one pet by id.')
    expect(get?.issues).toEqual([])
    expect(get?.inputSchema.type).toBe('object')
    expect(get?.inputSchema.properties.petId).toMatchObject({
      type: 'string',
      description: 'Unique pet identifier.',
    })
    expect(get?.inputSchema.required).toEqual(['petId'])
  })

  it('uses summary as the description fallback', () => {
    const result = simulateMcpTools(CLEAN_SPEC)
    const del = result.tools.find((t) => t.name === 'delete_pet')
    expect(del?.description).toBe('Delete a pet.')
    expect(del?.issues).toEqual([])
  })

  it('flags a missing operationId as unloadable (missing-name)', () => {
    const spec = CLEAN_SPEC.replace('      operationId: get_pet\n', '')
    const result = simulateMcpTools(spec)
    const tool = result.tools.find((t) => t.operation === 'GET /pets/{petId}')
    expect(tool?.issues.map((i) => i.code)).toContain('missing-name')
    expect(result.loadable).toBe(1)
  })

  it('flags names that violate the vendor tool-name pattern (invalid-name)', () => {
    const spec = CLEAN_SPEC.replace('operationId: get_pet', 'operationId: "get pet!"')
    const result = simulateMcpTools(spec)
    const tool = result.tools.find((t) => t.operation === 'GET /pets/{petId}')
    expect(tool?.issues.map((i) => i.code)).toContain('invalid-name')
  })

  it('flags names over 64 chars, attributing the limit to LLM tool APIs (not MCP)', () => {
    const long = 'a'.repeat(65)
    const spec = CLEAN_SPEC.replace('operationId: get_pet', `operationId: ${long}`)
    const result = simulateMcpTools(spec)
    const tool = result.tools.find((t) => t.operation === 'GET /pets/{petId}')
    const issue = tool?.issues.find((i) => i.code === 'name-too-long')
    expect(issue).toBeDefined()
    expect(issue?.message).toMatch(/LLM tool API/i)
    expect(issue?.message).toMatch(/128/)
  })

  it('flags duplicate tool names on every duplicate', () => {
    const spec = CLEAN_SPEC.replace('operationId: delete_pet', 'operationId: get_pet')
    const result = simulateMcpTools(spec)
    const flagged = result.tools.filter((t) => t.issues.some((i) => i.code === 'duplicate-name'))
    expect(flagged).toHaveLength(2)
    expect(result.loadable).toBe(0)
  })

  it('flags an operation with neither description nor summary (missing-description)', () => {
    const spec = CLEAN_SPEC.replace('      description: Fetch one pet by id.\n', '')
    const result = simulateMcpTools(spec)
    const tool = result.tools.find((t) => t.name === 'get_pet')
    expect(tool?.issues.map((i) => i.code)).toContain('missing-description')
  })

  it('exposes a JSON request body as a `body` input property', () => {
    const spec = `openapi: 3.0.3
info:
  title: Pets
  version: 1.0.0
paths:
  /pets:
    post:
      operationId: create_pet
      description: Create a pet.
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
      responses:
        '201':
          description: Created.
`
    const result = simulateMcpTools(spec)
    const tool = result.tools.find((t) => t.name === 'create_pet')
    expect(tool?.inputSchema.properties.body).toMatchObject({ type: 'object' })
  })

  it('warns when the tool count exceeds client limits (Cursor 40)', () => {
    const paths = Array.from({ length: 41 }, (_, i) =>
      [
        `  /r${i}:`,
        '    get:',
        `      operationId: get_r${i}`,
        `      description: Get r${i}.`,
        '      responses:',
        "        '200':",
        '          description: OK.',
      ].join('\n'),
    ).join('\n')
    const spec = `openapi: 3.0.3\ninfo:\n  title: Big\n  version: 1.0.0\npaths:\n${paths}\n`
    const result = simulateMcpTools(spec)
    expect(result.total).toBe(41)
    expect(result.clientWarnings.join(' ')).toMatch(/Cursor/)
  })

  it('returns an empty simulation for an unparseable spec', () => {
    const result = simulateMcpTools('{{{not yaml')
    expect(result).toEqual({ tools: [], total: 0, loadable: 0, clientWarnings: [] })
  })
})

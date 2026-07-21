'use client'

import { FileUp, Sparkles, Stethoscope } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { type DragEvent, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const SAMPLE_SPEC = `openapi: 3.0.3
info:
  title: Sample API
  version: 1.0.0
paths:
  /users/{id}:
    get:
      operationId: getUser
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: A user
`

export function PasteForm() {
  const router = useRouter()
  const [spec, setSpec] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function onSubmit(): Promise<void> {
    if (!spec.trim()) {
      setError('Paste, drop, or load an OpenAPI spec first.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec }),
      })
      if (!res.ok) throw new Error('Analyze request failed')
      const { jobId } = (await res.json()) as { jobId: string }
      router.push(`/analysis/${jobId}`)
    } catch {
      setError('Could not start analysis. Check the spec and try again.')
      setSubmitting(false)
    }
  }

  async function ingestFile(file: File): Promise<void> {
    setSpec(await file.text())
    setError(null)
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file) void ingestFile(file)
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'relative rounded-xl border border-dashed p-1 transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'border-border',
        )}
      >
        <Textarea
          aria-label="OpenAPI spec"
          placeholder="Paste or drop your OpenAPI 3.0 / 3.1 spec here (YAML or JSON)…"
          value={spec}
          onChange={(event) => setSpec(event.target.value)}
          className="min-h-[260px] border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-1 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="inline-flex items-center gap-1.5 font-medium text-foreground/80 transition-colors hover:text-primary"
            >
              <FileUp className="size-3.5" />
              Upload file
            </button>
            <button
              type="button"
              onClick={() => setSpec(SAMPLE_SPEC)}
              className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
            >
              <Sparkles className="size-3.5" />
              Try a sample
            </button>
          </div>
          <span className="tnum">{spec.length.toLocaleString()} chars</span>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".yaml,.yml,.json,application/json,text/yaml"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void ingestFile(file)
          }}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button size="lg" onClick={onSubmit} disabled={submitting} className="gap-2">
          {submitting ? <Spinner className="size-4" /> : <Stethoscope className="size-4" />}
          {submitting ? 'Analyzing…' : 'Run structural analysis'}
        </Button>
        <span className="text-sm text-muted-foreground">No account needed</span>
      </div>
    </div>
  )
}

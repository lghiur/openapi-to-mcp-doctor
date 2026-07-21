'use client'

import { CheckCircle2, Plug, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { testLlmConnection } from '@/features/settings/actions'

export function TestConnectionButton() {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [pending, setPending] = useState(false)

  async function onClick(): Promise<void> {
    setPending(true)
    setResult(await testLlmConnection())
    setPending(false)
  }

  return (
    <div className="flex flex-wrap items-center gap-3 pt-1">
      <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
        {pending ? <Spinner className="size-4" /> : <Plug className="size-4" />}
        {pending ? 'Testing…' : 'Test connection'}
      </Button>
      {result && (
        <span
          className={`inline-flex items-center gap-1.5 text-sm ${result.ok ? 'text-success' : 'text-muted-foreground'}`}
        >
          {result.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
          {result.message}
        </span>
      )}
    </div>
  )
}

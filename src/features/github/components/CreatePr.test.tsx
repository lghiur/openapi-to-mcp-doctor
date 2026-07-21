// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreatePr } from './CreatePr'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('CreatePr', () => {
  it('is disabled until at least one suggestion is accepted', () => {
    render(<CreatePr jobId="job-1" acceptedIds={[]} />)
    expect(screen.getByRole('button', { name: /create pr/i })).toBeDisabled()
  })

  it('posts the accepted ids and shows the PR link on success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://github.com/t/r/pull/7', number: 7 }), {
        status: 200,
      }),
    )
    render(<CreatePr jobId="job-1" acceptedIds={['f1', 'f2']} />)
    fireEvent.click(screen.getByRole('button', { name: /create pr/i }))

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /pr #7/i })
      expect(link).toHaveAttribute('href', 'https://github.com/t/r/pull/7')
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/github/pr',
      expect.objectContaining({ method: 'POST' }),
    )
    const init = fetchSpy.mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body))).toEqual({ jobId: 'job-1', acceptedIds: ['f1', 'f2'] })
  })

  it('surfaces the server error and allows retrying', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Branch already exists.' }), { status: 502 }),
    )
    render(<CreatePr jobId="job-1" acceptedIds={['f1']} />)
    fireEvent.click(screen.getByRole('button', { name: /create pr/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Branch already exists.'))
    // still actionable — the user can retry after fixing the cause
    expect(screen.getByRole('button', { name: /create pr/i })).toBeEnabled()
  })
})

// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PasteForm } from './PasteForm'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

beforeEach(() => {
  push.mockReset()
  vi.restoreAllMocks()
})

describe('PasteForm', () => {
  it('renders the CTA', () => {
    render(<PasteForm />)
    expect(screen.getByText('Run structural analysis')).toBeInTheDocument()
  })

  it('posts the spec and navigates to the analysis page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jobId: 'job-1' }), { status: 200 }),
    )
    render(<PasteForm />)
    fireEvent.change(screen.getByLabelText('OpenAPI spec'), {
      target: { value: 'openapi: 3.0.3' },
    })
    fireEvent.click(screen.getByText('Run structural analysis'))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/analysis/job-1'))
  })

  it('shows an error when the spec is empty', () => {
    render(<PasteForm />)
    fireEvent.click(screen.getByText('Run structural analysis'))
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})

// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PipelineStepper } from './PipelineStepper'

describe('PipelineStepper', () => {
  it('renders nothing when no phases are planned', () => {
    const { container } = render(
      <PipelineStepper phases={[]} status={{}} opsDone={0} opsTotal={0} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a labelled step for each planned phase', () => {
    render(
      <PipelineStepper
        phases={['structural', 'workers', 'postprocess']}
        status={{ structural: 'done', workers: 'active', postprocess: 'pending' }}
        opsDone={3}
        opsTotal={8}
      />,
    )
    expect(screen.getByText('Structural')).toBeInTheDocument()
    expect(screen.getByText('AI workers')).toBeInTheDocument()
    expect(screen.getByText('Near-duplicate check')).toBeInTheDocument()
  })

  it('shows worker progress as X/N while workers run', () => {
    render(
      <PipelineStepper
        phases={['structural', 'workers']}
        status={{ structural: 'done', workers: 'active' }}
        opsDone={3}
        opsTotal={8}
      />,
    )
    expect(screen.getByText('3/8')).toBeInTheDocument()
  })

  it('marks the active phase with aria-current for assistive tech', () => {
    render(
      <PipelineStepper
        phases={['structural', 'workers']}
        status={{ structural: 'done', workers: 'active' }}
        opsDone={0}
        opsTotal={2}
      />,
    )
    expect(screen.getByText('AI workers').closest('li')).toHaveAttribute('aria-current', 'step')
  })

  it('exposes a per-phase status label to assistive tech', () => {
    render(
      <PipelineStepper
        phases={['structural']}
        status={{ structural: 'done' }}
        opsDone={1}
        opsTotal={1}
      />,
    )
    // sr-only status word so the stepper is not conveyed by colour/icon alone
    expect(screen.getByText('done', { exact: false })).toBeInTheDocument()
  })
})

// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { countSelected, OperationPicker, selectAll, type PickerValue } from './OperationPicker'
import type { SpecPathListing } from '@/features/github/actions'

const PATHS: SpecPathListing[] = [
  { path: '/users', methods: ['get', 'post'] },
  { path: '/items', methods: ['get'] },
]

/** Stateful wrapper so interactions round-trip through onChange like in the app. */
function Harness({ onValue }: { onValue?: (v: PickerValue) => void }) {
  const [value, setValue] = useState<PickerValue>(() => selectAll(PATHS))
  return (
    <OperationPicker
      paths={PATHS}
      value={value}
      onChange={(v) => {
        setValue(v)
        onValue?.(v)
      }}
    />
  )
}

describe('OperationPicker', () => {
  it('starts with every operation selected', () => {
    render(<Harness />)
    expect(screen.getByText('3 of 3 operations selected')).toBeInTheDocument()
    expect(countSelected(selectAll(PATHS))).toBe(3)
  })

  it('unticking a path deselects all of its methods', () => {
    let latest: PickerValue = {}
    render(<Harness onValue={(v) => (latest = v)} />)
    fireEvent.click(screen.getByLabelText('Select all methods of /users'))
    expect(latest['/users']).toBeUndefined()
    expect(screen.getByText('1 of 3 operations selected')).toBeInTheDocument()
  })

  it('re-ticking a partially-selected path selects all of its methods', () => {
    let latest: PickerValue = {}
    render(<Harness onValue={(v) => (latest = v)} />)
    // expand /users and deselect just "post" -> partial
    fireEvent.click(screen.getByText('/users'))
    fireEvent.click(screen.getByLabelText('post'))
    expect(latest['/users']).toEqual(['get'])
    // path checkbox is now indeterminate; clicking it selects everything again
    fireEvent.click(screen.getByLabelText('Select all methods of /users'))
    expect(latest['/users']).toEqual(['get', 'post'])
  })

  it('select all / clear toggle the whole set', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByText('0 of 3 operations selected')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Select all'))
    expect(screen.getByText('3 of 3 operations selected')).toBeInTheDocument()
  })
})

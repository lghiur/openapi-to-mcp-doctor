# Next.js App Router — Project Conventions

Sources: Next.js official docs, Next.js 15/16 App Router guide, battle-tested 2025/2026 patterns

---

## Server vs Client Components

**Default: Server Component.** Add `'use client'` only when you need:

- `useState`, `useReducer`, `useContext`
- `useEffect`, `useLayoutEffect`, `useRef`
- Browser APIs (`window`, `document`, `navigator`)
- Event handlers (`onClick`, `onChange`, etc.)

**Rule of thumb:** Push `'use client'` as deep into the tree as possible. A page is a Server Component; the interactive button inside it is a Client Component.

```tsx
// ✅ Server Component — data fetching, no interactivity
export default async function AnalysisPage({ params }: { params: { jobId: string } }) {
  const job = await getJob(params.jobId) // direct DB/service call, no fetch needed
  return <FindingsPanel job={job} />
}

// ✅ Client Component — only the interactive part
;('use client')
export function FindingsPanel({ job }: { job: Job }) {
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  // ...
}
```

---

## File Structure Rules

**Route Handlers vs Server Actions:**

- `app/api/` → Route Handlers for: webhooks, SSE streams, public API, GitHub OAuth callbacks, anything that needs a raw HTTP response
- `features/*/actions.ts` → Server Actions for: form submissions, mutations, authenticated data fetching, anything that triggers from a form or button

```
app/
├── (public)/
│   └── page.tsx                    # Landing + paste mode
├── (auth)/
│   ├── layout.tsx                  # GitHub OAuth guard
│   ├── dashboard/page.tsx
│   └── analysis/[jobId]/page.tsx
├── api/
│   ├── analyze/route.ts            # POST: create analysis job
│   ├── jobs/[id]/route.ts          # GET: job status (polling, v1)
│   ├── jobs/[id]/stream/route.ts   # GET: SSE stream (v2)
│   ├── github/
│   │   ├── repos/route.ts          # GET: list user repos
│   │   └── pr/route.ts             # POST: create PR
│   └── auth/[...nextauth]/route.ts # NextAuth handler
└── layout.tsx
```

**Feature folder structure** (used for components + logic scoped to a feature):

```
features/
├── analyze/
│   ├── components/         # UI components for this feature only
│   ├── actions.ts          # Server Actions
│   ├── hooks.ts            # Client-side hooks
│   └── types.ts            # Feature-local types
├── review/
│   ├── components/
│   ├── actions.ts
│   └── types.ts
├── github/
│   ├── components/         # Repo selector, PR status
│   ├── actions.ts          # Connect repo, create PR
│   └── client.ts           # Octokit wrapper (server-only)
└── settings/
    ├── components/
    └── actions.ts
```

**Promotion rule:** If a component is used in two features, move it to `components/`. If a type is shared across features, move it to `types/`.

---

## Exports

```tsx
// ✅ Named exports for all components, hooks, utilities
export function FindingCard({ finding }: Props) { ... }
export function useJobPolling(jobId: string) { ... }
export function formatSeverity(severity: Severity): string { ... }

// ✅ Default exports ONLY for Next.js special files
export default function Page() { ... }        // page.tsx
export default function Layout() { ... }      // layout.tsx
export default function Loading() { ... }     // loading.tsx
export default function ErrorBoundary() { ... } // error.tsx
```

---

## TypeScript

- Strict mode, always. `tsconfig.json` has `"strict": true`.
- No `any`. Use `unknown` and narrow it, or find the actual type.
- Types for API responses live in `types/api.ts`. Types for domain objects live in `types/domain.ts`.
- Zod for runtime validation at API boundaries (incoming webhooks, LLM responses, GitHub API responses).

```ts
// ✅ Validate at the boundary
import { z } from 'zod'

const AnalyzeRequestSchema = z.object({
  spec: z.string().min(1),
  mode: z.enum(['lint', 'fix']).default('lint'),
  mismatchMode: z.enum(['flag', 'fix']).default('flag'),
})

export async function POST(req: Request) {
  const body = AnalyzeRequestSchema.parse(await req.json())
  // body is typed correctly from here
}
```

---

## SSE Implementation (v2)

```ts
// app/api/jobs/[id]/stream/route.ts
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      try {
        for await (const event of runAnalysis(params.id)) {
          emit(event.type, event.data)
        }
        emit('analysis_complete', { jobId: params.id })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
```

**Client-side (v2):**

```ts
'use client'
export function useAnalysisStream(jobId: string) {
  useEffect(() => {
    const es = new EventSource(`/api/jobs/${jobId}/stream`)
    es.addEventListener('finding', (e) => {
      /* update findings state */
    })
    es.addEventListener('analysis_complete', () => es.close())
    return () => es.close()
  }, [jobId])
}
```

---

## GitHub OAuth + Repo Connection (Heroku/Vercel-style flow)

The intended UX: user clicks "Connect GitHub", authorises the app, sees a dropdown of their repos, selects one, and the app is now connected to that repo — just like Heroku's GitHub integration or Vercel's import flow.

**Implementation:**

1. NextAuth.js with GitHub provider handles OAuth, stores `access_token` in session
2. After OAuth, fetch repos via GitHub API using the session token
3. Store the selected repo + branch in the user's session or a lightweight DB record
4. All subsequent GitHub operations (fetch spec file, find handlers, create PR) use the stored repo context

**Repo selector component:**

- Shows repos the user has access to (paginated, searchable)
- Lets user pin a branch (defaults to default branch)
- Lets user specify the OpenAPI spec file path within the repo
- Lets user specify route file paths (for v2 codebase grounding)

**Key scopes needed in GitHub OAuth app:**

- `repo` — to read private repos, push branches, create PRs
- `read:user` — for user identity

---

## Data Fetching Patterns

```tsx
// ✅ Server Component: fetch directly, no useEffect
async function JobPage({ params }: { params: { id: string } }) {
  const job = await db.jobs.findById(params.id) // or fetch('/api/jobs/...')
  return <JobView job={job} />
}

// ✅ Client Component with React Query for polling (v1)
;('use client')
function JobPoller({ jobId }: { jobId: string }) {
  const { data } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => fetch(`/api/jobs/${jobId}`).then((r) => r.json()),
    refetchInterval: (data) => (data?.status === 'complete' ? false : 2000),
  })
}
```

---

## Styling

- Tailwind CSS utility classes only
- shadcn/ui for all base components (Button, Card, Dialog, Tabs, Badge, etc.) — install via CLI, customise in `components/ui/`
- No CSS Modules, no plain CSS files, no styled-components
- Dark mode via Tailwind's `dark:` variant; class strategy in `tailwind.config.ts`

---

## Commands Reference

```bash
npx shadcn@latest add button   # add a shadcn component
npm run dev                    # dev server on :3000
npm run build                  # production build
npm run typecheck              # tsc --noEmit (run before every PR)
npm run lint                   # ESLint
npm run test                   # Vitest
npm run test:ui                # Vitest UI
```

---

## Environment Variables

Never access `process.env` in Client Components. All env var access goes through Server Components, Route Handlers, or Server Actions.

Public variables (safe for client) use `NEXT_PUBLIC_` prefix. LLM credentials and GitHub secrets never use this prefix.

```ts
// ✅ Server-side only
const llmToken = process.env.LLM_API_TOKEN // never in 'use client' files

// ✅ Public (fine to expose)
const appUrl = process.env.NEXT_PUBLIC_APP_URL
```

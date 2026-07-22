#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Octokit } from '@octokit/rest'
import { sidecarPathFor } from '@/lib/engine/cache/sidecar'
import { EXIT_CODES } from '@/lib/engine/constants'
import { type IssueCommentApi, upsertStickyComment } from '@/lib/github/comments'
import { type ReviewApi, type ReviewCommentInput, syncPrReview } from '@/lib/github/review'
import {
  closeFixPrForAbandonedSource,
  closeFixPrIfObsolete,
  ensureStackedFixPr,
  repointOrCloseFixPr,
  type StackedPrApi,
} from '@/lib/github/stacked-pr'
import type { AnalysisReport } from '@/types/api'
import type { ConfidenceThreshold, MismatchMode } from '@/types/domain'
import { aiCapabilityFromEnv, runScan } from './commands/scan'
import { effectiveBehavior, loadPrContext } from './gh/context'
import { diffReports } from './gh/delta'
import { changedFilesViaGit, detectDirection, DirectionError } from './gh/direction'
import { detectSpecPath, discoverRouteFiles, expandRoutePaths } from './gh/discover'
import {
  aiAllowedForStrategy,
  behaviorAtLeast,
  closedLifecycleAction,
  defaultFailOn,
  deltaGateSummary,
  extractAgentFailures,
  findingMarkerKey,
  inlineCommentBody,
  isPermissionDenied,
  isPrCreationForbidden,
  isSafeGitRef,
  locateFindings,
  mdCell,
  neutralizeMentions,
  parseAppliedFixCount,
  parseBehavior,
  parseChoice,
  renamedFrom,
  renderNewFindingsSection,
  resolveGithubToken,
  selectionFromFindings,
} from './gh/orchestrate'
import type { PrContext } from './gh/types'
import { renderAnnotations } from './render/annotations'
import { renderStickyComment } from './render/comment'
import { type FailOn, failOnGate, renderJobSummary } from './render/summary'

/**
 * GitHub Action entry point — a thin I/O shell over `cli/gh/orchestrate.ts`.
 *
 * Non-PR events keep the historical behavior: plain scan (lint or fix per the
 * `mode` input) + Job Summary + `fail-on` gate on the full report. PR events
 * run the behavior ladder (`docs/ideas/github-action-pr-mode.md`): delta-gated
 * annotations, sticky comment, inline review, stacked fix PR — each level
 * cumulative.
 */
const execFileAsync = promisify(execFile)

const CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const
const MISMATCH_VALUES = ['flag', 'fix'] as const
const FAIL_ON_VALUES = ['error', 'warning', 'never'] as const
const MODE_VALUES = ['lint', 'fix'] as const
const FIX_SCOPE_VALUES = ['pr', 'full'] as const

function input(name: string): string | undefined {
  const value = process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`]
  return value && value.length > 0 ? value : undefined
}

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

/** Enum-valued input: unset → undefined (caller defaults), unknown → INVALID_ARGS. */
function choiceInput<T extends string>(name: string, allowed: readonly T[]): T | undefined {
  const parsed = parseChoice(input(name), allowed)
  if (!parsed.ok) fail(`Invalid ${name} input: ${parsed.message}`, EXIT_CODES.INVALID_ARGS)
  return parsed.value
}

/** Comma-separated `route-paths` input with directory entries expanded to files. */
async function routePathsFromInput(workspace: string): Promise<string[] | undefined> {
  const raw = input('route-paths')
  if (!raw) return undefined
  const entries = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  return expandRoutePaths(workspace, entries)
}

/** Run git in the workspace; never throws — non-zero exits are returned. */
async function git(
  workspace: string,
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: workspace,
      maxBuffer: 64 * 1024 * 1024,
    })
    return { stdout, exitCode: 0 }
  } catch (error) {
    const failed = error as { stdout?: string; code?: number }
    return {
      stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
      exitCode: typeof failed.code === 'number' ? failed.code : 1,
    }
  }
}

async function writeJobSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    await appendFile(summaryPath, markdown)
  } else {
    process.stdout.write(markdown)
  }
}

function jobSummaryUrl(env: Record<string, string | undefined>): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = env
  return server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : undefined
}

// ---------------------------------------------------------------------------
// Octokit → narrow structural APIs. Explicit adapters keep the src/lib modules
// testable with plain fakes and this file free of casts.
// ---------------------------------------------------------------------------

function commentApi(octokit: Octokit): IssueCommentApi {
  return {
    issues: {
      listComments: (p) => octokit.rest.issues.listComments(p),
      createComment: (p) => octokit.rest.issues.createComment(p),
      updateComment: (p) => octokit.rest.issues.updateComment(p),
    },
  }
}

function reviewApi(octokit: Octokit): ReviewApi {
  return {
    pulls: {
      listReviewComments: (p) => octokit.rest.pulls.listReviewComments(p),
      createReview: (p) => octokit.rest.pulls.createReview(p),
      createReviewComment: (p) => octokit.rest.pulls.createReviewComment(p),
      deleteReviewComment: (p) => octokit.rest.pulls.deleteReviewComment(p),
    },
  }
}

function stackedPrApi(octokit: Octokit): StackedPrApi {
  return {
    git: {
      getRef: (p) => octokit.rest.git.getRef(p),
      createRef: (p) => octokit.rest.git.createRef(p),
      updateRef: (p) => octokit.rest.git.updateRef(p),
      getBlob: (p) => octokit.rest.git.getBlob(p),
    },
    repos: {
      getContent: (p) => octokit.rest.repos.getContent(p),
      createOrUpdateFileContents: (p) => octokit.rest.repos.createOrUpdateFileContents(p),
    },
    pulls: {
      list: (p) => octokit.rest.pulls.list(p),
      create: (p) => octokit.rest.pulls.create(p),
      update: (p) => octokit.rest.pulls.update(p),
    },
    issues: {
      createComment: (p) => octokit.rest.issues.createComment(p),
    },
  }
}

// ---------------------------------------------------------------------------
// Non-PR mode (workflow_dispatch / push) — the historical plain scan.
// ---------------------------------------------------------------------------

async function runPlainScan(
  specPath: string,
  failOn: FailOn,
  opts?: { forceLint?: boolean },
): Promise<never> {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
  const routePaths = await routePathsFromInput(workspace)
  const requestedMode = choiceInput('mode', MODE_VALUES) ?? 'lint'
  // PR fallback (direction detection unavailable): a fix-mode run would
  // silently rewrite the spec in the workspace on a PR AND green-light the
  // gate — never apply fixes there, only lint.
  const mode = opts?.forceLint === true ? 'lint' : requestedMode
  if (opts?.forceLint === true && requestedMode === 'fix') {
    process.stdout.write(
      '::warning ::MCP Doctor: mode "fix" ignored — change-direction detection was ' +
        'unavailable for this PR, and the fallback scan must never rewrite the spec. ' +
        'Running lint only.\n',
    )
  }
  const mismatchMode: MismatchMode = choiceInput('mismatch-mode', MISMATCH_VALUES) ?? 'flag'
  const ai = aiCapabilityFromEnv(process.env)

  if (mode === 'fix') {
    const confidenceThreshold = choiceInput('confidence-threshold', CONFIDENCE_VALUES) ?? 'high'
    if (confidenceThreshold === 'low') {
      process.stdout.write(
        '::warning ::MCP Doctor AGGRESSIVE MODE — LOW-confidence fixes (including spec/code ' +
          'mismatches) are auto-applied. Review every change before committing.\n',
      )
    }
    // Fix mode rewrites the spec file in the workspace so a later workflow
    // step can commit or artifact it.
    const result = await runScan({
      specPath,
      mode: 'fix',
      confidenceThreshold,
      mismatchMode,
      outputPath: specPath,
      mcpVersion: input('mcp-version'),
      routePaths,
      ai,
    })
    if (result.exitCode === 2) fail(result.stdout, 2)
    await writeJobSummary(`## ⚕ MCP Doctor — Fix Mode\n\n\`\`\`\n${result.stdout}\n\`\`\`\n`)
    process.exit(0)
  }

  const result = await runScan({
    specPath,
    json: true,
    mcpVersion: input('mcp-version'),
    mismatchMode,
    routePaths,
    ai,
  })

  if (result.exitCode === 2) fail(result.stdout, 2)

  const report = JSON.parse(result.stdout) as AnalysisReport
  await writeJobSummary(renderJobSummary(report))
  process.exit(failOnGate(failOn, report.summary) ? 1 : 0)
}

// ---------------------------------------------------------------------------
// PR mode
// ---------------------------------------------------------------------------

/** `git diff` against origin/<base>; on a shallow clone, fetch the base and retry once. */
async function changedFiles(workspace: string, ctx: PrContext): Promise<string[] | undefined> {
  if (!isSafeGitRef(ctx.baseRef) || !isSafeGitRef(ctx.headSha)) {
    fail(
      `Refusing to pass unsafe git ref to git: ${ctx.baseRef} / ${ctx.headSha}`,
      EXIT_CODES.INVALID_ARGS,
    )
  }
  const exec = (cmd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> =>
    cmd === 'git' ? git(workspace, args) : Promise.reject(new Error(`unexpected command ${cmd}`))
  try {
    return await changedFilesViaGit(`origin/${ctx.baseRef}`, ctx.headSha, exec)
  } catch (error) {
    if (!(error instanceof DirectionError)) throw error
    await git(workspace, ['fetch', 'origin', ctx.baseRef, '--depth=1'])
    try {
      return await changedFilesViaGit(`origin/${ctx.baseRef}`, ctx.headSha, exec)
    } catch {
      return undefined
    }
  }
}

/** Spec deleted at the PR head: skip scanning, close any stale fix PR, exit 0. */
async function handleMissingHeadSpec(
  specPath: string,
  ctx: PrContext,
  behavior: string,
  token: string | undefined,
): Promise<never> {
  process.stdout.write(
    `::notice ::MCP Doctor: spec '${specPath}' does not exist at the PR head ` +
      '(deleted in this PR?) — nothing to scan.\n',
  )
  await writeJobSummary(
    `## ⚕ MCP Doctor\n\nSpec \`${specPath}\` does not exist at the PR head — analysis skipped.\n`,
  )
  if (behavior === 'fix-pr' && token !== undefined && !ctx.isFork) {
    const outcome = await closeFixPrIfObsolete(stackedPrApi(new Octokit({ auth: token })), {
      owner: ctx.owner,
      repo: ctx.repo,
      sourceBranch: ctx.headRef,
    })
    if (outcome === 'closed') {
      process.stdout.write('MCP Doctor: closed the now-obsolete stacked fix PR.\n')
    }
  }
  process.exit(0)
}

async function runPrMode(specPath: string, ctx: PrContext): Promise<never> {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
  const requested = parseBehavior(input('behavior'))
  if (requested === undefined) {
    fail(
      `Invalid behavior input: ${input('behavior')} (summary | comment | review | fix-pr)`,
      EXIT_CODES.INVALID_ARGS,
    )
  }
  const token = resolveGithubToken(input('github-token'), process.env)
  const expectedAuthor = input('bot-login')
  const behavior = effectiveBehavior(requested, {
    isFork: ctx.isFork,
    hasToken: token !== undefined,
  })
  if (behavior !== requested) {
    process.stdout.write(
      `::notice ::MCP Doctor: behavior degraded from '${requested}' to '${behavior}' — ` +
        (ctx.isFork
          ? 'fork PRs get a read-only token and no secrets.'
          : 'no GitHub token provided.') +
        '\n',
    )
  }

  // A spec deleted by this PR must not hard-fail the run.
  const headSpecText = await readFile(specPath, 'utf8').catch(() => undefined)
  if (headSpecText === undefined) {
    return handleMissingHeadSpec(specPath, ctx, behavior, token)
  }

  // What did the PR touch? Without a diff we cannot delta-gate honestly, so a
  // broken git state falls back to the plain scan (Job Summary only).
  const changed = await changedFiles(workspace, ctx)
  if (changed === undefined) {
    process.stdout.write(
      `::warning ::MCP Doctor: could not diff origin/${ctx.baseRef}...${ctx.headSha} ` +
        '(is the checkout too shallow? use fetch-depth: 0) — falling back to a plain scan.\n',
    )
    return runPlainScan(specPath, choiceInput('fail-on', FAIL_ON_VALUES) ?? defaultFailOn(true), {
      forceLint: true,
    })
  }

  // A spec renamed by the PR: resolve its OLD path up front — direction needs
  // it to recognise the rename as a spec change, and the base scan reads the
  // spec from that path on the base branch.
  const nameStatus = await git(workspace, [
    'diff',
    '--name-status',
    `origin/${ctx.baseRef}...${ctx.headSha}`,
  ])
  const specOldPath =
    nameStatus.exitCode === 0 ? renamedFrom(nameStatus.stdout, specPath) : undefined
  const direction = detectDirection({
    changedFiles: changed,
    specPath,
    ...(specOldPath !== undefined ? { specRenamedFrom: specOldPath } : {}),
  })

  // lint-only PRs must cost zero LLM calls.
  const ai = aiAllowedForStrategy(direction.strategy) ? aiCapabilityFromEnv(process.env) : undefined

  const routePaths =
    (await routePathsFromInput(workspace)) ??
    (ai?.runGrounding ? await discoverRouteFiles(workspace) : undefined)

  const scratchDir = await mkdtemp(path.join(tmpdir(), 'mcp-doctor-'))
  const mcpVersion = input('mcp-version')
  const mismatchMode: MismatchMode = choiceInput('mismatch-mode', MISMATCH_VALUES) ?? 'flag'

  // Base scan with the SAME ai capability AND the same route files as the head
  // scan, so findings on operations this PR never touched exist on both sides
  // and cancel out in the delta — without routePaths here, grounding
  // (SPEC_CODE_*) findings only ever existed on the head side and were ALL
  // labeled "New in this PR". The route files come from the HEAD checkout;
  // that is deliberate: the delta answers "what changed for THIS PR's code",
  // so both spec versions are compared against the same (head) grounding
  // source. A spec renamed by the PR is read from its OLD path on the base
  // branch; a missing base spec (new file) legitimately means every head
  // finding is new.
  let baseReport: AnalysisReport | undefined
  let baseScanDegraded = false
  const basePathOfSpec = specOldPath ?? specPath
  const shownBase = await git(workspace, ['show', `origin/${ctx.baseRef}:${basePathOfSpec}`])
  if (shownBase.exitCode === 0) {
    const baseSpecPath = path.join(scratchDir, `base-${path.basename(basePathOfSpec)}`)
    await writeFile(baseSpecPath, shownBase.stdout)
    const baseScan = await runScan({
      specPath: baseSpecPath,
      json: true,
      mcpVersion,
      mismatchMode,
      routePaths,
      ai,
    })
    // Base-scan AI failures fail soft into a structural-only base report —
    // which would silently label every pre-existing AI finding as new. Surface
    // it and mark the delta as unreliable in the sticky comment below.
    const baseFailures = extractAgentFailures(baseScan.stderr)
    if (baseFailures.length > 0) {
      baseScanDegraded = true
      for (const failure of baseFailures) {
        process.stdout.write(`::warning ::MCP Doctor AI agent (base scan) ${failure}\n`)
      }
    }
    if (baseScan.exitCode !== 2) baseReport = JSON.parse(baseScan.stdout) as AnalysisReport
  }

  // A `.mcp-doctor.yaml` sidecar committed in the consumer repo is untrusted
  // input: with a matching spec hash it would be served back verbatim as
  // "fresh" findings (frozen or outright spoofed). CI is stateless, so delete
  // any pre-existing sidecar before the head scan. The ONLY intra-run reuse
  // that matters — head scan → fix pass, zero extra LLM calls — is preserved:
  // the head scan below rewrites the sidecar itself from its own fresh
  // results, and the fix pass reads that trusted, this-run copy.
  await rm(sidecarPathFor(specPath), { force: true })

  // Head scan. The sidecar cache keeps the optional fix pass below from
  // paying for the same LLM analysis twice.
  const headScan = await runScan({
    specPath,
    json: true,
    mcpVersion,
    mismatchMode,
    routePaths,
    ai,
    cache: true,
  })
  if (headScan.exitCode === 2) fail(headScan.stdout, 2)
  const headReport = JSON.parse(headScan.stdout) as AnalysisReport

  // AI workers fail soft (structural findings still ship) — but a silent
  // fallback would let "AI never ran" masquerade as a clean AI pass.
  const agentFailures = extractAgentFailures(headScan.stderr)
  for (const failure of agentFailures) {
    process.stdout.write(`::warning ::MCP Doctor AI agent ${failure}\n`)
  }

  // Delta BEFORE the fix pass: PR-scoped fixing must know which findings this
  // PR introduced. The head scan above already populated the sidecar cache, so
  // running the fix pass after the delta costs no extra LLM work.
  const delta = diffReports(baseReport, headReport)

  // fix-pr level: capture the patched spec from a fix-mode pass. Default scope
  // 'pr' fixes only the operations carrying findings this PR introduced —
  // 'full' opts back into patching the whole spec's debt.
  const confidenceThreshold: ConfidenceThreshold =
    choiceInput('confidence-threshold', CONFIDENCE_VALUES) ?? 'high'
  const fixScope = choiceInput('fix-scope', FIX_SCOPE_VALUES) ?? 'pr'
  let patched: string | undefined
  let appliedFixCount: number | undefined
  if (behavior === 'fix-pr') {
    const selection = fixScope === 'pr' ? selectionFromFindings(delta.newFindings) : undefined
    if (fixScope === 'pr' && selection === undefined) {
      // No PR-introduced finding is anchored to an operation — nothing in this
      // PR's scope to fix. Skip the fix scan entirely; `patched` stays
      // undefined, so the obsolete-fix-PR close path below takes over.
      process.stdout.write(
        'MCP Doctor: fix-scope is "pr" and this PR introduced no operation-level findings — ' +
          'skipping the fix pass.\n',
      )
    } else {
      const patchedPath = path.join(scratchDir, `patched-${path.basename(specPath)}`)
      // Cache note: the sidecar written by the head scan is keyed by spec hash
      // alone and holds FULL-spec results; a selection-scoped fix run consumes
      // it read-only (runScan narrows the cached findings to the selection and
      // never writes scoped results back), so the cached AI analysis is still
      // reused here without risking wrong full-spec reuse later.
      const fixScan = await runScan({
        specPath,
        mode: 'fix',
        confidenceThreshold,
        mismatchMode,
        outputPath: patchedPath,
        mcpVersion,
        routePaths,
        ai,
        cache: true,
        ...(selection !== undefined ? { selection } : {}),
      })
      if (fixScan.exitCode !== 2) {
        patched = await readFile(patchedPath, 'utf8').catch(() => undefined)
        appliedFixCount = parseAppliedFixCount(fixScan.stdout)
      }
      if (confidenceThreshold === 'low') {
        process.stdout.write(
          '::warning ::MCP Doctor AGGRESSIVE MODE — LOW-confidence fixes (including spec/code ' +
            'mismatches) are auto-applied to the fix PR. Review every change before merging.\n',
        )
      }
    }
  }

  // Job Summary: full report (pre-existing debt lives here) + the delta section.
  await writeJobSummary(
    `${renderJobSummary(headReport)}\n${renderNewFindingsSection(delta.newFindings)}`,
  )

  // summary level+: workflow-command annotations on the new findings.
  const located = locateFindings(delta.newFindings, headSpecText, specPath)
  for (const annotation of renderAnnotations(located)) {
    process.stdout.write(`${annotation}\n`)
  }

  let fixPr: { url: string; number: number } | undefined
  let skippedInline: number | undefined

  if (behaviorAtLeast(behavior, 'comment') && token !== undefined) {
    const octokit = new Octokit({ auth: token })

    // review level+: inline comments, synced against the previous push. The
    // stable key (finding identity, not the LLM wording) keeps unchanged
    // findings' comments in place across pushes.
    if (behaviorAtLeast(behavior, 'review')) {
      const comments: ReviewCommentInput[] = []
      let unplaceable = 0
      for (const item of located) {
        if (item.line === undefined) {
          unplaceable++
          continue
        }
        comments.push({
          key: findingMarkerKey(item.finding),
          path: item.file,
          line: item.line,
          body: inlineCommentBody(item.finding),
        })
      }
      const sync = await syncPrReview(reviewApi(octokit), {
        owner: ctx.owner,
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        commitSha: ctx.headSha,
        comments,
        ...(expectedAuthor !== undefined ? { expectedAuthor } : {}),
      })
      skippedInline = sync.skipped.length + unplaceable
    }

    // fix-pr level: stacked PR carrying the patched spec — or, when this push
    // left nothing to patch, close the now-obsolete fix PR from earlier pushes.
    let fixPrBlocked: 'creation-forbidden' | 'permission-denied' | undefined
    if (behavior === 'fix-pr') {
      if (patched !== undefined && patched !== headSpecText) {
        try {
          fixPr = await ensureStackedFixPr(stackedPrApi(octokit), {
            owner: ctx.owner,
            repo: ctx.repo,
            sourceBranch: ctx.headRef,
            specPath,
            patchedContent: patched,
            title: `MCP Doctor: spec fixes for ${ctx.headRef}`,
            body:
              `Automated OpenAPI spec fixes for #${ctx.prNumber} (confidence threshold: ` +
              `\`${confidenceThreshold}\`; ${
                fixScope === 'pr'
                  ? 'scoped to operations with findings this PR introduced'
                  : 'whole spec'
              }). Merge this into \`${ctx.headRef}\` to apply them.\n\n` +
              '🤖 Opened by [MCP Doctor](https://github.com/TykTechnologies/openapi-to-mcp-doctor)',
          })
        } catch (error) {
          // Two normal, permission-shaped 403 conditions degrade to review
          // level instead of crashing (a throw here lands AFTER review sync
          // but BEFORE the sticky comment ever posts): the repo setting that
          // blocks Actions from creating PRs, and a workflow token missing
          // `contents: write` (git.createRef throws "Resource not accessible
          // by integration"). Anything else is a real failure — rethrow.
          if (isPrCreationForbidden(error)) {
            fixPrBlocked = 'creation-forbidden'
            process.stdout.write(
              '::warning::MCP Doctor: behavior "fix-pr" requested, but this repository does not ' +
                'allow GitHub Actions to create pull requests. Enable it under Settings → Actions → ' +
                'General → "Allow GitHub Actions to create and approve pull requests". ' +
                'Continuing at "review" level.\n',
            )
          } else if (isPermissionDenied(error)) {
            fixPrBlocked = 'permission-denied'
            process.stdout.write(
              '::warning::MCP Doctor: behavior "fix-pr" requested, but the workflow token cannot ' +
                'push the fix branch (403 permission denied). Grant `contents: write` in the ' +
                'workflow\'s `permissions:` block. Continuing at "review" level.\n',
            )
          } else {
            throw error
          }
        }
      } else {
        const outcome = await closeFixPrIfObsolete(stackedPrApi(octokit), {
          owner: ctx.owner,
          repo: ctx.repo,
          sourceBranch: ctx.headRef,
        })
        if (outcome === 'closed') {
          process.stdout.write(
            'MCP Doctor: no fixes needed on this push — closed the stale fix PR.\n',
          )
        }
      }
    }

    // comment level+: sticky comment, rendered AFTER review sync so the
    // skipped-inline count folds in.
    let body = renderStickyComment({
      delta,
      direction,
      report: headReport,
      behavior,
      fixPr,
      appliedFixCount,
      skippedInline,
      jobSummaryUrl: jobSummaryUrl(process.env),
      fixScope,
    })
    if (agentFailures.length > 0) {
      const first = neutralizeMentions(agentFailures[0] ?? '')
      body +=
        `\n> ⚠️ **AI analysis degraded** — ${agentFailures.length} agent(s) failed ` +
        `(\`${mdCell(first)}\`). The findings above may be structural-only; check the ` +
        'workflow log and the `llm-base-url` / `llm-model` inputs.\n'
    }
    if (baseScanDegraded) {
      body +=
        '\n> ⚠️ **Base scan degraded** — AI agent(s) failed while scanning the base branch, so ' +
        'its report may be structural-only. New-finding attribution above may include ' +
        'pre-existing issues; check the workflow log.\n'
    }
    if (fixPrBlocked === 'creation-forbidden') {
      body +=
        '\n> ⚠️ **Fix PR unavailable** — this repository does not allow GitHub Actions to ' +
        'create pull requests. Enable it under *Settings → Actions → General → “Allow GitHub ' +
        'Actions to create and approve pull requests”* to receive automated spec-fix PRs.\n'
    } else if (fixPrBlocked === 'permission-denied') {
      body +=
        '\n> ⚠️ **Fix PR unavailable** — the workflow token cannot push the fix branch. Grant ' +
        '`contents: write` (plus `pull-requests: write`) in the workflow’s `permissions:` block ' +
        'to receive automated spec-fix PRs.\n'
    }
    if (behavior === 'fix-pr' && confidenceThreshold === 'low') {
      body +=
        '\n> ⚠️ **AGGRESSIVE MODE** — the fix PR includes LOW-confidence fixes ' +
        '(spec/code mismatches auto-corrected, code treated as source of truth). ' +
        'Review every change before merging.\n'
    }
    await upsertStickyComment(commentApi(octokit), {
      owner: ctx.owner,
      repo: ctx.repo,
      issueNumber: ctx.prNumber,
      body,
      ...(expectedAuthor !== undefined ? { expectedAuthor } : {}),
    })
  }

  // The CI gate judges only what this PR introduced, never pre-existing debt.
  const failOn = choiceInput('fail-on', FAIL_ON_VALUES) ?? defaultFailOn(true)
  process.exit(failOnGate(failOn, deltaGateSummary(delta.newFindings)) ? 1 : 0)
}

/** Source PR closed: re-point (merged) or close (abandoned) the stacked fix PR. */
async function runClosedLifecycle(specPath: string, ctx: PrContext): Promise<never> {
  const token = resolveGithubToken(input('github-token'), process.env)
  if (token === undefined || ctx.isFork) {
    process.stdout.write('MCP Doctor: PR closed — no token or fork PR, nothing to do.\n')
    process.exit(0)
  }
  const octokit = new Octokit({ auth: token })
  if (closedLifecycleAction(ctx.merged) === 'repoint') {
    // Merged: the source branch's content landed on the base branch, so
    // surviving fixes can be re-pointed there and land on their own.
    const outcome = await repointOrCloseFixPr(stackedPrApi(octokit), {
      owner: ctx.owner,
      repo: ctx.repo,
      sourceBranch: ctx.headRef,
      newBaseRef: ctx.baseRef,
      specPath,
    })
    process.stdout.write(`MCP Doctor: PR merged — fix PR lifecycle: ${outcome}.\n`)
    process.exit(0)
  }
  // Closed WITHOUT merging (or merged state unknown): the source branch was
  // abandoned. Re-pointing would propose the abandoned branch's spec content
  // into the base branch — close the fix PR instead.
  const outcome = await closeFixPrForAbandonedSource(stackedPrApi(octokit), {
    owner: ctx.owner,
    repo: ctx.repo,
    sourceBranch: ctx.headRef,
  })
  process.stdout.write(`MCP Doctor: PR closed without merging — fix PR lifecycle: ${outcome}.\n`)
  process.exit(0)
}

async function main(): Promise<void> {
  // Validate every enum-valued input up front: a typo'd knob must fail fast
  // with INVALID_ARGS on every event path, not silently coerce to a default.
  if (parseBehavior(input('behavior')) === undefined) {
    fail(
      `Invalid behavior input: '${input('behavior')}' (summary | comment | review | fix-pr)`,
      EXIT_CODES.INVALID_ARGS,
    )
  }
  choiceInput('mode', MODE_VALUES)
  choiceInput('confidence-threshold', CONFIDENCE_VALUES)
  choiceInput('mismatch-mode', MISMATCH_VALUES)
  choiceInput('fail-on', FAIL_ON_VALUES)
  choiceInput('fix-scope', FIX_SCOPE_VALUES)

  // Surface LLM creds (provided as action inputs) to the engine's env contract.
  const baseUrl = input('llm-base-url')
  const apiToken = input('llm-api-token')
  const llmModel = input('llm-model')
  if (baseUrl) process.env.LLM_BASE_URL = baseUrl
  if (apiToken) process.env.LLM_API_TOKEN = apiToken
  if (llmModel) process.env.LLM_MODEL = llmModel

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
  // Repo-relative, no leading ./ — used for git show, annotations, and review paths.
  const specPath = (input('spec') ?? (await detectSpecPath(workspace)))?.replace(/^\.\//, '')
  if (!specPath) {
    fail(
      'No spec input and no OpenAPI spec found in the workspace (looked for openapi/swagger *.yaml|*.json).',
      EXIT_CODES.INVALID_ARGS,
    )
  }

  const ctx = await loadPrContext(process.env)
  if (ctx?.eventName === 'pull_request_target') {
    process.stdout.write(
      '::warning ::MCP Doctor: running on pull_request_target — the base-branch workflow runs ' +
        'with secrets against an UNTRUSTED head. Never build or execute head code in this ' +
        'workflow; prefer the plain pull_request event.\n',
    )
  }
  // Recursion guard: never run the doctor on its own stacked fix PR.
  if (ctx && ctx.headRef.endsWith('-mcp-doctor-fixes')) {
    process.stdout.write(
      `MCP Doctor: head branch '${ctx.headRef}' is an MCP Doctor fix branch — skipping.\n`,
    )
    process.exit(0)
  }
  if (!ctx) {
    // workflow_dispatch / push — historical behavior, gate on the full report.
    return runPlainScan(specPath, choiceInput('fail-on', FAIL_ON_VALUES) ?? defaultFailOn(false))
  }
  if (ctx.eventAction === 'closed') {
    return runClosedLifecycle(specPath, ctx)
  }
  return runPrMode(specPath, ctx)
}

main().catch((error: unknown) => {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\r?\n/g, ' ')
  process.stderr.write(`::error ::MCP Doctor: ${message}\n`)
  process.exit(EXIT_CODES.ANALYSIS_FAILED)
})

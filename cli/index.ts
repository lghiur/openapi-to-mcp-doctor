#!/usr/bin/env node
import { Command, CommanderError } from 'commander'
import { MCP_VERSION } from '@/lib/engine/constants'
import { EXIT_CODES } from '@/lib/engine/constants'
import { renderDiff } from './commands/diff'
import { renderHistoryDetail, renderHistoryList } from './commands/history'
import { aiCapabilityFromEnv, runScan } from './commands/scan'

function parseThreshold(value: unknown): 'high' | 'medium' | 'low' {
  return value === 'medium' || value === 'low' ? value : 'high'
}

function buildProgram(): Command {
  const program = new Command()
  program
    .name('mcp-doctor')
    .description('Analyze OpenAPI specs for MCP/LLM-agent usability.')
    .version('0.1.0', '-v, --version')
    .configureHelp({ showGlobalOptions: true })

  program
    .command('scan')
    .description('Run deterministic structural MCP analysis on an OpenAPI spec.')
    .argument('<spec>', 'path to the OpenAPI spec file (YAML or JSON)')
    .option('--json', 'print the machine-readable JSON report to stdout')
    .option('--report <path>', 'write the JSON report to a file')
    .option('--no-color', 'disable colored output')
    .option('--mcp-version <version>', 'MCP spec version to target', MCP_VERSION)
    .option('--verbose', 'show all findings and agent progress')
    .option('--mode <mode>', 'lint or fix', 'lint')
    .option('--confidence-threshold <level>', 'fix mode gate: high | medium | low', 'high')
    .option('--output <path>', 'write the patched spec here (fix mode)')
    .option('--route-paths <paths>', 'comma-separated handler files for v2 codebase grounding')
    .option('--mismatch-mode <mode>', 'flag | fix (v2)', 'flag')
    .option('--no-cache', 'skip the .mcp-doctor.yaml sidecar cache next to the spec')
    .action(async (spec: string, options: Record<string, unknown>) => {
      const result = await runScan({
        specPath: spec,
        json: options.json === true,
        reportPath: typeof options.report === 'string' ? options.report : undefined,
        color: options.color !== false,
        mcpVersion: typeof options.mcpVersion === 'string' ? options.mcpVersion : undefined,
        verbose: options.verbose === true,
        mode: options.mode === 'fix' ? 'fix' : 'lint',
        confidenceThreshold: parseThreshold(options.confidenceThreshold),
        mismatchMode: options.mismatchMode === 'fix' ? 'fix' : 'flag',
        outputPath: typeof options.output === 'string' ? options.output : undefined,
        routePaths:
          typeof options.routePaths === 'string'
            ? options.routePaths
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean)
            : undefined,
        ai: aiCapabilityFromEnv(process.env),
        cache: options.cache !== false,
      })
      if (result.stderr) process.stderr.write(`${result.stderr}\n`)
      process.stdout.write(`${result.stdout}\n`)
      process.exit(result.exitCode)
    })

  program
    .command('history')
    .description('List recorded analysis runs, or show one run with an id.')
    .argument('[id]', 'run id to show in detail')
    .option('--json', 'print the run as JSON (with an id)')
    .action(async (id: string | undefined, options: Record<string, unknown>) => {
      const baseDir = process.cwd()
      const output = id
        ? await renderHistoryDetail(baseDir, id, { json: options.json === true })
        : await renderHistoryList(baseDir)
      process.stdout.write(`${output.stdout}\n`)
      process.exit(output.exitCode)
    })

  program
    .command('diff')
    .description('Compare a run to the chronologically previous run.')
    .argument('<id>', 'run id to diff')
    .action(async (id: string) => {
      const output = await renderDiff(process.cwd(), id)
      process.stdout.write(`${output.stdout}\n`)
      process.exit(output.exitCode)
    })

  return program
}

async function main(): Promise<void> {
  const program = buildProgram()
  program.exitOverride()
  for (const command of program.commands) command.exitOverride()

  try {
    await program.parseAsync(process.argv)
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help / --version exit cleanly; anything else is an argument error.
      const clean =
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version' ||
        error.code === 'commander.help'
      process.exit(clean ? EXIT_CODES.OK : EXIT_CODES.INVALID_ARGS)
    }
    throw error
  }
}

void main()

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Native module — keep it external rather than bundling it.
  // Spectral uses dynamic requires + a JSONPath (nimma) runtime and worker/resolver
  // internals that hang when bundled by Turbopack; externalizing makes the server
  // load them as native CJS, so `runStructuralAnalysis` resolves (90ms) instead of
  // never resolving and leaving the SSE stream open with zero events.
  serverExternalPackages: [
    'better-sqlite3',
    '@stoplight/spectral-core',
    '@stoplight/spectral-parsers',
    '@stoplight/spectral-rulesets',
    '@stoplight/spectral-ruleset-bundler',
    'nimma',
  ],
  // Pin the workspace root: a stray lockfile in the home dir otherwise makes
  // Turbopack infer the wrong root.
  turbopack: {
    root: projectRoot,
  },
}

export default nextConfig

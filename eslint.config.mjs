import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'
import prettier from 'eslint-config-prettier'

const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'dist/**', 'next-env.d.ts'],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'import/no-default-export': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Next.js special files and config files require default exports.
    files: [
      'src/app/**/page.tsx',
      'src/app/**/layout.tsx',
      'src/app/**/error.tsx',
      'src/app/**/loading.tsx',
      'src/app/**/not-found.tsx',
      'src/app/**/template.tsx',
      'src/app/**/default.tsx',
      'src/app/**/global-error.tsx',
      'src/app/**/route.ts',
      'src/app/**/sitemap.ts',
      'src/app/**/robots.ts',
      'src/app/**/manifest.ts',
      'src/app/**/{opengraph,twitter}-image.tsx',
      'src/app/**/{icon,apple-icon}.tsx',
      '**/*.config.{ts,js,mjs,cjs}',
    ],
    rules: {
      'import/no-default-export': 'off',
    },
  },
  {
    // The engine is a pure, framework-agnostic library. It must never import
    // from the web app, features, shared components, or React hooks.
    files: ['src/lib/engine/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/app',
                '@/app/**',
                '@/features',
                '@/features/**',
                '@/components',
                '@/components/**',
                '@/hooks',
                '@/hooks/**',
                '**/app/**',
                '**/features/**',
                '**/components/**',
              ],
              message:
                'lib/engine must stay framework-agnostic: it must not import from app/, features/, components/, or hooks/. The web app and CLI are consumers of the engine, not peers.',
            },
          ],
        },
      ],
    },
  },
]

export default config

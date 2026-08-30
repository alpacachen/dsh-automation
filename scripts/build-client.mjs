import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  external: ['react', 'react/*', '@deepseek-ai/*'],
  plugins: [{
    name: 'inline-css',
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async ({ path }) => ({
        contents: await readFile(path, 'utf8'),
        loader: 'text',
      }))
    },
  }],
  sourcemap: false,
  legalComments: 'none',
})

const body = result.outputFiles?.[0]?.text
if (body === undefined) throw new Error('esbuild produced no client bundle')

const wrapped = `window.__ModuleLoader__.load({\n  id: "@alpacachen/dsh-automation",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${body.split('\n').map((line) => `    ${line}`).join('\n')}\n    return module.exports;\n  }\n});\n`

await mkdir('lib', { recursive: true })
await writeFile('lib/client.js', wrapped, 'utf8')

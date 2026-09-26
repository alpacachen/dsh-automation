import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { Children, isValidElement, type ReactElement } from 'react'
import ts from 'typescript'
import * as icons from '../src/client/icons.js'

const clientDir = new URL('../src/client/', import.meta.url)

test('all client icons use local exports, with no Host dependency in the icon module', async () => {
  const used = new Set<string>()
  for (const name of await readdir(clientDir, { recursive: true })) {
    if (!/\.tsx?$/.test(name)) continue
    const source = await readFile(new URL(name, clientDir), 'utf8')
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true)
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const binding of bindings.elements) {
        const imported = (binding.propertyName ?? binding.name).text
        if (!/^Icon\w+(14|16)$/.test(imported)) continue
        assert.equal(statement.moduleSpecifier.text, './icons.js', `${name}: ${imported} must be local`)
        assert.equal(typeof icons[imported as keyof typeof icons], 'function', `${imported} must exist`)
        used.add(imported)
      }
    }
  }
  assert.equal(used.size, 24)
  assert.deepEqual([...used].sort(), Object.keys(icons).sort())
  const source = await readFile(new URL('icons.tsx', clientDir), 'utf8')
  assert.doesNotMatch(source, /@deepseek-ai\//)
})

// These static components have no hooks: evaluate their lightweight wrappers
// directly, without adding a renderer dependency just for SVG assertions.
function renderSvg(element: ReactElement<any>): ReactElement<any> {
  while (typeof element.type !== 'string') {
    assert.equal(typeof element.type, 'function')
    element = (element.type as (props: any) => ReactElement<any>)(element.props)
    assert.ok(isValidElement(element))
  }
  assert.equal(element.type, 'svg')
  return element
}

test('all 24 icons render SVG artwork with legacy sizes and decorative semantics', () => {
  assert.equal(Object.keys(icons).length, 24)
  for (const [name, Icon] of Object.entries(icons)) {
    const edge = name.endsWith('14') ? 14 : 16
    for (const props of [{}, { size: undefined, className: undefined }, { size: 24, className: 'am-test-icon' }, { size: 0 }]) {
      const svg = renderSvg(Icon(props))
      assert.equal(svg.props.width, props.size ?? edge, name)
      assert.equal(svg.props.height, props.size ?? edge, name)
      assert.equal(svg.props.className, props.className, name)
      assert.equal(svg.props.viewBox, name === 'IconAlarmClockOutline16' ? '0 0 17 17' : '0 0 16 16', name)
      assert.equal(svg.props.xmlns, 'http://www.w3.org/2000/svg', name)
      assert.equal(svg.props['aria-hidden'], 'true', name)
      assert.equal(svg.props.fill, 'none', name)
      assert.equal(svg.props.strokeWidth, 1, name)
      const artwork = Children.toArray(svg.props.children)
      assert.ok(artwork.length > 0, name)
      for (const child of artwork) {
        assert.ok(isValidElement<any>(child), name)
        assert.ok(child.type === 'path' || child.type === 'rect', name)
        assert.equal(child.props.stroke ?? child.props.fill, 'currentColor', name)
        if (child.type === 'path') assert.match(child.props.d, /^M[\d. -]+/, name)
        else assert.ok(Number(child.props.width) > 0 && Number(child.props.height) > 0, name)
      }
    }
  }
})

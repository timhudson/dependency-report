'use strict'
const { init, parse } = require('es-module-lexer')
const validatePackageName = require('validate-npm-package-name')
const stripComments = require('strip-comments')

// [@\w] - Match a word-character or @ (valid package name)
// (?!.*(:\/\/)) - Ignore if previous match was a protocol (ex: http://)
const BARE_SPECIFIER_REGEX = /^[@\w](?!.*(:\/\/))/

const ESM_IMPORT_REGEX = /import(?:["'\s]*([\w*${}\n\r\t, ]+)\s*from\s*)?\s*["'](.*?)["']/gm
const ESM_DYNAMIC_IMPORT_REGEX = /import\((?:['"].+['"]|`[^$]+`)\)/gm
const HAS_NAMED_IMPORTS_REGEX = /^[\w\s,]*{(.*)}/s
const SPLIT_NAMED_IMPORTS_REGEX = /\bas\s+\w+|,/s
const DEFAULT_IMPORT_REGEX = /import\s+(\w+)(,\s{[\w\s]*})?\s+from/s

function cleanCodeForParsing(code) {
  code = stripComments(code)
  const allMatches = []
  let match
  const importRegex = new RegExp(ESM_IMPORT_REGEX)
  while ((match = importRegex.exec(code))) {
    allMatches.push(match)
  }

  const dynamicImportRegex = new RegExp(ESM_DYNAMIC_IMPORT_REGEX)
  while ((match = dynamicImportRegex.exec(code))) {
    allMatches.push(match)
  }

  return allMatches.map(([full]) => full).join('\n')
}

function getSpecifierFromCode(code, imp) {
  // Import.meta: we can ignore
  if (imp.d === -2) {
    return null
  }

  // Static imports: easy to parse
  if (imp.d === -1) {
    return code.slice(imp.s, imp.e)
  }

  // Dynamic imports: a bit trickier to parse. Today, we only support string literals.
  const importStatement = code.slice(imp.s, imp.e)
  const importSpecifierMatch = importStatement.match(/^\s*['"](.*)['"]\s*$/m)
  return importSpecifierMatch ? importSpecifierMatch[1] : null
}

function removeSpecifierQueryString(specifier) {
  const queryStringIndex = specifier.indexOf('?')
  if (queryStringIndex >= 0) {
    specifier = specifier.slice(0, Math.max(0, queryStringIndex))
  }

  return specifier
}

function stripJsExtension(dep) {
  return dep.replace(/\.m?js$/i, '')
}

/**
 * Parses an import specifier, looking for a web modules to install. If a web module is not detected,
 * null is returned.
 */
function parseSpecifier(specifier) {
  if (!specifier) {
    return null
  }

  // If specifier is a "bare module specifier" (ie: package name) just return it directly
  if (BARE_SPECIFIER_REGEX.test(specifier)) {
    return specifier
  }

  // Clean the specifier, remove any query params that may mess with matching
  const cleanedSpecifier = removeSpecifierQueryString(specifier)
  const cleanedSpecifierWithoutExtension = stripJsExtension(cleanedSpecifier)

  // Check if this matches `@scope/package.js` or `package.js` format.
  // If it is, assume that this is a top-level package that should be installed without the “.js”
  if (
    validatePackageName(cleanedSpecifierWithoutExtension).validForNewPackages
  ) {
    return cleanedSpecifierWithoutExtension
  }

  // Otherwise, this is an explicit import to a file within a package.
  return cleanedSpecifier
}

function parseImportStatement(code, imp) {
  const specifier = parseSpecifier(getSpecifierFromCode(code, imp))
  if (!specifier) {
    return null
  }

  const importStatement = code.slice(imp.ss, imp.se)
  if (/^import\s+type/.test(importStatement)) {
    return null
  }

  const isDynamicImport = imp.d > -1
  const hasDefaultImport =
    !isDynamicImport && DEFAULT_IMPORT_REGEX.test(importStatement)
  const hasNamespaceImport = !isDynamicImport && importStatement.includes('*')

  const namedImports = (importStatement.match(HAS_NAMED_IMPORTS_REGEX) || [
    null,
    ''
  ])[1]
    .split(SPLIT_NAMED_IMPORTS_REGEX)
    .map(name => name.trim())
    .filter(Boolean)

  return {
    specifier,
    all:
      isDynamicImport ||
      (!hasDefaultImport && !hasNamespaceImport && namedImports.length === 0),
    default: hasDefaultImport && importStatement.match(DEFAULT_IMPORT_REGEX)[1],
    namespace: hasNamespaceImport,
    named: namedImports
  }
}

function parseCodeForInstallTargets({ contents, extension }) {
  let imports
  // Attempt #1: Parse the file as JavaScript. JSX and some decorator
  // syntax will break this.
  try {
    if (extension === '.jsx' || extension === '.tsx') {
      // We know ahead of time that this will almost certainly fail.
      // Just jump right to the secondary attempt.
      throw new Error('JSX must be cleaned before parsing')
    }

    ;[imports] = parse(contents) || []
  } catch {
    // Attempt #2: Parse only the import statements themselves.
    // This lets us guarentee we aren't sending any broken syntax to our parser,
    // but at the expense of possible false +/- caused by our regex extractor.
    contents = cleanCodeForParsing(contents)
    ;[imports] = parse(contents) || []
  }

  const allImports = imports
    .map(imp => parseImportStatement(contents, imp))
    .filter(Boolean)
    // Babel macros are not install targets!
    .filter(imp => !/[./]macro(\.js)?$/.test(imp.specifier))

  return allImports
}

module.exports.parse = async (contents, extension) => {
  await init
  const imports = parseCodeForInstallTargets({ contents, extension })

  const packages = []
  const exportNames = []

  for (const im of imports) {
    const ex = [...im.named, im.default].filter(Boolean)

    packages.push({
      name: im.specifier,
      exportNames: ex
    })

    for (const name of ex) {
      exportNames.push(name)
    }
  }

  return { packages, exportNames }
}

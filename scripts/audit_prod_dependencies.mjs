#!/usr/bin/env node
/**
 * Audit the exact production dependency graph installed by pnpm.
 *
 * npm retired the legacy endpoints used by pnpm 10's `pnpm audit`. Rather
 * than resolving a second npm lockfile (which could drift from pnpm-lock),
 * ask pnpm for the already-installed production tree and submit its exact
 * name/version pairs to npm's supported bulk advisory endpoint.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const target = path.resolve(process.argv[2] ?? '.');

function readProductionTree(directory) {
  const raw = execFileSync('pnpm', ['list', '--prod', '--json', '--depth', 'Infinity'], {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('pnpm did not return a dependency tree');
  return value;
}

function collectPackageVersions(roots) {
  const versionsByName = new Map();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const dependencies = node.dependencies;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return;
    for (const [fallbackName, dependency] of Object.entries(dependencies)) {
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) continue;
      const name = typeof dependency.from === 'string' ? dependency.from : fallbackName;
      const version = typeof dependency.version === 'string' ? dependency.version : undefined;
      if (version) {
        const versions = versionsByName.get(name) ?? new Set();
        versions.add(version);
        versionsByName.set(name, versions);
      }
      visit(dependency);
    }
  };
  for (const root of roots) visit(root);
  return Object.fromEntries(
    [...versionsByName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, versions]) => [name, [...versions].sort()]),
  );
}

async function main() {
  const packages = collectPackageVersions(readProductionTree(target));
  const packageCount = Object.keys(packages).length;
  if (packageCount === 0) throw new Error(`no installed production packages found at ${target}`);

  const response = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(packages),
  });
  if (!response.ok) {
    throw new Error(`bulk advisory endpoint returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const advisoryByPackage = await response.json();
  if (!advisoryByPackage || typeof advisoryByPackage !== 'object' || Array.isArray(advisoryByPackage)) {
    throw new Error('bulk advisory endpoint returned an invalid response');
  }
  const findings = Object.entries(advisoryByPackage);
  if (findings.length === 0) {
    process.stdout.write(`production dependency audit passed (${packageCount} locked packages)\n`);
    return;
  }

  for (const [name, advisories] of findings) {
    const details = Array.isArray(advisories) ? advisories : [];
    for (const advisory of details) {
      const record = advisory && typeof advisory === 'object' ? advisory : {};
      process.stderr.write(`${name}: ${record.severity ?? 'unknown'} — ${record.title ?? 'unnamed advisory'} (${record.url ?? 'no URL'})\n`);
    }
  }
  throw new Error(`${findings.length} production package(s) have security advisories`);
}

main().catch((error) => {
  process.stderr.write(`production dependency audit failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

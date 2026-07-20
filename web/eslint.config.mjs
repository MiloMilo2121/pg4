import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: appRoot });

const config = [
  { ignores: ['.next/**', 'node_modules/**'] },
  ...compat.extends('next/core-web-vitals'),
];

export default config;

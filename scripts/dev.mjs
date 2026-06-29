// Run the engine API (:8787) and the Setaccio web dashboard (:3000) together.
// Zero-dependency: spawns both, prefixes their logs, and tears both down on exit.
//   pnpm run dev
import { spawn } from 'node:child_process';

const procs = [
  { name: 'api', color: '\x1b[34m', cmd: 'pnpm', args: ['run', 'serve'] },
  { name: 'web', color: '\x1b[35m', cmd: 'pnpm', args: ['--dir', 'web', 'dev'] },
];
const RESET = '\x1b[0m';

const children = procs.map(({ name, color, cmd, args }) => {
  const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'], env: process.env });
  const tag = `${color}[${name}]${RESET} `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(tag + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${tag}exited (${code})\n`);
    shutdown();
  });
  return child;
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

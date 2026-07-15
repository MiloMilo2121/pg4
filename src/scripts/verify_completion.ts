import { isCompletedOutput } from '../runtime/run_coverage';

const outCsv = process.argv[2];
if (!outCsv) {
  process.stderr.write('usage: verify_completion <output.csv>\n');
  process.exitCode = 2;
} else {
  process.exitCode = isCompletedOutput(outCsv) ? 0 : 1;
}

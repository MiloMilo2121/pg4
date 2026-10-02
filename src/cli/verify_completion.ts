import { isCompletedOutput } from '../discovery/scrape_completion';

const outCsv = process.argv[2];
if (!outCsv) {
  process.stderr.write('usage: verify_completion <output.csv>\n');
  process.exitCode = 2;
} else {
  process.exitCode = isCompletedOutput(outCsv) ? 0 : 1;
}

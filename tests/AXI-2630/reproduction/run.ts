/**
 * AXI-2663 (epic AXI-2630, FR74; SI-042). Command line entry: `npm run reproduce:mag4`.
 * Reads the process environment only and never loads a `.env` file.
 */
import { runReproduction } from './reproduce';

const outcome = await runReproduction(process.env, process.cwd());
console.log(`[AXI-2663] ${outcome.verdict}\n${outcome.message}`);
if (outcome.reportDir) console.log(`[AXI-2663] trace: ${outcome.reportDir}`);
process.exit(outcome.exitCode);

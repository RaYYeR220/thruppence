// Jest reporter: after a full run, writes results/contracts.json with the
// test counts and the measured fee per payment (from results/gas.json, which
// the gas test in LimitsExtension.spec.ts writes).
const fs = require('fs');
const path = require('path');

class ResultsReporter {
    constructor(globalConfig) {
        this.globalConfig = globalConfig;
    }

    onRunComplete(_contexts, results) {
        // A filtered run (-t pattern) would report partial counts; skip it.
        if (this.globalConfig.testNamePattern) return;

        const dir = path.join(__dirname, '..', 'results');
        fs.mkdirSync(dir, { recursive: true });

        let gasPerPaymentTon = null;
        try {
            gasPerPaymentTon = JSON.parse(fs.readFileSync(path.join(dir, 'gas.json'), 'utf8')).feesPerPaymentTon;
        } catch {
            // gas test did not run
        }

        const out = {
            tests: results.numTotalTests,
            passed: results.numPassedTests,
            gasPerPaymentTon,
            date: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(dir, 'contracts.json'), JSON.stringify(out, null, 2) + '\n');
    }
}

module.exports = ResultsReporter;

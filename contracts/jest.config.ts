import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: '@ton/sandbox/jest-environment',
    testPathIgnorePatterns: ['/node_modules/', '/build/'],
    testTimeout: 60000,
    reporters: ['default', '<rootDir>/scripts/results-reporter.js'],
};

export default config;

/**
 * @fileoverview Configuração do Jest para testes em TypeScript (ESM)
 */

export default {
  // Environment
  testEnvironment: 'node',

  // ES Modules support + TypeScript
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.test.json' }]
  },

  // Resolve imports NodeNext (*.js -> *.ts)
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },

  // Test patterns
  testMatch: [
    '<rootDir>/tests/**/*.test.ts',
    '<rootDir>/tests/**/*.spec.ts'
  ],

  // Coverage
  collectCoverage: false, // Será ativado pelo script test:coverage
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/app.ts', // Arquivo principal pode ser complexo para testar
    '!src/types/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!coverage/**'
  ],
  coverageThreshold: {
    global: {
      branches: 48,
      functions: 58,
      lines: 58,
      statements: 58
    }
  },

  // Setup and teardown
  setupFiles: ['<rootDir>/tests/env.setup.js'],
  testTimeout: 10000,

  // Jest configuration for clean output
  detectOpenHandles: true,

  // Verbose output
  verbose: true,

  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true
};
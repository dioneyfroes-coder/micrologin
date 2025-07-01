/**
 * @fileoverview Configuração do Jest para testes
 */

export default {
  // Environment
  testEnvironment: 'node',
  
  // ES Modules support
  transform: {},
  
  // Test patterns
  testMatch: [
    '<rootDir>/tests/**/*.test.js',
    '<rootDir>/tests/**/*.spec.js'
  ],
  
  // Coverage
  collectCoverage: false, // Será ativado pelo script test:coverage
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html', 'json'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/app.js', // Arquivo principal pode ser complexo para testar
    '!src/config/database.js', // Configuração de DB
    '!src/config/secrets.js', // Configuração de segredos
    '!src/**/*.test.js',
    '!src/**/*.spec.js',
    '!coverage/**'
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 75,
      statements: 75
    }
  },
  
  // Setup and teardown
  // setupFilesAfterEnv: ['<rootDir>/tests/setup.js'], // Desabilitado temporariamente
  setupFiles: ['<rootDir>/tests/env.setup.js'],
  testTimeout: 10000, // ✅ Reduzido de 30s para 10s
  
  // Jest configuration for clean output
  detectOpenHandles: true,
  forceExit: true,
  
  // Verbose output
  verbose: true,
  
  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,
  
  // Test environment variables  
  // setupFiles: ['<rootDir>/tests/env.setup.js'] // Já definido acima
};

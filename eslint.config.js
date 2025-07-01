import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: {
      'indent': ['error', 2],
      'quotes': ['error', 'single'],
      'semi': ['error', 'always'],
      'no-unused-vars': ['error', { 'argsIgnorePattern': '^_' }],
      'no-console': process.env.NODE_ENV === 'production' ? 'error' : 'off',
      'no-debugger': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'always'],
      'curly': ['error', 'all'],
      'brace-style': ['error', '1tbs'],
      'comma-dangle': ['error', 'never'],
      'no-trailing-spaces': 'error',
      'object-curly-spacing': ['error', 'always'],
      'array-bracket-spacing': ['error', 'never'],
      'space-before-function-paren': ['error', 'never'],
      'keyword-spacing': ['error', { 'before': true, 'after': true }],
      'space-infix-ops': 'error',
      'no-multiple-empty-lines': ['error', { 'max': 2, 'maxEOF': 1 }],
      'eol-last': ['error', 'always']
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        jest: 'readonly',
        describe: 'readonly',
        test: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        mongoose: 'readonly',
        setupErrorHandlers: 'readonly',
        getCachedJWT: 'readonly',
        performHealthCheck: 'readonly',
        jwt: 'readonly'
      }
    },
    rules: {
      'no-console': 'off'
    }
  },
  {
    files: ['tests/load/**/*.js'],
    languageOptions: {
      globals: {
        __ENV: 'readonly',
        check: 'readonly',
        group: 'readonly',
        sleep: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly'
      }
    },
    rules: {
      'no-console': 'off'
    }
  },
  {
    ignores: [
      'node_modules/',
      'coverage/',
      'dist/',
      'build/',
      '*.min.js',
      'logs/'
    ]
  }
];

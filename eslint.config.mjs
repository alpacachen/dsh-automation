import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['lib/**', 'coverage/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'error' },
  },
  {
    // Host service doubles intentionally model only the methods exercised by each test.
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)

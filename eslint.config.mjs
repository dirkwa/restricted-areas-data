import eslint from '@eslint/js'
import eslintPluginPrettier from 'eslint-plugin-prettier/recommended'

export default [
  eslint.configs.recommended,
  eslintPluginPrettier,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        structuredClone: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        performance: 'readonly'
      }
    }
  },
  {
    ignores: ['node_modules/**', 'work/**', 'dist/**']
  }
]

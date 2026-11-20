// Port??o de qualidade: nome usado sem existir ?? erro (pega c??digo movido pela metade);
// arquivo grande demais ?? aviso (meta: 350 linhas).
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['public/vendor/**', 'node_modules/**'] },
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': 'warn', 'no-empty': 'off', 'no-irregular-whitespace': 'off', 'no-useless-escape': 'warn', 'max-lines': ['warn', { max: 350, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser, ...globals.serviceworker } },
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': 'warn', 'no-empty': 'off', 'no-irregular-whitespace': 'off', 'no-useless-escape': 'warn', 'max-lines': ['warn', { max: 350, skipBlankLines: true, skipComments: true }] },
  },
];

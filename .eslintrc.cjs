module.exports = {
    env: {
        node: true,        // Habilita variáveis globais do Node.js
        es2021: true,      // Suporte para ES2021
        jest: true,        // Se você usa Jest para testes
    },
    extends: [
        'eslint:recommended',                // Regras recomendadas do ESLint
        'prettier',                          // Integração com Prettier
    ],
    parserOptions: {
        ecmaVersion: 2021,   // Pode ser 12 ou 2021
        sourceType: 'module', // Se usar ES Modules (type: module no package.json)
    },
    plugins: [
        'prettier',           // Plugin do Prettier
    ],
    rules: {
        // Regras básicas
        'no-unused-vars': ['warn', {
            argsIgnorePattern: '^_',        // Ignora variáveis que começam com _
            varsIgnorePattern: '^_'
        }],
        'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
        'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off',

        // Regras adicionais úteis para Node.js
        'no-process-env': 'off',            // Permite process.env (útil em Node.js)
        'global-require': 'off',             // Permite require() em qualquer lugar
        'no-multiple-empty-lines': ['warn', { max: 2 }],

        // Integração com Prettier
        'prettier/prettier': ['error', {
            semi: true,
            singleQuote: true,
            trailingComma: 'es5',
            printWidth: 100,
            tabWidth: 4,
            endOfLine: 'auto',
        }],
    },
    // Ignorar certos arquivos/pastas
    ignorePatterns: [
        'dist/',
        'node_modules/',
        'coverage/',
        '*.min.js',
    ],
};
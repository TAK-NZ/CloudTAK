import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    stylistic.configs.customize({
        indent: 4,
        quotes: 'single',
        semi: true,
    }),
    {
        rules: {
            "@typescript-eslint/no-explicit-any": "warn",
            '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: false }]
        }
    },
    {
        // Exclude auto-generated type files — their style is determined by
        // the generator, not this project's coding conventions.
        ignores: ['src/derived-types.d.ts']
    }
);

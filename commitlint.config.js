import { commitTypes } from './release.config.js';

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', commitTypes.map((t) => t.type)],
  },
};

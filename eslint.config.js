const globals = require("globals");

module.exports = [
  {
    // Bundled upstream runtime; maintained separately from the extension.
    ignores: ["odrviewer/viewer.js"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      "no-const-assign": "warn",
      "no-this-before-super": "warn",
      "no-undef": "warn",
      "no-unreachable": "warn",
      "no-unused-vars": "warn",
      "constructor-super": "warn",
      "valid-typeof": "warn"
    },
  },
];

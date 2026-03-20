export default [
  {
    files: ["**/*.js"],
    rules: {
      "no-unused-vars": "warn",
      "no-console": "warn",
      "eqeqeq": "warn",
      "complexity": ["warn", 8],
      "prefer-const": "warn",
    }
  }
];

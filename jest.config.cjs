const { createDefaultEsmPreset } = require('ts-jest');

const presetConfig = createDefaultEsmPreset();

/** @type {import("jest").Config} **/
module.exports = {
  ...presetConfig,
  testEnvironment: "node",
  moduleNameMapper: {
    // This handles the .js extension in your TS imports
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
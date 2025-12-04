import caxa from 'caxa';

(async () => {
  await caxa({
    input: "./",
    output: "bin/pinggy",
    command: [
      "{{caxa}}/node_modules/.bin/node",
      "{{caxa}}/dist/index.js",
    ],
  });
})();
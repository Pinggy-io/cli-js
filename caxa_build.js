import caxa from 'caxa';

(async () => {

  const platform = process.platform;      // win32, linux, darwin
  const arch = process.arch;              // x64, arm64, ia32
  
  const extension =
    platform === "win32" ? ".exe" :
    platform === "darwin" ? "" : "";

  await caxa({
    input: "./",
    output: `bin/pinggy-${platform}-${arch}${extension}`,
    includeNode: true,
    command: [
      "{{caxa}}/node_modules/.bin/node",
      "{{caxa}}/dist/index.js",
    ],
  });
})();
import * as esbuild from 'esbuild';

async function test() {
  await esbuild.build({
    entryPoints: ['test_import.ts'],
    bundle: true,
    format: 'cjs',
    outfile: 'test_out.js'
  }).catch(() => process.exit(1));
  console.log("Built successfully");
}

test();

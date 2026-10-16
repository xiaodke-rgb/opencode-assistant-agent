import { existsSync } from 'node:fs';
import { build } from 'esbuild';

// 优先用本包 node_modules；没有时可用 OPENCHAMBER_SDK_NODE_MODULES 指向别处的 node_modules
// （例如本机先例：/home/xiaodke/.config/openchamber/extensions/session-usage/node_modules）。
const local = existsSync('node_modules');
const nodePaths = local ? [] : (process.env.OPENCHAMBER_SDK_NODE_MODULES ? [process.env.OPENCHAMBER_SDK_NODE_MODULES] : []);

const shared = { bundle: true, logLevel: 'info', minify: false, sourcemap: false, nodePaths };
const browser = { ...shared, platform: 'browser', format: 'iife', target: 'chrome120' };

await build({ ...browser, entryPoints: ['panel/main.ts'], outfile: 'panel/main.js' });
await build({ ...browser, entryPoints: ['status/main.ts'], outfile: 'status/main.js' });
await build({ ...shared, platform: 'node', format: 'cjs', target: 'node22', entryPoints: ['service/main.ts'], outfile: 'service/main.js' });

console.log('build ok: panel/main.js, status/main.js, service/main.js');

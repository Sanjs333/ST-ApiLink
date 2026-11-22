import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(serverDir, '../../../../../../plugins/ST-ApiLink-Server');
const target = path.join(pluginDir, 'index.mjs');
let relative = path.relative(pluginDir, path.join(serverDir, 'index.mjs')).split(path.sep).join('/');
if (!relative.startsWith('.')) relative = './' + relative;
const content = `export { info, init } from ${JSON.stringify(relative)};\n`;
let existing;
try { existing = await readFile(target, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing !== undefined && existing !== content) throw new Error('ST-ApiLink-Server 已存在其他入口，请检查后再安装。');
await mkdir(pluginDir, { recursive: true });
if (existing === undefined) await writeFile(target, content, { flag: 'wx' });
console.log('Vertex 模型目录入口已安装，请重启酒馆加载服务端。');

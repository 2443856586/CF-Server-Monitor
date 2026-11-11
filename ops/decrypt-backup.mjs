// 将加密备份解密到显式指定的新文件，已有文件不会被覆盖。
import { readFile, writeFile } from 'node:fs/promises';
import { createDecipheriv } from 'node:crypto';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('用法 node ops/decrypt-backup.mjs 加密备份.json 输出.sql');
const key = Buffer.from(process.env.TOKYO_BACKUP_KEY || '', 'base64');
if (key.length !== 32) throw new Error('缺少正确的 TOKYO_BACKUP_KEY');
const data = JSON.parse(await readFile(input, 'utf8'));
if (data.algorithm !== 'aes-256-gcm') throw new Error('备份算法不受支持');
const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'));
decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
const plain = Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64')), decipher.final()]);
await writeFile(output, plain, { flag: 'wx', mode: 0o600 });
console.log('备份已解密，恢复数据库前请核对目标和时间点。');

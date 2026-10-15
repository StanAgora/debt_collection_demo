const fs = require('node:fs');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const ip = process.argv[2];
if (net.isIP(ip) !== 4) {
  console.error('用法：node scripts/setup-env.js <FreeSWITCH 对外可达的 IPv4>');
  process.exit(1);
}
const root = path.join(__dirname, '..');
const contents = fs.readFileSync(path.join(root, '.env.example'), 'utf8')
  .replace('YOUR_SERVER_PUBLIC_IPV4', ip)
  .replace('REPLACE_WITH_RANDOM_ESL_PASSWORD', randomBytes(24).toString('hex'))
  .replace('REPLACE_WITH_RANDOM_EXTENSION_PASSWORD', randomBytes(24).toString('hex'))
  .replace('REPLACE_WITH_RANDOM_WEBHOOK_TOKEN', randomBytes(24).toString('hex'));
try {
  fs.writeFileSync(path.join(root, '.env'), contents, { flag: 'wx', mode: 0o600 });
  console.log('已生成 .env 和随机密码；文件已被 Git 忽略。');
} catch (error) {
  if (error.code === 'EEXIST') console.error('.env 已存在，未覆盖。请编辑现有配置。');
  else console.error(error.message);
  process.exit(1);
}

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openHomepageDatabase } from '../db/connection.js';
import { createInitialAdmin } from '../modules/auth/index.js';
import { initializeSelfHostedDatabase } from './self-hosted-setup.js';

/** No password arguments, environment variables, default password, or echoed input. */
function hiddenInput(prompt: string): Promise<string> {
  stdout.write(prompt);
  return new Promise((resolve,reject) => {
    let value = '';
    const previousRaw = stdin.isRaw;
    const finish = (error?: Error) => {
      stdin.removeListener('data',onData); stdin.setRawMode(previousRaw); stdin.pause(); stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: Buffer|string) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003' || char === '\u0004') { finish(new Error('操作已取消。')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') value = [...value].slice(0,-1).join('');
        else if (char >= ' ') value += char;
      }
    };
    stdin.setRawMode(true); stdin.resume(); stdin.on('data',onData);
  });
}
async function main() {
  const args = process.argv.slice(2);
  const selfHosted = args[0] === '--self-hosted';
  if (args.length && (args.length !== 2 || !args[1] || (!selfHosted && args[0] !== '--database'))) throw new Error('用法：npm run auth:bootstrap -- [--database 本地数据库路径 | --self-hosted 新数据库路径]。密码仅可在终端隐藏输入。');
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('请在本机交互终端运行；禁止通过管道或命令参数传入密码。');
  const questions = createInterface({ input: stdin, output: stdout });
  const username = await questions.question('管理员登录账号（3–48 位字母/数字/._-）：');
  const name = await questions.question('管理员姓名：'); questions.close();
  let password = await hiddenInput('管理员密码（12–128 字符，不显示输入）：');
  let confirmation = await hiddenInput('再次输入密码：');
  if (password !== confirmation) throw new Error('两次密码不一致，未创建账号。');
  const input = { username, name, password };
  let user;
  if (selfHosted) {
    user = await initializeSelfHostedDatabase(args[1]!, input);
  } else {
    const db = openHomepageDatabase(args[1]);
    user = await createInitialAdmin(db, input).finally(() => db.close());
  }
  password = ''; confirmation = ''; input.password = '';
  stdout.write(`管理员 ${user.username} 已初始化。请打开登录页使用刚才设置的密码登录。未关联任何旧示例成员。\n`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : '管理员初始化失败，请检查本地配置。'); process.exitCode = 1; });

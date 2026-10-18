// Set or change the admin password:  npm run set-password
// "npm run set-password -- --generate" creates a random password and prints it once.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { ADMIN_FILE, DATA_DIR } from './paths.js';
import { createAdminRecord, MIN_PASSWORD_LENGTH } from './auth.js';

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function generate() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n) => Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
  return 'eco-' + pick(4) + '-' + pick(4) + '-' + pick(4);
}

let password;
if (process.argv.includes('--generate')) {
  password = generate();
} else {
  password = await askHidden('새 관리자 비밀번호 (' + MIN_PASSWORD_LENGTH + '자 이상): ');
  const again = await askHidden('한 번 더 입력: ');
  if (password !== again) {
    console.error('두 비밀번호가 다릅니다. 바뀌지 않았습니다.');
    process.exit(1);
  }
}

try {
  const record = await createAdminRecord(password);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(ADMIN_FILE, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log('관리자 비밀번호를 저장했습니다: ' + ADMIN_FILE);
if (process.argv.includes('--generate')) console.log('새 비밀번호: ' + password);
console.log('이미 로그인한 기기는 모두 로그아웃됩니다. 실행 중인 서버는 다시 켤 필요가 없습니다.');

// إنشاء أول حساب مدير (أو أي حساب) مباشرة في قاعدة البيانات.
// الاستعمال:
//   node scripts/create-user.mjs --remote
//   node scripts/create-user.mjs --local
// يسأل عن الاسم والدور والرمز السري، ولا يُظهر الرمز ولا يحفظه في أي ملف.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const target = process.argv.includes('--remote') ? '--remote' : process.argv.includes('--local') ? '--local' : null;
if (!target) {
  console.error('حدّد --remote أو --local');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let muted = false;
rl._writeToOutput = (s) => { if (!muted) process.stdout.write(s); };
const lines = rl[Symbol.asyncIterator]();
async function ask(q, hidden = false) {
  process.stdout.write(q);
  muted = hidden;
  const { value } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write('\n');
  return value ?? '';
}
const askHidden = (q) => ask(q, true);

const username = (await ask('اسم الدخول (أحرف لاتينية صغيرة): ')).trim().toLowerCase();
if (!/^[a-z0-9._-]{3,32}$/.test(username)) { console.error('اسم غير صالح'); process.exit(1); }
const display = (await ask('الاسم الظاهر: ')).trim();
if (!display || display.length > 60) { console.error('الاسم الظاهر مطلوب'); process.exit(1); }
const role = ((await ask('الدور (admin أو depositor) [admin]: ')).trim() || 'admin');
if (!['admin', 'depositor'].includes(role)) { console.error('دور غير صالح'); process.exit(1); }
const pw = await askHidden('الرمز السري: ');
const pw2 = await askHidden('أعد كتابة الرمز السري: ');
rl.close();
if (pw.length < 8) { console.error('الرمز السري قصير (8 أحرف على الأقل)'); process.exit(1); }
if (pw !== pw2) { console.error('الرمزان غير متطابقين'); process.exit(1); }

// نفس طريقة الخادم: PBKDF2-SHA256، 100000 تكرار، ملح 16 بايت، ناتج 32 بايت
const ITER = 100000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(pw, salt, ITER, 32, 'sha256');

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = `INSERT INTO users (username, display_name, role, pw_hash, pw_salt, pw_iter) VALUES (${q(username)}, ${q(display)}, ${q(role)}, ${q(hash.toString('base64'))}, ${q(salt.toString('base64'))}, ${ITER});`;

execFileSync('npx', ['wrangler', 'd1', 'execute', 'shikati', target, '--command', sql], { stdio: 'inherit' });
console.log(`تم إنشاء المستخدم ${username}`);

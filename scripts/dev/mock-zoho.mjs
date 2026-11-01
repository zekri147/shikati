// خادم زوهو وهمي للتجربة المحلية فقط. لا يتصل بزوهو الحقيقي ولا يحتوي بيانات حقيقية.
//
// يقلّد: وسيط الرموز في غوغل، وقائمة الدفعات، وقراءة دفعة، والإيداع، والتحقق منه،
// وحذفه، وتحديث الحقول المخصصة، وصورة الشيك.
//
// التشغيل:
//   node scripts/dev/mock-zoho.mjs          (يستمع على المنفذ 8788)
//   cp scripts/dev/dev.vars.mock .dev.vars
//   npm run db:migrate:local && npm run dev
//
// سيناريوهات حسب آخر رقم في معرّف الدفعة 74184000000000XN:
//   1 نجاح عادي              2 له إيداع سابق في زوهو     3 حالته «محصّل»
//   4 ينقطع الرد بعد الإيداع  5 الإيداع لا يُربط فيُحذف      6 تحديث الحالة يفشل بعد الإيداع
//   7 زوهو يرفض الإيداع       8 الإيداع ينجح بعد تأخير 1.5 ثانية
//
// أدوات إضافية:
//   GET /__log             سجل طلبات الكتابة والصور
//   GET /__revert/<id>     حذف الإيداع وإرجاع الحالة «في الحوزة» (كأن المدير ألغاه في زوهو)

import http from 'node:http';
import fs from 'node:fs';

const PORT = 8788;
const RELAY_KEY = 'k'.repeat(40);
const TOKEN = 'T';
const CIH = '7418406000000000358';
const JPG = fs.readFileSync(new URL('./cheque-sample.jpg', import.meta.url));

const CUSTOMERS = ['SARL COMINOX', 'EURL HOUSE FIX', 'SARL WELD FIXE', 'SARL BATIMETAL', 'EURL SOUDURE PLUS', 'SARL INOX ALGER', 'SARL TECHNO FER', 'EURL AL AMANE'];
const AMOUNTS = [366600.39, 835400, 263700, 120000, 50000, 99000, 150000, 77000];
const DATES = ['2026-10-26', '2026-10-20', '2026-10-30', '2026-10-15', '2026-10-31', '2026-10-28', '2026-10-24', '2026-10-29'];

const payments = {};
for (let n = 1; n <= 8; n++) {
  const id = `74184000000000${String(n).padStart(2, '0')}`;
  payments[id] = {
    payment_id: id, payment_number: `P${n}`, customer_id: `c${n}`, customer_name: CUSTOMERS[n - 1],
    amount: AMOUNTS[n - 1], date: DATES[n - 1], account_id: CIH, payment_mode: 'Check',
    location_name: n % 2 ? 'ALGER' : 'EL EULMA', location_id: 'LOC1', currency_id: 'DZD1',
    invoices: [{ invoice_id: 'i1' }], deposit_details: [], has_attachment: true,
    documents: [{ document_id: `D${id}`, file_type: 'jpg', file_name: 'cheque.jpg' }],
    last_modified_time: new Date(Date.now() - n * 3_600_000).toISOString(),
    custom_field_hash: { cf_5d7197: 'في الحوزة', cf_d_pos_vers: 'ELONAC', cf_n_cheque: `C0${n}`, cf_fffaad: 'سطر قديم' },
  };
}
payments['7418400000000002'].deposit_details = [{ deposit_id: 'x' }];
payments['7418400000000003'].custom_field_hash.cf_5d7197 = 'محصّل';

const log = [];
const txns = {};
let txnSeq = 0;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const send = (obj, status = 200) => { res.statusCode = status; res.end(JSON.stringify(obj)); };
    const path = url.pathname;
    let m;

    if (path === '/relay') {
      const j = JSON.parse(body || '{}');
      return send(j.key === RELAY_KEY ? { access_token: TOKEN, expires_in: 3600 } : { error: 'forbidden' });
    }
    if (path === '/__log') return send(log);
    if ((m = path.match(/^\/__revert\/(\d+)$/))) {
      const p = payments[m[1]];
      if (!p) return send({ error: 'nf' }, 404);
      p.deposit_details = [];
      p.custom_field_hash.cf_5d7197 = 'في الحوزة';
      return send({ ok: true });
    }
    if (req.headers.authorization !== `Zoho-oauthtoken ${TOKEN}`) return send({ code: 57, message: 'not authorized' }, 401);

    if (path === '/books/v3/customerpayments' && req.method === 'GET') {
      const list = Object.values(payments).map((p) => ({ ...p, ...p.custom_field_hash }));
      return send({ code: 0, customerpayments: list, page_context: { has_more_page: false } });
    }
    if ((m = path.match(/^\/books\/v3\/documents\/(D\d+)$/))) {
      log.push(`IMG ${m[1]}`);
      res.setHeader('Content-Type', 'image/jpeg');
      return res.end(JPG);
    }
    if (path.includes('/attachment') || path.includes('/documents/')) return send({ code: 1004, message: 'not found' }, 404);

    if ((m = path.match(/^\/books\/v3\/customerpayments\/(\d+)$/))) {
      const p = payments[m[1]];
      if (!p) return send({ code: 1002, message: 'not found' }, 404);
      if (req.method === 'GET') return send({ code: 0, payment: p });
      if (req.method === 'PUT') {
        log.push(`PUT ${m[1]} ${body}`);
        if (m[1].endsWith('6')) return send({ code: 9, message: 'fail' }, 400);
        for (const f of JSON.parse(body).custom_fields) p.custom_field_hash[f.api_name] = f.value;
        p.last_modified_time = new Date().toISOString();
        return send({ code: 0 });
      }
    }
    if (path === '/books/v3/banktransactions' && req.method === 'POST') {
      const j = JSON.parse(body);
      const pid = j.line_items[0].transaction_id;
      log.push(`POST ${pid} ${body}`);
      if (pid.endsWith('4')) { req.socket.destroy(); return; }
      if (pid.endsWith('7')) return send({ code: 1001, message: 'Validation error' }, 400);
      const create = () => {
        const id = `T${++txnSeq}`;
        txns[id] = { line_items: pid.endsWith('5') ? [{ transaction_id: 'other' }] : j.line_items };
        payments[pid].deposit_details = [{ deposit_id: id }];
        send({ code: 0, banktransaction: { transaction_id: id } });
      };
      if (pid.endsWith('8')) { setTimeout(create, 1500); return; }
      return create();
    }
    if ((m = path.match(/^\/books\/v3\/banktransactions\/(T\d+)$/))) {
      if (req.method === 'GET') return send({ code: 0, banktransaction: txns[m[1]] });
      if (req.method === 'DELETE') {
        log.push(`DELETE ${m[1]}`);
        delete txns[m[1]];
        for (const p of Object.values(payments)) p.deposit_details = p.deposit_details.filter((d) => d.deposit_id !== m[1]);
        return send({ code: 0 });
      }
    }
    send({ code: 404 }, 404);
  });
}).listen(PORT, () => console.log(`mock zoho on http://127.0.0.1:${PORT}`));

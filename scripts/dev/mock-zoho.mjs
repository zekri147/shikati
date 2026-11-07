// خادم زوهو وهمي للتجربة المحلية فقط. لا يتصل بزوهو الحقيقي ولا يحتوي بيانات حقيقية.
//
// يقلّد: وسيط الرموز في غوغل، وقائمة الدفعات، وقراءة دفعة، والإيداع، والتحقق منه،
// وحذفه، وتحديث الحقول المخصصة، وصورة الشيك، والعملاء، والفواتير، وتسجيل الشيك.
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
// شيكات إضافية بحالات أخرى لتجربة «كل الشيكات» و«التنبيهات» وصفحة التفاصيل
// (معرّفاتها تنتهي بـ 0 أو 9، فلا تدخل في سيناريوهات الإيداع أعلاه):
//   ..10 روستمية في الحوزة           ..19 مودع في AGB      ..20 محصّل
//   ..29 مظهّر لمورد                  ..30 مرفوض            ..39 في صندوق نقدي بالخطأ
//   ..40 شيك ضمان                     ..49 AGB متأخر
//   ..50 في الحوزة وسجلّه فيه تحصيل آلي   ..59 مودع وسجلّه فيه تحصيل آلي (التراجع ممنوع)
//
// أدوات إضافية:
//   GET /__log             سجل طلبات الكتابة والصور
//   التراجع: DELETE للإيداع ودفعة المورد ودفعة العميل، و GET /vendorpayments?amount=
//   GET /__revert/<id>     حذف الإيداع وإرجاع الحالة «في الحوزة» (كأن المدير ألغاه في زوهو)
//
// تسجيل شيك جديد (POST /customerpayments) حسب آخر رقم في رقم الشيك:
//   4 ينقطع الرد بعد الإرسال    7 زوهو يرفض التسجيل    غير ذلك: نجاح
// قسم التحصيل: GET /contacts دون بحث يعيد العملاء المدينين بحقل «Owner» (cf_owner)،
// وGET /invoices?status=unpaid يعيد كل الفواتير غير المسدّدة. المندوبون: AMINE وZAKARIA وSMAIL،
// وعميل بلا مندوب، وعميل برصيد افتتاحي فقط، وآخر بفواتير ورصيد افتتاحي معاً.
// تعليق المراجعة (POST /contacts/<id>/comments) حسب نص الملاحظة:
//   «#قطع» ينقطع الرد بعد الإرسال    «#رفض» زوهو يرفض بالرمز 57 (صلاحية ناقصة)    غير ذلك: نجاح
// ودفعة المورد عند التظهير (POST /vendorpayments) حسب آخر رقم في رقم الشيك:
//   8 زوهو يرفض دفعة المورد     6 ينقطع الرد بعد الإرسال
// ويقلّد أيضاً واجهة كلود (POST /v1/messages) فيعيد قراءة ثابتة لصورة الشيك،
// واتجاهها 180 درجة (MOCK_ROTATION) فتظهر الصورة السليمة مقلوبة، دليلاً على أن التدوير يُطبَّق.

import http from 'node:http';
import fs from 'node:fs';

const PORT = 8788;
const RELAY_KEY = 'k'.repeat(40);
const TOKEN = 'T';
const CIH = '7418406000000000358';
const JPG = fs.readFileSync(new URL('./cheque-sample.jpg', import.meta.url));

const CUSTOMERS = ['SARL COMINOX', 'EURL HOUSE FIX', 'SARL WELD FIXE', 'SARL BATIMETAL', 'EURL SOUDURE PLUS', 'SARL INOX ALGER', 'SARL TECHNO FER', 'EURL AL AMANE'];
const AMOUNTS = [366600.39, 835400, 263700, 120000, 50000, 99000, 150000, 77000];
// التواريخ نسبية إلى اليوم حتى تبقى التنبيهات صالحة في أي يوم تُشغَّل فيه التجربة
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const DATES = [day(-6), day(-12), day(-2), day(-17), day(-1), day(-4), day(-8), day(-3)];

const payments = {};
for (let n = 1; n <= 8; n++) {
  const id = `74184000000000${String(n).padStart(2, '0')}`;
  payments[id] = {
    payment_id: id, payment_number: `P${n}`, customer_id: `74184000001000${String(n).padStart(2, '0')}`, customer_name: CUSTOMERS[n - 1],
    amount: AMOUNTS[n - 1], date: DATES[n - 1], account_id: CIH, payment_mode: 'Check',
    location_name: n % 2 ? 'ALGER' : 'EL EULMA', location_id: 'LOC1', currency_id: 'DZD1',
    account_name: 'Cheques in Hand', created_by: 'AMINE', invoice_numbers: `BL-26/10${n}0`,
    invoices: [
      { invoice_id: 'i1', invoice_number: `BL-26/10${n}0`, date: day(-30), amount_applied: AMOUNTS[n - 1] - 1000, total: AMOUNTS[n - 1] - 1000, balance: 0 },
      { invoice_id: 'i2', invoice_number: `BL-26/10${n}1`, date: day(-20), amount_applied: 1000, total: 50000, balance: 49000 },
    ],
    deposit_details: [], has_attachment: true,
    documents: [{ document_id: `D${id}`, file_type: 'jpg', file_name: 'cheque.jpg' }],
    last_modified_time: new Date(Date.now() - n * 3_600_000).toISOString(),
    custom_field_hash: {
      cf_5d7197: 'في الحوزة', cf_d_pos_vers: 'ELONAC', cf_n_cheque: `72431${String(n).padStart(2, '0')}`, cf_fffaad: `${day(-6)} — سطر قديم`,
      cf_023de7: '✔ كاملة',
    },
  };
}

// شيكات بحالات أخرى
const extra = (id, n, over, cf) => {
  payments[id] = {
    payment_id: id, payment_number: `P${n}`, customer_id: `74184000001000${String(n).padStart(2, '0')}`, customer_name: over.customer, amount: over.amount,
    date: over.date, account_id: over.account_id || CIH, account_name: over.account_name || 'Cheques in Hand',
    payment_mode: 'Check', location_name: over.location || 'ALGER', location_id: 'LOC1', currency_id: 'DZD1',
    created_by: 'ZEKRI', invoice_numbers: `BL-26/2${n}`,
    invoices: [{ invoice_id: `i${n}`, invoice_number: `BL-26/2${n}`, date: over.date, amount_applied: over.amount, total: over.amount, balance: 0 }],
    deposit_details: over.deposit_details || [], has_attachment: over.image !== false,
    documents: over.image === false ? [] : [{ document_id: `D${id}`, file_type: 'jpg', file_name: 'cheque.jpg' }],
    last_modified_time: new Date(Date.now() - n * 1_800_000).toISOString(),
    custom_field_hash: { cf_023de7: '✔ كاملة', ...cf },
  };
};
extra('7418400000000010', 10, { customer: 'SARL ROSTOM BATI', amount: 410000, date: day(-3) },
  { cf_5d7197: 'في الحوزة', cf_d_pos_vers: 'ROSTOMIA', cf_n_cheque: '5512010' });
extra('7418400000000019', 19, { customer: 'EURL METAL PRO', amount: 225000, date: day(-9), location: 'EL EULMA',
  deposit_details: [{ deposit_id: '7418400000077019', date: day(-5), account_name: 'Bank – AGB', amount: 225000 }] },
  { cf_5d7197: 'مودع في البنك', cf_d_pos_vers: 'ELONAC', cf_n_cheque: '5512019',
    cf_fffaad: `${day(-5)} — إيداع في AGB من تطبيق شيكاتي (أمين)` });
extra('7418400000000020', 20, { customer: 'SARL COMINOX', amount: 180000, date: day(-25),
  deposit_details: [{ deposit_id: '7418400000077020', date: day(-20), account_name: 'Bank – AGB', amount: 180000 }] },
  { cf_5d7197: 'محصّل', cf_d_pos_vers: 'ELONAC', cf_n_cheque: '5512020',
    cf_fffaad: `${day(-20)} — إيداع في AGB من تطبيق شيكاتي (أمين)\n${day(-17)} — تحصيل آلي عبر رسالة AGB` });
extra('7418400000000029', 29, { customer: 'EURL HOUSE FIX', amount: 835400, date: day(-4), location: 'EL EULMA',
  account_id: '7418406000009849106', account_name: 'Endorsed Cheques' },
  { cf_5d7197: 'مظهّر لمورد', cf_d_pos_vers: 'Autre Fournisseur', cf_n_cheque: '0499308',
    cf_fffaad: `[END|741840600001|741840600002]\nظُهّر للمورد SARL ACIER بتاريخ ${day(-3)} باعتماد الإدارة` });
extra('7418400000000030', 30, { customer: 'SARL TECHNO FER', amount: 95000, date: day(-15) },
  { cf_5d7197: 'مرفوض', cf_d_pos_vers: 'ELONAC', cf_n_cheque: '5512030' });
extra('7418400000000039', 39, { customer: 'EURL SANS DATE', amount: 60000, date: day(-10), image: false,
  account_id: '7418406000000000999', account_name: 'Caisse ALGER' },
  { cf_5d7197: 'في الحوزة', cf_n_cheque: '0000000',
    cf_023de7: '✖ ينقص: NIF · NIS · ART', cf_51a7f5: 'Caisse ALGER → AMINE | مُنشئ العملية: SAMIR',
    cf_drive: 'https://drive.google.com/file/d/abc123/view' });
extra('7418400000000040', 40, { customer: 'SARL GARANTIE', amount: 1000000, date: day(-40) },
  { cf_5d7197: 'شيك ضمان', cf_n_cheque: '5512040' });
extra('7418400000000049', 49, { customer: 'SARL ECHU AGB', amount: 133000, date: day(-12), location: 'EL EULMA' },
  { cf_5d7197: 'في الحوزة', cf_d_pos_vers: 'ELONAC', cf_n_cheque: '5512049' });
// رسالة البنك أكّدت التحصيل، ثم عادت الحالة يدوياً في زوهو: الإيداع يكتب «محصّل»، والتراجع ممنوع
extra('7418400000000050', 50, { customer: 'SARL SMS AVANT', amount: 366600.39, date: day(-8) },
  { cf_5d7197: 'في الحوزة', cf_d_pos_vers: 'ELONAC', cf_n_cheque: '5512050',
    cf_fffaad: `${day(-6)} — إيداع في AGB من تطبيق شيكاتي (أمين)\n${day(-3)} — تحصيل آلي عبر رسالة AGB\n${day(-2)} — تراجع عن الإيداع من تطبيق شيكاتي (ZEKRI)` });
extra('7418400000000059', 59, { customer: 'SARL SMS APRES', amount: 210000, date: day(-9),
  deposit_details: [{ deposit_id: '7418400000077059', date: day(-5), account_name: 'Bank – AGB', amount: 210000 }] },
  { cf_5d7197: 'مودع في البنك', cf_d_pos_vers: 'ELONAC', cf_n_cheque: '5512059',
    cf_fffaad: `${day(-5)} — إيداع في AGB من تطبيق شيكاتي (أمين)\n${day(-2)} — تحصيل آلي عبر رسالة AGB` });
payments['7418400000000002'].deposit_details = [{ deposit_id: 'x' }];
payments['7418400000000003'].custom_field_hash.cf_5d7197 = 'محصّل';

const CONTACTS = [
  ...CUSTOMERS.map((name, i) => ({ contact_id: `74184000001000${String(i + 1).padStart(2, '0')}`, contact_name: name, contact_type: 'customer' })),
  { contact_id: '7418400000100090', contact_name: 'SARL NOUVEAU CLIENT', contact_type: 'customer' },
  // مورد يحمل اسم عميل: يجب ألا يظهر في بحث العملاء
  { contact_id: '7418400000100091', contact_name: 'SARL COMINOX', contact_type: 'vendor' },
  { contact_id: '7418400000100092', contact_name: 'SARL ACIER FOURNISSEUR', contact_type: 'vendor' },
];
// فواتير غير مدفوعة لكل عميل، الأقدم أولاً
const INVOICES = {};
for (const c of CONTACTS.filter((x) => x.contact_type === 'customer')) {
  INVOICES[c.contact_id] = [
    { invoice_id: `${c.contact_id}1`, invoice_number: `BL-26/${c.contact_id.slice(-2)}01`, date: day(-40), balance: 120000, customer_id: c.contact_id },
    { invoice_id: `${c.contact_id}2`, invoice_number: `BL-26/${c.contact_id.slice(-2)}02`, date: day(-20), balance: 300000, customer_id: c.contact_id },
  ];
}
// العملاء المدينون لقسم التحصيل: [الاسم، المندوب، الهاتف، الرصيد الافتتاحي، الفواتير [أيام قبل الاستحقاق، الرصيد]]
const COLL = [
  ['SARL VM SOUDAGE', 'AMINE', '+213-0561765718', 0, [[-130, 400000], [-60, 250000], [10, 120000]]],
  ['ABDELKARIM ADRAR', 'SMAIL', '+213661460848', 0, [[-95, 1100000]]],
  ['EMAD ALIBRAHIM', 'ZAKARIA', '+213-0556198025', 0, [[-12, 856050], [5, 400000]]],
  ['SARL NSA EQUIPEMENTS', 'AMINE', '0550112233', 0, [[23, 832518]]],
  ['GUESSMI LAKHDAR', 'AMINE', '', 0, [[-45, 500]]],
  ['EURL OUEST METAL', 'AMINE', '0770445566', 185000, []],
  ['SARL INOX CONSTANTINE', 'ZAKARIA', '0661778899', 90000, [[-35, 210000]]],
  ['ETS BENALI SOUDURE', 'AMINE', '0551223344', 0, [[-8, 64500], [-3, 30000]]],
  ['CLIENT SANS OWNER', '', '0555000111', 0, [[-200, 75000]]],
  ['SARL TECHNO SUD', 'SMAIL', '0699887766', 0, [[-20, 318000]]],
];
const DEBTORS = [];
const COLL_INVOICES = [];
COLL.forEach(([name, owner, mobile, opening, invs], i) => {
  const id = `74184000002000${String(i + 1).padStart(2, '0')}`;
  let bal = opening;
  invs.forEach(([dueIn, b], k) => {
    bal += b;
    COLL_INVOICES.push({ invoice_id: `${id}${k}`, invoice_number: `BL-26/${900 + i * 3 + k}`, customer_id: id, customer_name: name,
      date: day(dueIn - 30), due_date: day(dueIn), balance: b, status: dueIn < 0 ? 'overdue' : 'sent', location_name: i % 2 ? 'EL EULMA' : 'ALGER' });
  });
  DEBTORS.push({ contact_id: id, contact_name: name, contact_type: 'customer', outstanding_receivable_amount: bal, mobile, phone: '',
    cf_owner: owner, custom_field_hash: { cf_owner: owner } });
});
DEBTORS.sort((a, b) => b.outstanding_receivable_amount - a.outstanding_receivable_amount);
// عميل بلا رصيد في آخر القائمة، كما يعيده زوهو
DEBTORS.push({ contact_id: '7418400000200099', contact_name: 'SARL PAYE', contact_type: 'customer', outstanding_receivable_amount: 0, cf_owner: 'AMINE' });

let newSeq = 100;
// فواتير غير مدفوعة لكل مورد
const BILLS = {};
for (const c of CONTACTS.filter((x) => x.contact_type === 'vendor')) {
  BILLS[c.contact_id] = [
    { bill_id: `${c.contact_id}7`, bill_number: `FA-${c.contact_id.slice(-2)}01`, date: day(-50), balance: 200000, vendor_id: c.contact_id },
    { bill_id: `${c.contact_id}8`, bill_number: `FA-${c.contact_id.slice(-2)}02`, date: day(-25), balance: 500000, vendor_id: c.contact_id },
  ];
}
const vendorPayments = {};

const log = [];
const txns = {};
// إيداعات سابقة، ودفعة مورد قديمة للشيك المظهّر ..29 (لتجربة التراجع عما أُنشئ قبل التطبيق)
txns['7418400000077019'] = { date: day(-9), line_items: [{ transaction_id: '7418400000000019' }], imported_transactions: [] };
txns['7418400000077020'] = { date: day(-20), line_items: [{ transaction_id: '7418400000000020' }], imported_transactions: [] };
vendorPayments['7418400000990029'] = {
  payment_id: '7418400000990029', payment_number: '278', vendor_name: 'BADR', amount: 835400,
  paid_through_account_id: '7418406000009849106', reference_number: 'cheque house fix', cf_n_cheque: '499308',
};
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

    // واجهة كلود الوهمية: قراءة ثابتة للشيك
    if (path.startsWith('/v1/messages') && req.method === 'POST') {
      const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (key !== 'mock-key') return send({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, 401);
      // الاتجاه: 180 لتجربة تدوير الصورة المقلوبة (يمكن تغييره بالمتغير MOCK_ROTATION)
      const reading = { amount: 250000, cheque_number: '6309259', note: '', rotation: process.env.MOCK_ROTATION || '180' };
      log.push('CLAUDE read');
      return setTimeout(() => send({
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: [{ type: 'text', text: JSON.stringify(reading) }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      }), 800);
    }
    if ((m = path.match(/^\/__revert\/(\d+)$/))) {
      const p = payments[m[1]];
      if (!p) return send({ error: 'nf' }, 404);
      p.deposit_details = [];
      p.custom_field_hash.cf_5d7197 = 'في الحوزة';
      return send({ ok: true });
    }
    if (req.headers.authorization !== `Zoho-oauthtoken ${TOKEN}`) return send({ code: 57, message: 'not authorized' }, 401);

    if ((m = path.match(/^\/books\/v3\/contacts\/(\d+)\/comments$/)) && req.method === 'POST') {
      const j = JSON.parse(body || '{}');
      log.push(`COMMENT ${m[1]} ${j.description}`);
      if (String(j.description).includes('#رفض')) return send({ code: 57, message: 'You are not authorized to perform this operation' }, 401);
      if (String(j.description).includes('#قطع')) { req.socket.destroy(); return; }
      return send({ code: 0, message: 'Comment added.', contact_comment: { comment_id: `9${Date.now()}`, description: j.description } }, 201);
    }
    if (path === '/books/v3/contacts' && req.method === 'GET' && !url.searchParams.get('search_text')) {
      const page = Number(url.searchParams.get('page') || 1);
      return send({ code: 0, contacts: page === 1 ? DEBTORS : [], page_context: { page, has_more_page: false } });
    }
    if (path === '/books/v3/contacts' && req.method === 'GET') {
      const q = (url.searchParams.get('search_text') || '').toLowerCase();
      const words = q.split(/\s+/).filter((w) => w.length > 1 && !['sarl', 'eurl', 'spa'].includes(w));
      const contacts = CONTACTS.filter((c) => words.some((w) => c.contact_name.toLowerCase().includes(w)));
      return send({ code: 0, contacts });
    }
    if (path === '/books/v3/bills' && req.method === 'GET') {
      return send({ code: 0, bills: BILLS[url.searchParams.get('vendor_id')] || [] });
    }
    if (path === '/books/v3/vendorpayments' && req.method === 'POST') {
      const j = JSON.parse(body);
      log.push(`VENDORPAY ${body}`);
      const chq = String(j.reference_number || '');
      if (chq.endsWith('8')) return send({ code: 9, message: 'Vendor payment rejected (mock)' }, 400);
      const id = `74184000009${String(++newSeq).padStart(5, '0')}`;
      vendorPayments[id] = { ...j, payment_id: id, payment_number: `VP${newSeq}`, vendor_name: (CONTACTS.find((c) => c.contact_id === j.vendor_id) || {}).contact_name,
        paid_through_account_id: j.paid_through_account_id, ...Object.fromEntries(j.custom_fields.map((f) => [`${f.api_name}_unformatted`, f.value])), cf_n_cheque: String(j.custom_fields.find((f) => f.api_name === 'cf_n_cheque')?.value ?? '') };
      if (chq.endsWith('6')) { req.socket.destroy(); return; }
      return send({ code: 0, vendorpayment: { payment_id: id } });
    }
    if (path === '/books/v3/vendorpayments' && req.method === 'GET') {
      const amt = Number(url.searchParams.get('amount'));
      return send({ code: 0, vendorpayments: Object.values(vendorPayments).filter((v) => !amt || Number(v.amount) === amt) });
    }
    if ((m = path.match(/^\/books\/v3\/vendorpayments\/(\d+)$/)) && req.method === 'DELETE') {
      if (!vendorPayments[m[1]]) return send({ code: 1002, message: 'not found' }, 404);
      log.push(`DELETE VENDORPAY ${m[1]}`);
      delete vendorPayments[m[1]];
      return send({ code: 0, message: 'The payment has been deleted.' });
    }
    if (path === '/books/v3/invoices' && req.method === 'GET' && url.searchParams.get('status') === 'unpaid') {
      return send({ code: 0, invoices: COLL_INVOICES, page_context: { page: 1, has_more_page: false } });
    }
    if (path === '/books/v3/invoices' && req.method === 'GET') {
      return send({ code: 0, invoices: INVOICES[url.searchParams.get('customer_id')] || [] });
    }
    if (path === '/books/v3/customerpayments' && req.method === 'POST') {
      const j = JSON.parse(body);
      const cf = Object.fromEntries(j.custom_fields.map((f) => [f.api_name, f.value]));
      log.push(`CREATE ${body}`);
      const chq = String(cf.cf_n_cheque || '');
      if (!/^\d{7}$/.test(chq)) return send({ code: 9, message: 'Payment Mode: رقم الشيك إجباري: اكتب رقم الشيك (7 أرقام) قبل حفظ الدفعة' }, 400);
      if (chq.endsWith('7')) return send({ code: 9, message: 'Payment Mode: الدفعة بشيك: يجب اختيار وجهة الشيك في حقل Déposé vers' }, 400);
      const id = `74184000000${String(++newSeq).padStart(5, '0')}`;
      const contact = CONTACTS.find((c) => c.contact_id === j.customer_id);
      payments[id] = {
        payment_id: id, payment_number: `N${newSeq}`, customer_id: j.customer_id, customer_name: contact ? contact.contact_name : '?',
        amount: j.amount, date: j.date, account_id: j.account_id, account_name: j.account_id === CIH ? 'Cheques in Hand' : 'Endorsed Cheques',
        payment_mode: 'Check', location_name: j.location_id === '7418406000000093289' ? 'ALGER' : 'EL EULMA', location_id: j.location_id,
        currency_id: 'DZD1', created_by: 'ZEKRI', description: j.description,
        invoice_numbers: j.invoices.map((i) => i.invoice_id).join(','),
        invoices: j.invoices.map((i) => {
          const inv = (INVOICES[j.customer_id] || []).find((x) => x.invoice_id === i.invoice_id) || {};
          return { invoice_id: i.invoice_id, invoice_number: inv.invoice_number, date: inv.date, amount_applied: i.amount_applied, total: inv.balance, balance: (inv.balance || 0) - i.amount_applied };
        }),
        deposit_details: [], has_attachment: false, documents: [], last_modified_time: new Date().toISOString(),
        custom_field_hash: { ...cf, cf_023de7: '✔ كاملة', cf_a1dfce: `CHQ-${chq}`, cf_a1dfce_unformatted: `74184000008${String(newSeq).padStart(5, '0')}` },
      };
      if (chq.endsWith('4')) { req.socket.destroy(); return; }
      return send({ code: 0, payment: { payment_id: id } });
    }
    if ((m = path.match(/^\/books\/v3\/customerpayments\/(\d+)\/attachment$/)) && req.method === 'POST') {
      const p = payments[m[1]];
      if (!p) return send({ code: 1002, message: 'not found' }, 404);
      log.push(`ATTACH ${m[1]} ${body.length} bytes`);
      p.has_attachment = true;
      p.documents = [...(p.documents || []), { document_id: `D${m[1]}`, file_type: 'jpg', file_name: 'cheque.jpg', attachment_order: (p.documents || []).length + 1 }];
      return send({ code: 0, message: 'The document has been attached.' });
    }

    if (path === '/books/v3/customerpayments' && req.method === 'GET') {
      const cust = url.searchParams.get('customer_id');
      const list = Object.values(payments).filter((p) => !cust || p.customer_id === cust).map((p) => ({ ...p, ...p.custom_field_hash }));
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
      if (req.method === 'DELETE') {
        log.push(`DELETE PAYMENT ${m[1]}`);
        delete payments[m[1]];
        return send({ code: 0, message: 'The payment has been deleted.' });
      }
      if (req.method === 'PUT') {
        log.push(`PUT ${m[1]} ${body}`);
        if (m[1].endsWith('6')) return send({ code: 9, message: 'fail' }, 400);
        for (const f of JSON.parse(body).custom_fields) p.custom_field_hash[f.api_name] = f.value;
        // تعديل الشيك: الحقول الأساسية والفواتير
        const j = JSON.parse(body);
        if (j.date) {
          if (!/^\d{7}$/.test(String(p.custom_field_hash.cf_n_cheque))) return send({ code: 9, message: 'رقم الشيك إجباري (7 أرقام)' }, 400);
          // زوهو يرفض إعادة إرسال الفواتير الحالية كما هي
          if (j.invoices && j.amount === p.amount) return send({ code: 9, message: 'The amount entered is more than the balance due for the selected invoices.' }, 400);
          Object.assign(p, { date: j.date, account_id: j.account_id, location_id: j.location_id, description: j.description ?? p.description,
            account_name: j.account_id === CIH ? 'Cheques in Hand' : 'Endorsed Cheques',
            location_name: j.location_id === '7418406000000093289' ? 'ALGER' : 'EL EULMA' });
        }
        if (j.amount !== undefined) {
          p.amount = j.amount;
          p.invoices = j.invoices.map((i) => {
            const inv = (INVOICES[p.customer_id] || []).find((x) => x.invoice_id === i.invoice_id) || (p.invoices || []).find((x) => x.invoice_id === i.invoice_id) || {};
            return { invoice_id: i.invoice_id, invoice_number: inv.invoice_number, date: inv.date, amount_applied: i.amount_applied, total: inv.total || inv.balance, balance: 0 };
          });
          log.push(`EDIT ${m[1]} amount=${j.amount} invoices=${j.invoices.length}`);
        }
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
        const id = `74184000000770${String(++txnSeq + 50).padStart(2, '0')}`;
        txns[id] = { date: j.date, line_items: pid.endsWith('5') ? [{ transaction_id: 'other' }] : j.line_items };
        payments[pid].deposit_details = [{ deposit_id: id }];
        send({ code: 0, banktransaction: { transaction_id: id } });
      };
      if (pid.endsWith('8')) { setTimeout(create, 1500); return; }
      return create();
    }
    if ((m = path.match(/^\/books\/v3\/banktransactions\/(\d+)$/))) {
      if (!txns[m[1]]) return send({ code: 1002, message: 'not found' }, 404);
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

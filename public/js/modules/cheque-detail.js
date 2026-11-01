// صفحة تفاصيل الشيك: كل ما في زوهو عن الشيك، دون الحاجة إلى فتح زوهو. قراءة فقط.
(function () {
  const { api, el, ltr, fmtAmount, fmtDate, fmtDateTime } = window.Shikati;
  const { statusBadge, chequeImage } = window.ShikatiChequesUI;
  const LOCK_TEXT = {
    pending: 'الإيداع قيد التنفيذ الآن',
    done: 'سجّل التطبيق إيداعه',
    unknown: 'بانتظار التحقق: انقطع الرد بعد محاولة الإيداع',
    failed: 'محاولة إيداع لم تتم',
  };
  const ACTION_TEXT = { deposit: 'إيداع', 'deposit.release': 'تحرير القفل', 'deposit.reverted': 'إلغاء الإيداع في زوهو' };

  // صف «عنوان: قيمة». القيمة الفارغة تظهر بشرطة.
  function row(label, value, opts = {}) {
    const empty = value === '' || value === null || value === undefined;
    const v = empty
      ? el('span', { class: 'muted', text: '—' })
      : (typeof value === 'string' && opts.ltr ? ltr(value, 'num') : value);
    return el('div', { class: 'kv' }, el('dt', { text: label }), el('dd', {}, v, opts.after ? el('span', { class: 'muted small', text: ' · ' + opts.after }) : null));
  }

  function block(title, ...children) {
    return el('section', { class: 'd-block' }, el('h2', { text: title }), ...children);
  }

  function view(d) {
    const parts = [];

    parts.push(el('div', { class: 'd-head' },
      el('div', { class: 'd-customer', text: d.customer }),
      el('div', { class: 'd-amount display' }, ltr(fmtAmount(d.amount))),
      el('div', { class: 'd-badges' },
        statusBadge(d.status),
        d.destination ? el('span', { class: 'badge dest', text: 'الوجهة: ' + d.destination }) : el('span', { class: 'badge warn', text: 'الوجهة غير محددة' }))));

    if (d.box_alert) parts.push(el('div', { class: 'note alert', text: 'صندوق غير مطابق: ' + d.box_alert }));
    if (d.app.lock && d.app.lock.state === 'unknown') {
      parts.push(el('div', { class: 'note alert', text: 'بانتظار التحقق: انقطع الرد بعد محاولة إيداع هذا الشيك. تحقق في صفحة الإدارة قبل أي محاولة جديدة.' }));
    }

    const img = d.has_image
      ? chequeImage({ id: d.id, has_image: true }, 'img-big')
      : d.drive_url
        ? el('a', { class: 'img-empty img-big', href: d.drive_url, target: '_blank', rel: 'noopener noreferrer', text: 'الصورة في غوغل درايف: اضغط لفتحها' })
        : el('div', { class: 'img-empty img-big', text: 'لا توجد صورة لهذا الشيك' });
    parts.push(el('div', { class: 'd-image' }, img));

    parts.push(block('بيانات الشيك', el('dl', { class: 'kvs' },
      row('رقم الشيك', d.cheque_number, { ltr: true }),
      row('البنك الساحب', d.bank),
      row('تاريخ الاستلام', fmtDate(d.date), { ltr: true }),
      row('الموقع', d.location),
      row('سجّله', d.created_by),
      d.captured_at ? row('وقت التصوير', d.captured_at, { ltr: true }) : null,
    )));

    parts.push(block('في زوهو', el('dl', { class: 'kvs' },
      row('رقم الدفعة', d.number, { ltr: true }),
      row('الحساب', d.account, { ltr: true }),
      d.unused_amount ? row('مبلغ غير موزّع', fmtAmount(d.unused_amount), { ltr: true }) : null,
      d.refunds ? row('استردادات', String(d.refunds), { ltr: true }) : null,
      d.description ? row('الوصف', d.description) : null,
      d.fiscal !== undefined ? row('الملف الجبائي للعميل', d.fiscal || '') : null,
    )));

    parts.push(block('الفواتير المسدّدة بهذا الشيك',
      d.invoices.length
        ? el('ul', { class: 'd-list' }, d.invoices.map((i) => el('li', {},
          el('div', { class: 'd-line' }, ltr(i.number, 'num strong'), ltr(fmtAmount(i.applied), 'num strong')),
          el('div', { class: 'd-line muted small' },
            el('span', {}, 'بتاريخ ', ltr(fmtDate(i.date), 'num')),
            i.balance > 0 ? el('span', {}, 'باقي الفاتورة ', ltr(fmtAmount(i.balance), 'num')) : el('span', { text: 'سُدّدت كاملة' })))))
        : el('p', { class: 'muted small', text: 'الدفعة غير موزّعة على أي فاتورة.' })));

    parts.push(block('الإيداعات في زوهو',
      d.deposits.length
        ? el('ul', { class: 'd-list' }, d.deposits.map((x) => el('li', {},
          el('div', { class: 'd-line' }, el('span', { class: 'strong', text: x.account || 'حساب غير معروف' }), x.date ? ltr(fmtDate(x.date), 'num') : null))))
        : el('p', { class: 'muted small', text: 'لا يوجد إيداع مسجّل لهذه الدفعة.' })));

    parts.push(block('سجل العمليات',
      d.log.length
        ? el('ol', { class: 'd-log' }, d.log.map((l) => el('li', { text: l })))
        : el('p', { class: 'muted small', text: 'لا توجد عمليات مسجّلة بعد.' })));

    if (d.app.lock || d.app.history.length) {
      parts.push(block('في التطبيق',
        d.app.lock ? el('p', {},
          el('span', { class: 'strong', text: LOCK_TEXT[d.app.lock.state] || d.app.lock.state }),
          d.app.lock.by ? el('span', { class: 'muted', text: ' · ' + d.app.lock.by }) : null,
          d.app.lock.started_at ? el('span', { class: 'muted' }, ' · ', ltr(fmtDateTime(d.app.lock.started_at), 'num')) : null) : null,
        d.app.history.length ? el('ul', { class: 'd-list' }, d.app.history.map((h) => el('li', {},
          el('div', { class: 'd-line' }, el('span', { class: 'strong', text: ACTION_TEXT[h.action] || h.action }), ltr(fmtDateTime(h.at), 'num muted small')),
          el('div', { class: 'muted small', text: [h.username, h.details].filter(Boolean).join(' · ') })))) : null));
    }
    return parts;
  }

  async function render(box, id, ctx) {
    const back = el('button', { type: 'button', class: 'btn-plain back', text: 'رجوع' });
    back.addEventListener('click', ctx.onBack);
    const body = el('div', { class: 'detail', 'aria-live': 'polite' }, el('p', { class: 'muted', text: 'جارٍ التحميل…' }));
    box.replaceChildren(el('div', { class: 'toolbar' }, back, el('span', { class: 'muted', text: 'تفاصيل الشيك' })), body);
    try {
      const d = await api('/api/m/cheques/detail/' + encodeURIComponent(id));
      if (!box.isConnected) return;
      body.replaceChildren(...view(d));
      document.title = 'شيك ' + d.customer;
    } catch (e) {
      body.replaceChildren(el('div', { class: 'error-box', text: e.message }));
    }
  }

  window.ShikatiChequeDetail = { render };
})();

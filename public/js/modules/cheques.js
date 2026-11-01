// قسم «شيكاتي»: عرض فقط في المرحلة الأولى
(function () {
  const { api, el, ltr, fmtAmount, fmtDate, fmtTime } = window.Shikati;
  const LATE_DAYS = 7;

  function daysText(n) {
    if (n === 0) return 'اليوم';
    if (n === 1) return 'منذ يوم';
    if (n === 2) return 'منذ يومين';
    if (n <= 10) return `منذ ${n} أيام`;
    return `منذ ${n} يوماً`;
  }

  const LOCK_LABELS = { pending: 'الإيداع قيد التنفيذ', unknown: 'بانتظار التحقق', done: 'سُجّل إيداعه' };

  function chequeItem(c, opts = {}) {
    const late = c.days > LATE_DAYS && !opts.noAge;
    let action = null;
    if (opts.depositable) {
      action = c.lock
        ? el('div', { class: 'item-action' }, el('span', { class: 'badge', text: LOCK_LABELS[c.lock] || c.lock }))
        : el('div', { class: 'item-action' },
            el('button', { type: 'button', class: 'btn-primary btn-deposit', text: 'أودعت', onclick: () => opts.onDeposit(c) }));
    }
    return el('li', { class: 'item' },
      el('div', { class: 'customer', text: c.customer }),
      el('div', { class: 'amount' }, ltr(fmtAmount(c.amount), 'num')),
      el('div', { class: 'details' },
        el('span', {}, 'شيك رقم ', c.cheque_number ? ltr(c.cheque_number, 'num') : el('span', { text: 'غير مسجّل' })),
        el('span', {}, 'استلام ', ltr(fmtDate(c.date), 'num')),
        c.location ? el('span', { text: c.location }) : null,
        opts.showStatus ? el('span', { class: 'badge', text: c.status }) : null,
      ),
      opts.noAge ? el('div') : el('div', { class: 'age' + (late ? ' late' : ''), text: daysText(c.days) + (late ? ' — متأخر' : '') }),
      action,
    );
  }

  function block(title, sec, opts = {}) {
    const meta = sec.count
      ? el('span', { class: 'meta' }, `${sec.count} شيك · `, ltr(fmtAmount(sec.total), 'num'))
      : el('span', { class: 'meta', text: 'لا شيء' });
    return el('section', { class: 'block' },
      el('div', { class: 'block-head' }, el('h2', { text: title }), opts.hideTotal ? null : meta),
      opts.note ? el('div', { class: 'note ' + (opts.noteClass || ''), text: opts.note }) : null,
      sec.count
        ? el('ul', { class: 'list' }, sec.items.map((c) => chequeItem(c, opts)))
        : el('div', { class: 'empty', text: opts.emptyText || 'لا توجد شيكات في هذا القسم.' }),
    );
  }

  // بطاقة التأكيد قبل الإيداع. تعيد true إن نجح الطلب أو تغيّرت حالة الشيك.
  function confirmDeposit(c) {
    return new Promise((resolve) => {
      const status = el('div', { class: 'form-error', role: 'alert' });
      const okBtn = el('button', { type: 'button', class: 'btn-primary', text: 'تأكيد الإيداع' });
      const cancelBtn = el('button', { type: 'button', class: 'btn-plain', text: 'إلغاء' });
      const dlg = el('dialog', { class: 'confirm', 'aria-labelledby': 'dlg-title' },
        el('h2', { id: 'dlg-title', text: 'تأكيد إيداع شيك في بنك AGB' }),
        el('dl', { class: 'facts' },
          el('dt', { text: 'العميل' }), el('dd', { text: c.customer }),
          el('dt', { text: 'المبلغ' }), el('dd', {}, ltr(fmtAmount(c.amount), 'num strong')),
          el('dt', { text: 'رقم الشيك' }), el('dd', {}, c.cheque_number ? ltr(c.cheque_number, 'num strong') : el('span', { text: 'غير مسجّل' })),
        ),
        el('p', { class: 'muted small', text: 'تأكد أن الشيك سُلِّم فعلاً للبنك. سيُسجَّل الإيداع في زوهو باسمك.' }),
        status,
        el('div', { class: 'dlg-actions' }, okBtn, cancelBtn),
      );
      let changed = false;
      let busy = false;
      const close = () => { if (busy) return; dlg.close(); dlg.remove(); resolve(changed); };
      cancelBtn.addEventListener('click', close);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
      okBtn.addEventListener('click', async () => {
        busy = true;
        okBtn.disabled = true; cancelBtn.disabled = true;
        okBtn.textContent = 'جارٍ التسجيل…';
        status.className = 'form-error';
        status.textContent = '';
        try {
          const r = await api('/api/m/cheques/deposit', { method: 'POST', body: {
            payment_id: c.id, amount: c.amount, cheque_number: c.cheque_number,
          } });
          changed = true;
          status.className = r.warning ? 'form-warn' : 'form-ok';
          status.textContent = r.warning || r.message || 'تم.';
          okBtn.remove();
          cancelBtn.textContent = 'إغلاق';
        } catch (e) {
          changed = true; // الحالة ربما تغيّرت، فنحدّث القائمة بعد الإغلاق
          status.textContent = e.message;
          okBtn.remove();
          cancelBtn.textContent = 'إغلاق';
        } finally {
          busy = false;
          cancelBtn.disabled = false;
        }
      });
      document.body.append(dlg);
      dlg.showModal();
      okBtn.focus();
    });
  }

  function renderData(root, d, onRefresh) {
    const parts = [];

    parts.push(el('div', { class: 'kpi' },
      el('div', { class: 'label', text: 'شيكات تنتظر الإيداع' }),
      el('div', { class: 'value display' }, ltr(fmtAmount(d.waiting.total))),
      el('div', { class: 'sub', text: `${d.waiting.count} شيك في الحوزة` }),
    ));

    const refreshBtn = el('button', { type: 'button', class: 'btn-plain', onclick: onRefresh, text: 'تحديث' });
    parts.push(el('div', { class: 'toolbar' },
      el('span', { class: 'muted' }, 'آخر تحديث ', ltr(fmtTime(d.generated_at), 'num')),
      refreshBtn,
    ));

    if (d.rejected.count) {
      parts.push(block('شيكات مرفوضة', d.rejected, { note: 'تحتاج متابعة مع العميل.', noteClass: 'alert' }));
    }
    parts.push(block('في الحوزة للإيداع في بنك AGB', d.agb_in_hand, {
      depositable: d.can_deposit,
      onDeposit: async (c) => { if (await confirmDeposit(c)) onRefresh(); },
    }));
    parts.push(block('في الحوزة للإيداع في بنك روستمية', d.rostomia_in_hand, { note: 'للعرض فقط.' }));
    if (d.no_destination.count) {
      parts.push(block('في الحوزة والوجهة غير محددة', d.no_destination, {
        note: 'حدّد وجهة الإيداع لهذه الشيكات في زوهو بوكس.', noteClass: 'warn',
      }));
    }
    parts.push(block('في بنك AGB بانتظار التحصيل', d.agb_pending_collection, {}));
    parts.push(block('آخر 5 شيكات أُودعت في بنك AGB', d.agb_recent, {
      showStatus: true, noAge: true, hideTotal: true, emptyText: 'لا توجد إيداعات مسجّلة بعد.',
    }));

    root.replaceChildren(...parts);
  }

  async function render(root) {
    let busy = false;
    async function load(refresh) {
      if (busy) return;
      busy = true;
      try {
        const d = await api('/api/m/cheques' + (refresh ? '?refresh=1' : ''));
        renderData(root, d, () => load(true));
      } catch (e) {
        root.replaceChildren(
          el('div', { class: 'error-box', text: e.message }),
          el('div', { class: 'toolbar' }, el('span'), el('button', { type: 'button', class: 'btn-plain', onclick: () => load(true), text: 'إعادة المحاولة' })),
        );
      } finally {
        busy = false;
      }
    }
    await load(false);
  }

  window.ShikatiModules = window.ShikatiModules || {};
  window.ShikatiModules.cheques = { render };
})();

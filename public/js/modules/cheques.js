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

  function chequeItem(c, opts = {}) {
    const late = c.days > LATE_DAYS && !opts.noAge;
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
      note: d.can_deposit ? null : 'زر «أودعت» سيُضاف في المرحلة الثانية.',
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

// تعديل الشيك بعد تسجيله: الرقم والمبلغ والتاريخ والموقع والوجهة والصورة.
// المعاينة تعرض الفروق والتوزيع الجديد على الفواتير، ولا يُكتب شيء في زوهو قبل «حفظ التعديل».
(function () {
  const { api, toast, el, ltr, fmtAmount } = window.Shikati;

  function panel(d, reload) {
    const R = window.ShikatiChequeRegister;
    const e = d.edit;
    const openBtn = el('button', { type: 'button', class: 'btn-plain wide', text: 'تعديل الشيك' });
    const box = el('div', { class: 'hidden' });
    const section = el('section', { class: 'd-block' }, el('h2', { text: 'تعديل' }),
      e.allowed ? null : el('p', { class: 'muted small', text: e.blocker }),
      e.allowed ? openBtn : null, box);
    if (!e.allowed) return section;

    const form = {
      cheque_number: d.cheque_number || '', amount: d.amount, date: d.date || '',
      location: d.location_key, destination: d.destination || 'ELONAC', image: '',
    };
    const numberInput = el('input', { type: 'text', inputmode: 'numeric', dir: 'ltr', maxlength: '7', autocomplete: 'off', value: form.cheque_number });
    const amountInput = el('input', { type: 'text', inputmode: 'decimal', dir: 'ltr', autocomplete: 'off', value: String(form.amount) });
    const dateInput = el('input', { type: 'date', dir: 'ltr', value: form.date, max: new Date().toISOString().slice(0, 10) });
    const locChips = R.chipGroup('الموقع', [['ALGER', 'الجزائر'], ['EL EULMA', 'العلمة']], form.location, (v) => { form.location = v; });
    const destChips = R.chipGroup('الوجهة', Object.entries(R.DEST_LABELS), form.destination, (v) => { form.destination = v; });
    const fileInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
    const photoBtn = el('button', { type: 'button', class: 'btn-plain', text: 'تصوير صورة جديدة' });
    const photoBox = el('div', { class: 'reg-photo' });
    photoBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      try {
        form.image = await R.shrink(file);
      } catch (err) {
        toast(err.message, 'err');
        return;
      }
      photoBox.replaceChildren(el('img', { class: 'cheque-img reg-preview', src: form.image, alt: 'الصورة الجديدة' }));
      photoBtn.textContent = 'إعادة التصوير';
    });
    const error = el('div', { role: 'alert' });
    const reviewBtn = el('button', { type: 'button', class: 'btn-primary wide', text: 'مراجعة التعديل' });
    const cancelBtn = el('button', { type: 'button', class: 'btn-plain wide', text: 'إلغاء' });

    box.append(
      R.field('رقم الشيك', numberInput),
      R.field('المبلغ', amountInput, el('p', { class: 'muted small', text: 'إن تغيّر المبلغ يُعاد توزيعه آلياً على أقدم فواتير العميل.' })),
      R.field('تاريخ الاستلام', dateInput),
      el('div', { class: 'field' }, el('span', { class: 'label', text: 'الموقع' }), locChips),
      el('div', { class: 'field' }, el('span', { class: 'label', text: 'الوجهة' }), destChips),
      el('div', { class: 'field' }, el('span', { class: 'label', text: 'الصورة' }), photoBtn, fileInput, photoBox),
      error, reviewBtn, cancelBtn);

    openBtn.addEventListener('click', () => { box.classList.remove('hidden'); openBtn.classList.add('hidden'); numberInput.focus(); });
    cancelBtn.addEventListener('click', () => reload());

    const body = () => ({
      payment_id: d.id, version: e.version,
      cheque_number: numberInput.value.trim(), amount: R.parseAmount(amountInput.value),
      date: dateInput.value, location: form.location, destination: form.destination, image: form.image || undefined,
    });

    reviewBtn.addEventListener('click', async () => {
      error.className = '';
      error.textContent = '';
      const b = body();
      if (!/^\d{7}$/.test(b.cheque_number)) { error.className = 'form-error'; error.textContent = 'رقم الشيك يجب أن يكون 7 أرقام.'; return; }
      if (!b.amount) { error.className = 'form-error'; error.textContent = 'المبلغ غير صالح.'; return; }
      reviewBtn.disabled = true;
      reviewBtn.textContent = 'جارٍ التحقق…';
      try {
        const p = await api('/api/m/cheques/edit/preview', { method: 'POST', body: b });
        confirm(b, p);
      } catch (err) {
        error.className = 'form-error';
        error.textContent = err.message;
      } finally {
        reviewBtn.disabled = false;
        reviewBtn.textContent = 'مراجعة التعديل';
      }
    });

    function changeRow(c) {
      const money = c.label === 'المبلغ';
      // كل قيمة معزولة الاتجاه، فيبقى السهم من القديم (يميناً) إلى الجديد (يساراً) حتى مع النص اللاتيني
      const show = (v) => (money ? ltr(fmtAmount(Number(v)), 'num') : (/^[\d\s.-]+$/.test(v) ? ltr(v, 'num') : el('bdi', { text: v })));
      return el('li', {}, el('div', { class: 'd-line' },
        el('span', { class: 'strong', text: c.label }),
        c.from ? el('span', {}, show(c.from), ' ← ', show(c.to)) : el('span', { text: c.to })));
    }

    function confirm(b, p) {
      const message = el('div', { role: 'alert' });
      const okBtn = el('button', { type: 'button', class: 'btn-primary', text: 'حفظ التعديل' });
      const noBtn = el('button', { type: 'button', class: 'btn-plain', text: 'رجوع' });
      const dlg = el('dialog', { class: 'confirm', 'aria-labelledby': 'edit-title' },
        el('h2', { id: 'edit-title', text: 'تأكيد تعديل الشيك' }),
        el('p', { class: 'muted small', text: d.customer }),
        el('ul', { class: 'd-list' }, p.changes.map(changeRow)),
        p.allocation ? el('h3', { class: 'reg-sub', text: 'التوزيع الجديد على الفواتير' }) : null,
        p.allocation ? R.allocList(p.allocation.lines, 'لا فواتير غير مدفوعة لهذا العميل.') : null,
        p.allocation && p.allocation.unused > 0 ? el('p', { class: 'note warn' }, 'يبقى ', ltr(fmtAmount(p.allocation.unused), 'num strong'), ' رصيداً للعميل.') : null,
        b.image ? el('img', { class: 'cheque-img reg-preview', src: b.image, alt: 'الصورة الجديدة' }) : null,
        message,
        el('div', { class: 'dlg-actions' }, okBtn, noBtn));
      let busy = false;
      let after = null;
      const close = () => { if (busy) return; dlg.close(); dlg.remove(); if (after) after(); };
      noBtn.addEventListener('click', close);
      dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });
      okBtn.addEventListener('click', async () => {
        busy = true;
        okBtn.disabled = true;
        noBtn.disabled = true;
        okBtn.textContent = 'جارٍ الحفظ…';
        try {
          const res = await api('/api/m/cheques/edit', { method: 'POST', body: b });
          toast(res.warning || res.message, res.warning ? 'warn' : 'ok');
          after = reload;
          busy = false;
          close();
          return;
        } catch (err) {
          message.className = 'form-error';
          message.textContent = err.message;
          okBtn.remove();
          // انقطاع الرد: لا إعادة، وتُحدَّث الصفحة عند الإغلاق
          if (err.status === 504 || err.status === 0) after = reload;
        }
        busy = false;
        noBtn.disabled = false;
        noBtn.textContent = 'إغلاق';
      });
      document.body.append(dlg);
      dlg.showModal();
      noBtn.focus();
    }

    return section;
  }

  window.ShikatiChequeEdit = { panel };
})();

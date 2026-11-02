// تسجيل شيك جديد: صورة الشيك ← قراءة المبلغ والرقم بكلود ← اختيار العميل بالبحث ← دفعة في زوهو،
// ومع وجهة «مورد آخر» دفعة مورد من حساب الشيكات المظهّرة.
// القراءة اقتراح فقط، ولا يُكتب شيء في زوهو قبل ضغط «تسجيل الشيك» في بطاقة التأكيد.
(function () {
  const { api, toast, el, ltr, fmtAmount, fmtDate } = window.Shikati;
  const MAX_SIDE = 1600;
  const DEST_LABELS = { ELONAC: 'بنك إيلوناك', ROSTOMIA: 'بنك الرستمية', 'Autre Fournisseur': 'مورد آخر' };
  const LOC_KEY = 'shikati-location';
  const LOC_FROM_LABEL = { 'الجزائر': 'ALGER', 'العلمة': 'EL EULMA' };

  const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  const parseAmount = (s) => {
    const v = Number(String(s || '').replace(/[\s ]/g, '').replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  };

  // تصغير الصورة في الهاتف قبل إرسالها، فتصل أسرع وتبقى مقروءة
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('تعذّرت قراءة الصورة من الهاتف.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('صيغة الصورة غير مدعومة. صوّر الشيك من جديد.'));
        img.onload = () => {
          const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function field(label, control, hint) {
    return el('div', { class: 'field' }, el('label', {}, el('span', { text: label }), control), hint || null);
  }

  function chipGroup(label, options, value, onPick) {
    const row = el('div', { class: 'chips', role: 'group', 'aria-label': label });
    const set = (v) => row.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
    for (const [v, text] of options) {
      const b = el('button', { type: 'button', class: 'chip', 'data-v': v, text });
      b.addEventListener('click', () => { set(v); onPick(v); });
      row.append(b);
    }
    set(value);
    return row;
  }

  // بحث واختيار جهة اتصال: عميل أو مورد. البحث في الخادم يستبعد النوع الآخر.
  function partyPicker(kind, onChange) {
    const isVendor = kind === 'vendor';
    const input = el('input', { type: 'search', placeholder: isVendor ? 'اكتب جزءاً من اسم المورد' : 'اكتب جزءاً من اسم العميل', autocomplete: 'off', enterkeyhint: 'search' });
    const results = el('ul', { class: 'pick-list' });
    const chosen = el('div', { class: 'chosen hidden' });
    let value = null;
    let timer = 0;
    let seq = 0;
    async function search(q) {
      const my = ++seq;
      if (q.trim().length < 2) { results.replaceChildren(); return; }
      try {
        const data = await api(`/api/m/cheques/register/${isVendor ? 'vendors' : 'customers'}?q=` + encodeURIComponent(q.trim()));
        const list = isVendor ? data.vendors : data.customers;
        if (my !== seq) return;
        results.replaceChildren(...(list.length
          ? list.map((c) => {
            const b = el('button', { type: 'button', text: c.name });
            b.addEventListener('click', () => choose(c));
            return el('li', {}, b);
          })
          : [el('li', { class: 'muted small', text: isVendor ? 'لا مورد بهذا الاسم.' : 'لا عميل بهذا الاسم.' })]));
      } catch (e) {
        if (my === seq) results.replaceChildren(el('li', { class: 'form-error', text: e.message }));
      }
    }
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => search(input.value), 300);
    });
    function choose(c) {
      value = c;
      results.replaceChildren();
      input.classList.add('hidden');
      const change = el('button', { type: 'button', class: 'btn-plain', text: 'تغيير' });
      change.addEventListener('click', () => {
        value = null;
        chosen.classList.add('hidden');
        input.classList.remove('hidden');
        input.focus();
        if (onChange) onChange(null);
      });
      chosen.replaceChildren(el('span', { class: 'strong', text: c.name }), change);
      chosen.classList.remove('hidden');
      if (onChange) onChange(c);
    }
    return { box: el('div', {}, input, chosen, results), get: () => value };
  }

  // قائمة توزيع المبلغ على فواتير العميل أو المورد
  function allocList(lines, emptyText) {
    if (!lines.length) return el('p', { class: 'muted small', text: emptyText });
    return el('ul', { class: 'd-list' }, lines.map((l) => el('li', {},
      el('div', { class: 'd-line' }, ltr(l.number, 'num strong'), ltr(fmtAmount(l.applied), 'num strong')),
      el('div', { class: 'd-line muted small' },
        el('span', {}, 'بتاريخ ', ltr(fmtDate(l.date), 'num')),
        l.applied < l.balance ? el('span', {}, 'يبقى منها ', ltr(fmtAmount(Math.round((l.balance - l.applied) * 100) / 100), 'num')) : el('span', { text: 'تُسدَّد كاملة' })))));
  }

  function confirmDialog(form, preview) {
    return new Promise((resolve) => {
      const message = el('div', { role: 'alert' });
      const okBtn = el('button', { type: 'button', class: 'btn-primary', text: 'تسجيل الشيك' });
      const cancelBtn = el('button', { type: 'button', class: 'btn-plain', text: 'رجوع للتعديل' });
      const row = (k, v) => el('div', { class: 'kv' }, el('dt', { text: k }), el('dd', {}, v));
      const alloc = allocList(preview.lines, 'لا فواتير غير مدفوعة لهذا العميل.');
      const endorsed = form.destination === 'Autre Fournisseur';

      const dlg = el('dialog', { class: 'confirm', 'aria-labelledby': 'reg-title' },
        el('h2', { id: 'reg-title', text: 'تأكيد تسجيل الشيك' }),
        form.image ? el('img', { class: 'cheque-img reg-preview', src: form.image, alt: 'صورة الشيك' }) : el('div', { class: 'img-empty img-big', text: 'دون صورة' }),
        el('dl', { class: 'kvs' },
          row('العميل', el('span', { text: form.customer.name })),
          row('المبلغ', ltr(fmtAmount(form.amount), 'num strong')),
          row('رقم الشيك', ltr(form.cheque_number, 'num')),
          row('الوجهة', el('span', { text: DEST_LABELS[form.destination] })),
          endorsed ? row('المورد', el('span', { text: form.vendor.name })) : null,
          row('الموقع', el('span', { text: form.locationLabel }))),
        el('h3', { class: 'reg-sub', text: endorsed ? 'التوزيع على فواتير العميل' : 'التوزيع على الفواتير' }),
        alloc,
        preview.unused > 0 ? el('p', { class: 'note warn' }, 'يبقى ', ltr(fmtAmount(preview.unused), 'num strong'), ' رصيداً مسبقاً للعميل.') : null,
        endorsed ? el('h3', { class: 'reg-sub', text: 'التوزيع على فواتير المورد' }) : null,
        endorsed ? allocList(preview.vendor.lines, 'لا فواتير غير مدفوعة لهذا المورد.') : null,
        endorsed && preview.vendor.unused > 0 ? el('p', { class: 'note warn' }, 'يبقى ', ltr(fmtAmount(preview.vendor.unused), 'num strong'), ' رصيداً مسبقاً عند المورد.') : null,
        el('p', { class: 'muted small', text: 'تأكد أن البيانات تطابق الشيك. سيُسجَّل في زوهو باسمك.' }),
        message,
        el('div', { class: 'dlg-actions' }, okBtn, cancelBtn));

      let busy = false;
      const close = (result) => { if (busy) return; dlg.close(); dlg.remove(); resolve(result); };
      cancelBtn.addEventListener('click', () => close(null));
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
      okBtn.addEventListener('click', async () => {
        busy = true;
        okBtn.disabled = true;
        cancelBtn.disabled = true;
        okBtn.textContent = 'جارٍ التسجيل…';
        try {
          const res = await api('/api/m/cheques/register', { method: 'POST', body: {
            request_id: form.requestId, customer_id: form.customer.id, customer: form.customer.name,
            amount: form.amount, cheque_number: form.cheque_number,
            destination: form.destination, location: form.location, image: form.image || undefined,
            vendor_id: endorsed ? form.vendor.id : undefined, vendor: endorsed ? form.vendor.name : undefined,
          } });
          busy = false;
          close(res);
        } catch (e) {
          busy = false;
          message.className = 'form-error';
          message.textContent = e.message;
          cancelBtn.disabled = false;
          if (e.status === 504 || e.status === 0) {
            // لا إعادة: لا نعرف إن كان زوهو أنشأ الدفعة
            okBtn.remove();
            cancelBtn.textContent = 'إغلاق';
            form.locked = true;
          } else {
            okBtn.disabled = false;
            okBtn.textContent = 'تسجيل الشيك';
          }
        }
      });
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  async function render(box, ctx) {
    box.replaceChildren(el('p', { class: 'muted', text: 'جارٍ التحميل…' }));
    let opts;
    try {
      opts = await api('/api/m/cheques/register/options');
    } catch (e) {
      box.replaceChildren(el('div', { class: 'error-box', text: e.message }));
      return;
    }
    if (!opts.can_register) {
      box.replaceChildren(el('div', { class: 'empty', text: 'ليست لديك صلاحية تسجيل الشيكات.' }));
      return;
    }

    let storedLoc = '';
    try { storedLoc = localStorage.getItem(LOC_KEY) || ''; } catch { /* التخزين غير متاح */ }
    const form = {
      requestId: newRequestId(), image: '', customer: null, vendor: null, amount: null, cheque_number: '',
      destination: 'ELONAC', location: LOC_FROM_LABEL[storedLoc] || '', locationLabel: '', locked: false,
    };

    // ——— الصورة ———
    const fileInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
    const shootBtn = el('button', { type: 'button', class: 'btn-primary wide', text: 'تصوير الشيك' });
    const photoBox = el('div', { class: 'reg-photo' });
    const readStatus = el('div', { 'aria-live': 'polite' });
    shootBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      try {
        form.image = await shrink(file);
      } catch (e) {
        toast(e.message, 'err');
        return;
      }
      photoBox.replaceChildren(el('img', { class: 'cheque-img reg-preview', src: form.image, alt: 'صورة الشيك' }));
      shootBtn.textContent = 'إعادة التصوير';
      if (!opts.reader) {
        readStatus.className = 'note';
        readStatus.textContent = 'القراءة الآلية غير مُعدّة بعد. اكتب البيانات بيدك.';
        return;
      }
      readStatus.className = 'note';
      readStatus.textContent = 'جارٍ قراءة الشيك…';
      shootBtn.disabled = true;
      try {
        const shot = form.image;
        const { reading } = await api('/api/m/cheques/register/read', { method: 'POST', body: { image: shot } });
        applyReading(reading);
        // الصورة تُدار قبل رفعها، فتظهر معتدلة في التطبيق وفي زوهو
        if (reading.rotation && form.image === shot) {
          form.image = await window.ShikatiChequesUI.rotateDataUrl(shot, reading.rotation);
          photoBox.replaceChildren(el('img', { class: 'cheque-img reg-preview', src: form.image, alt: 'صورة الشيك' }));
        }
      } catch (e) {
        readStatus.className = 'note warn';
        readStatus.textContent = e.message;
      } finally {
        shootBtn.disabled = false;
      }
    });

    // ——— البيانات ———
    const customerPicker = partyPicker('customer', (c) => { form.customer = c; });
    const vendorPicker = partyPicker('vendor', (v) => { form.vendor = v; });
    const vendorField = field('المورد الذي سُلّم له الشيك', vendorPicker.box);
    vendorField.classList.toggle('hidden', form.destination !== 'Autre Fournisseur');
    const amountInput = el('input', { type: 'text', inputmode: 'decimal', dir: 'ltr', placeholder: '0.00', autocomplete: 'off' });
    const numberInput = el('input', { type: 'text', inputmode: 'numeric', dir: 'ltr', maxlength: '7', placeholder: '7 أرقام', autocomplete: 'off' });
    const locLabels = Object.fromEntries(opts.locations.map((l) => [l.key, l.label]));
    form.locationLabel = locLabels[form.location] || '';

    function applyReading(r) {
      const filled = [];
      if (r.amount) { amountInput.value = String(r.amount); filled.push('المبلغ'); }
      if (r.cheque_number) { numberInput.value = r.cheque_number; filled.push('الرقم'); }
      readStatus.className = r.note ? 'note warn' : 'note ok';
      readStatus.textContent = (filled.length ? 'قُرئ: ' + filled.join('، ') + '. راجعها مع الصورة.' : 'لم تُقرأ أي بيانات بثقة. اكتبها بيدك.')
        + (r.note ? ' ملاحظة: ' + r.note : '');
    }

    const destChips = chipGroup('الوجهة', opts.destinations.map((d) => [d, DEST_LABELS[d] || d]), form.destination, (v) => {
      form.destination = v;
      vendorField.classList.toggle('hidden', v !== 'Autre Fournisseur');
    });
    const locChips = chipGroup('الموقع', opts.locations.map((l) => [l.key, l.label]), form.location, (v) => { form.location = v; form.locationLabel = locLabels[v]; });

    const errorBox = el('div', { role: 'alert' });
    const submitBtn = el('button', { type: 'button', class: 'btn-primary wide', text: 'مراجعة وتسجيل' });
    submitBtn.addEventListener('click', async () => {
      errorBox.className = '';
      errorBox.textContent = '';
      form.amount = parseAmount(amountInput.value);
      form.cheque_number = numberInput.value.replace(/\D/g, '');
      const problems = [];
      if (!form.customer) problems.push('اختر العميل');
      if (form.destination === 'Autre Fournisseur' && !form.vendor) problems.push('اختر المورد');
      if (!form.amount) problems.push('اكتب المبلغ');
      if (!/^\d{7}$/.test(form.cheque_number) || form.cheque_number === '0000000') problems.push('رقم الشيك 7 أرقام');
      if (!form.location) problems.push('اختر الموقع');
      if (problems.length) {
        errorBox.className = 'form-error';
        errorBox.textContent = problems.join('، ') + '.';
        return;
      }
      if (form.locked) {
        errorBox.className = 'form-error';
        errorBox.textContent = 'محاولة التسجيل السابقة لم تُعرف نتيجتها. افتح «كل الشيكات» وتحقق قبل أي محاولة.';
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'جارٍ حساب التوزيع…';
      let preview;
      try {
        preview = await api('/api/m/cheques/register/preview', { method: 'POST', body: {
          customer_id: form.customer.id, amount: form.amount,
          vendor_id: form.destination === 'Autre Fournisseur' ? form.vendor.id : undefined,
        } });
      } catch (e) {
        errorBox.className = 'form-error';
        errorBox.textContent = e.message;
        return;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'مراجعة وتسجيل';
      }
      const res = await confirmDialog(form, preview);
      if (!res) return;
      toast(res.warning || 'تم تسجيل الشيك', res.warning ? 'warn' : 'ok');
      ctx.onDone(res.payment_id);
    });

    box.replaceChildren(el('div', { class: 'register' },
      el('section', { class: 'd-block' }, el('h2', { text: 'صورة الشيك' }), fileInput, photoBox, shootBtn, readStatus),
      el('section', { class: 'd-block' }, el('h2', { text: 'البيانات' }),
        field('العميل', customerPicker.box),
        field('المبلغ (دج)', amountInput),
        field('رقم الشيك', numberInput),
        el('div', { class: 'field' }, el('span', { class: 'label', text: 'الوجهة' }), destChips),
        vendorField,
        el('div', { class: 'field' }, el('span', { class: 'label', text: 'الموقع' }), locChips)),
      errorBox,
      submitBtn));
  }

  window.ShikatiChequeRegister = { render, partyPicker, allocList, chipGroup, field, shrink, parseAmount, DEST_LABELS };
})();

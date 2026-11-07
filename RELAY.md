# وسيط تجديد رمز زوهو في غوغل

## لماذا هذا الوسيط

خوادم كلاود فلير لا تصل إلى خادم الرموز الأمريكي لزوهو، فيرد كلاود فلير بالخطأ 1016، بينما تعمل واجهة زوهو بوكس نفسها بشكل طبيعي. أثبتت صفحة الفحص ذلك يوم 31/10/2026.

لذلك يجدّد سكربت صغير في حساب غوغل الخاص بك رمز الوصول، ويعيده للتطبيق. بقية التطبيق تتصل بزوهو بوكس مباشرة كما كانت.

## ما يفعله الوسيط وما لا يفعله

- **يفعل:** يجدّد رمز الوصول من زوهو، ويعيده لمن يرسل المفتاح المشترك الصحيح فقط، ويحتفظ به في ذاكرته حتى قرب انتهائه.
- **لا يفعل:** لا يقرأ ولا يكتب أي بيانات في زوهو بوكس، ولا يقبل الطلبات العادية من المتصفح.
- **الأسرار:** تنتقل أسرار زوهو الثلاثة كلها إلى الوسيط، وتُحذف من كلاود فلير، فتبقى في مكان واحد.

الشيفرة كاملة في الملف `relay/zoho-token-relay.gs`.

## الخطوة 1: المفتاح المشترك

أنشئ مفتاحاً عشوائياً من 40 حرفاً. في نافذة الأوامر (PowerShell) على جهازك:

```
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})
```

احفظ الناتج مؤقتاً في ملف نصي، فستضعه في مكانين.

## الخطوة 2: إنشاء السكربت

1. افتح الموقع التالي بحساب غوغل الخاص بك:

```
https://script.google.com
```

2. اضغط «New project»، وسمّه `shikati-zoho-relay`.
3. احذف كل ما في الملف `Code.gs`، والصق مكانه محتوى الملف `relay/zoho-token-relay.gs` من المستودع، ثم احفظ.

## الخطوة 3: أسرار الوسيط

1. اضغط أيقونة الترس «Project Settings» في القائمة الجانبية.
2. في أسفل الصفحة، قسم «Script Properties»، أضف الخصائص الأربع:

| الاسم | القيمة |
|---|---|
| `RELAY_KEY` | المفتاح المشترك من الخطوة 1 |
| `ZOHO_CLIENT_ID` | معرّف العميل من تطبيق (Self Client) |
| `ZOHO_CLIENT_SECRET` | سر العميل |
| `ZOHO_REFRESH_TOKEN` | اتركها، فالدالة في الخطوة 3 مكرر تملؤها تلقائياً |

3. اضغط «Save script properties».

## الخطوة 3 مكرر: رمز التجديد من داخل الوسيط

هذه الطريقة تتجنب أخطاء النسخ واللصق: الوسيط يستبدل الرمز المؤقت بنفسه ويحفظ رمز التجديد.

1. في لوحة مطوري زوهو افتح تطبيق (Self Client)، ثم «Generate Code»، وضع الصلاحية التالية، واختر مدة 10 دقائق:

```
ZohoBooks.customerpayments.READ
```

2. انسخ الرمز المؤقت، وأضفه فوراً في «Script Properties» باسم `ZOHO_CODE`، ثم احفظ.
3. ارجع إلى المحرر «Editor»، واختر الدالة `exchangeCode` من القائمة أعلى الشيفرة، ثم اضغط «Run».
4. افتح «Execution log» أسفل الصفحة. يجب أن ترى سطراً يبدأ بـ «تم حفظ رمز التجديد»، وفيه الصلاحيات ومركز البيانات.

الدالة تحذف الرمز المؤقت بعد استعماله، ولا تطبع أي رمز في السجل.

## الخطوة 4: النشر

1. اضغط «Deploy» ثم «New deployment».
2. من أيقونة الترس بجانب «Select type» اختر «Web app».
3. الإعدادات:
   - «Execute as»: اختر «Me».
   - «Who has access»: اختر «Anyone».
4. اضغط «Deploy». سيطلب غوغل الإذن بالاتصال بخدمة خارجية، فوافق عليه. قد تظهر صفحة تحذير لأن السكربت غير موثّق: اضغط «Advanced» ثم «Go to shikati-zoho-relay».
5. انسخ «Web app URL»، وهو ينتهي بـ `/exec`.

خيار «Anyone» ضروري لأن خادم التطبيق لا يملك حساب غوغل. الحماية هنا بالمفتاح المشترك: أي طلب بدونه يُرفض.

## الخطوة 5: كلاود فلير

من صفحة مشروع `shikati`، ثم «Settings»، ثم «Variables and Secrets»:

1. أضف سرّين جديدين بنوع «Secret»:

| الاسم | القيمة |
|---|---|
| `ZOHO_RELAY_URL` | الرابط المنتهي بـ `/exec` |
| `ZOHO_RELAY_KEY` | المفتاح المشترك نفسه من الخطوة 1 |

2. احذف الأسرار الثلاثة القديمة، فلم يعد التطبيق يحتاجها:

```
ZOHO_CLIENT_ID
ZOHO_CLIENT_SECRET
ZOHO_REFRESH_TOKEN
```

3. احذف الملف النصي الذي حفظت فيه المفتاح المشترك.

## الخطوة 6: التحقق

افتح صفحة الفحص وأنت داخل بحساب المدير:

```
https://shikati.zekri3047.workers.dev/api/admin/diag?refresh=1
```

النتيجة المتوقعة:

```
{"relay":{"status":200,"ok":true,"error":null}}
```

ثم افتح التطبيق، ويجب أن تظهر الشيكات.

## إن ظهر خطأ

| الخطأ | السبب |
|---|---|
| ‏`forbidden` | المفتاح المشترك مختلف بين غوغل وكلاود فلير، أو لم تحفظ خصائص السكربت |
| ‏`invalid_client` | معرّف العميل أو سرّه في خصائص السكربت غير صحيح |
| ‏`invalid_code` | رمز التجديد في خصائص السكربت غير صحيح |
| ‏`not_json` | الرابط غير صحيح، أو خيار «Who has access» ليس «Anyone» |
| ‏`too_many_requests` | زوهو يرفض مؤقتاً لكثرة طلبات تجديد الرمز في 10 دقائق. لا تحاول لمدة 15 دقيقة |
| ‏`zoho_refused` | زوهو رفض التجديد برسالة غير معروفة (نسخة الوسيط القديمة تسمّي كثرة الطلبات هكذا). انتظر 15 دقيقة، ثم شغّل `checkSetup` إن بقي |

## صلاحيات تعليقات المراجعة (قسم التحصيل)

منذ 7/11/2026 تُرسل كل مراجعة في قسم التحصيل تعليقاً على العميل في زوهو، فيحتاج رمز التجديد صلاحية إنشاء التعليقات على العملاء. كرر الخطوة «3 مكرر» بهذه القائمة الكاملة معاً، مفصولة بفاصلة دون مسافات:

```
ZohoBooks.customerpayments.READ,ZohoBooks.customerpayments.CREATE,ZohoBooks.customerpayments.UPDATE,ZohoBooks.banking.CREATE,ZohoBooks.banking.READ,ZohoBooks.banking.DELETE,ZohoBooks.invoices.READ,ZohoBooks.contacts.READ,ZohoBooks.vendorpayments.CREATE,ZohoBooks.bills.READ,ZohoBooks.vendorpayments.READ,ZohoBooks.vendorpayments.DELETE,ZohoBooks.customerpayments.DELETE,ZohoBooks.contacts.CREATE
```

الصلاحية الأخيرة هي الجديدة. قبل إضافتها يرفض زوهو التعليق بالرمز 57، فتبقى المراجعة في التطبيق بحالة «لم يُرسل إلى زوهو»، ويرسلها المدير بعد تحديث الرمز من شاشة التحصيل (قسم «لم تصل إلى زوهو»).

## صلاحيات تسجيل الشيك

تسجيل شيك جديد يحتاج إنشاء دفعات العملاء وقراءة الفواتير والعملاء. كرر الخطوة «3 مكرر» بهذه الصلاحيات معاً:

```
ZohoBooks.customerpayments.READ,ZohoBooks.customerpayments.CREATE,ZohoBooks.customerpayments.UPDATE,ZohoBooks.banking.CREATE,ZohoBooks.banking.READ,ZohoBooks.banking.DELETE,ZohoBooks.invoices.READ,ZohoBooks.contacts.READ,ZohoBooks.vendorpayments.CREATE,ZohoBooks.bills.READ,ZohoBooks.vendorpayments.READ,ZohoBooks.vendorpayments.DELETE,ZohoBooks.customerpayments.DELETE
```

صلاحيتا إنشاء دفعة المورد وقراءة فواتيره للتظهير لمورد، والثلاث الأخيرة للتراجع.

## صلاحيات المرحلة الثانية

تسجيل الإيداع يحتاج رمز تجديد بصلاحيات الكتابة. كرر الخطوة «3 مكرر» بهذه الصلاحيات معاً، مفصولة بفاصلة دون مسافات:

```
ZohoBooks.customerpayments.READ,ZohoBooks.customerpayments.UPDATE,ZohoBooks.banking.CREATE,ZohoBooks.banking.READ,ZohoBooks.banking.DELETE
```

الدالة `exchangeCode` تستبدل رمز التجديد القديم بالجديد. لا حاجة لنشر نسخة جديدة من السكربت ولا لتغيير شيء في كلاود فلير.

## تحديث الشيفرة بعد نسخة سابقة

إن كنت أنشأت الوسيط بنسخة سابقة من الشيفرة: الصق الشيفرة الجديدة كاملة مكان القديمة واحفظ، ثم انشر نسخة جديدة كما في القسم التالي.

## تعديل السكربت لاحقاً

بعد أي تعديل على الشيفرة في غوغل: «Deploy»، ثم «Manage deployments»، ثم أيقونة القلم، ثم «Version: New version»، ثم «Deploy». الرابط يبقى نفسه.

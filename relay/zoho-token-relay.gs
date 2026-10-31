/**
 * وسيط تجديد رمز زوهو لتطبيق «شيكاتي»
 *
 * لماذا: خوادم كلاود فلير لا تصل إلى خادم الرموز الأمريكي لزوهو (الخطأ 1016)،
 * فيجدّد هذا السكربت رمز الوصول من خوادم غوغل ويعيده للتطبيق.
 *
 * ما يفعله فقط: يجدّد رمز الوصول ويعيده لمن يرسل المفتاح المشترك الصحيح.
 * لا يقرأ ولا يكتب أي بيانات في زوهو بوكس.
 *
 * الإعداد: خصائص السكربت (Project Settings → Script Properties):
 *   RELAY_KEY            مفتاح مشترك طويل، 32 حرفاً على الأقل (نفسه في كلاود فلير)
 *   ZOHO_CLIENT_ID       معرّف عميل (Self Client)
 *   ZOHO_CLIENT_SECRET   سر العميل
 *   ZOHO_REFRESH_TOKEN   رمز التجديد (تملؤه الدالة exchangeCode تلقائياً)
 *
 * للحصول على رمز التجديد: ضع الرمز المؤقت من لوحة مطوري زوهو في الخاصية ZOHO_CODE،
 * ثم شغّل الدالة exchangeCode من المحرر. تحفظ رمز التجديد وتحذف الرمز المؤقت.
 */

var ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token';

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var relayKey = (props.getProperty('RELAY_KEY') || '').trim();
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }

  if (relayKey.length < 32 || !safeEqual_(String(body.key || ''), relayKey)) {
    return out_({ error: 'forbidden' });
  }

  var cache = CacheService.getScriptCache();
  if (!body.force) {
    var cached = cache.get('token');
    if (cached) {
      var c = JSON.parse(cached);
      var left = Math.floor((c.exp - Date.now()) / 1000);
      if (left > 120) return out_({ access_token: c.token, expires_in: left });
    }
  }

  var res = UrlFetchApp.fetch(ZOHO_TOKEN_URL, {
    method: 'post',
    payload: {
      refresh_token: (props.getProperty('ZOHO_REFRESH_TOKEN') || '').trim(),
      client_id: (props.getProperty('ZOHO_CLIENT_ID') || '').trim(),
      client_secret: (props.getProperty('ZOHO_CLIENT_SECRET') || '').trim(),
      grant_type: 'refresh_token'
    },
    muteHttpExceptions: true
  });

  var d = {};
  try { d = JSON.parse(res.getContentText()); } catch (err) { d = {}; }
  if (!d.access_token) {
    // رمز الخطأ فقط، دون أي محتوى آخر من الرد
    var code = /^[a-z_]{3,40}$/.test(String(d.error || '')) ? d.error : ('HTTP ' + res.getResponseCode());
    return out_({ error: code });
  }

  var expiresIn = Number(d.expires_in) || 3600;
  cache.put('token', JSON.stringify({ token: d.access_token, exp: Date.now() + expiresIn * 1000 }),
            Math.max(60, Math.min(21600, expiresIn - 300)));
  return out_({ access_token: d.access_token, expires_in: expiresIn });
}

// تُشغَّل يدوياً من المحرر: تستبدل الرمز المؤقت برمز تجديد وتحفظه في خصائص السكربت.
// لا تطبع أي رمز في السجل، فقط النتيجة.
function exchangeCode() {
  var props = PropertiesService.getScriptProperties();
  var code = (props.getProperty('ZOHO_CODE') || '').trim();
  if (!code) {
    Logger.log('خطأ: الخاصية ZOHO_CODE فارغة. ضع فيها الرمز المؤقت من لوحة مطوري زوهو.');
    return;
  }
  var res = UrlFetchApp.fetch(ZOHO_TOKEN_URL, {
    method: 'post',
    payload: {
      code: code,
      client_id: (props.getProperty('ZOHO_CLIENT_ID') || '').trim(),
      client_secret: (props.getProperty('ZOHO_CLIENT_SECRET') || '').trim(),
      grant_type: 'authorization_code'
    },
    muteHttpExceptions: true
  });
  var d = {};
  try { d = JSON.parse(res.getContentText()); } catch (err) { d = {}; }
  props.deleteProperty('ZOHO_CODE');
  if (!d.refresh_token) {
    Logger.log('خطأ من زوهو: ' + (d.error || ('HTTP ' + res.getResponseCode())) +
      '. إن كان invalid_code فالرمز المؤقت انتهت مدته أو استُعمل: أنشئ رمزاً جديداً وأعد المحاولة.');
    return;
  }
  props.setProperty('ZOHO_REFRESH_TOKEN', d.refresh_token);
  CacheService.getScriptCache().remove('token');
  Logger.log('تم حفظ رمز التجديد. الصلاحيات: ' + (d.scope || '؟') + ' — مركز البيانات: ' + (d.api_domain || '؟'));
}

// لا نقبل الطلبات العادية من المتصفح
function doGet() {
  return out_({ error: 'forbidden' });
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

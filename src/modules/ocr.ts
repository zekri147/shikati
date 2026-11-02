import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../env';
import { HttpError } from '../http';

// قراءة صورة الشيك بواجهة كلود، كما كان يفعل بوت تيليجرام: المبلغ والرقم فقط.
// العميل لا يُقرأ آلياً بطلب ZEKRI، بل يختاره الموظف بالبحث.
// النتيجة اقتراح فقط: الموظف يراجعها ويصححها قبل أي كتابة في زوهو.

const MODEL = 'claude-opus-5-5';
const MAX_IMAGE_BYTES = 4_500_000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

export interface ChequeReading {
  amount: number | null;
  cheque_number: string | null;
  // ملاحظة قصيرة من القارئ إن كانت الصورة غير واضحة أو فيها تعارض
  note: string | null;
  // كم درجة تُدار الصورة باتجاه عقارب الساعة ليظهر الشيك معتدلاً
  rotation: Rotation;
}

export type Rotation = 0 | 90 | 180 | 270;
const ROTATION = { type: 'string', enum: ['0', '90', '180', '270'], description: 'كم درجة تُدار الصورة باتجاه عقارب الساعة ليصبح نص الشيك أفقياً مقروءاً من الأعلى' };
const toRotation = (v: unknown): Rotation => (['90', '180', '270'].includes(String(v)) ? (Number(v) as Rotation) : 0);

// صيغة بسيطة بأنواع ثابتة فقط: «غير مقروء» يُكتب 0 للمبلغ ونصاً فارغاً لغيره
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['amount', 'cheque_number', 'note', 'rotation'],
  properties: {
    amount: { type: 'number', description: 'المبلغ بالدينار الجزائري، مثل 366600.39. صفر إن لم يُقرأ' },
    cheque_number: { type: 'string', description: 'رقم الشيك أرقاماً فقط، أو نص فارغ' },
    note: { type: 'string', description: 'ملاحظة قصيرة بالعربية إن كان شيء غير واضح، أو نص فارغ' },
    rotation: ROTATION,
  },
};

const PROMPT = `هذه صورة شيك بنكي جزائري استلمته شركة إيلوناك من عميل.
استخرج منها:
- amount: المبلغ بالأرقام. إن اختلف المبلغ بالأرقام عن المبلغ بالحروف، خذ المبلغ بالحروف واذكر ذلك في note.
- cheque_number: رقم الشيك المطبوع (عادة 7 أرقام). أرقام فقط، دون مسافات.
- note: اكتب ملاحظة قصيرة فقط إن كان جزء غير مقروء أو مشكوك فيه، وإلا نصاً فارغاً.
- rotation: كم درجة يجب تدوير الصورة باتجاه عقارب الساعة (0 أو 90 أو 180 أو 270) ليظهر الشيك أفقياً ونصه معتدلاً.
الصورة قد تكون مقلوبة أو مائلة، فاقرأها في أي اتجاه.
أي حقل لا تستطيع قراءته بثقة: اكتب 0 للمبلغ ونصاً فارغاً لغيره، بدل التخمين.`;

export function readerConfigured(env: Env): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

// الصورة تصل من الهاتف بصيغة data URL بعد تصغيرها هناك
export function parseImage(dataUrl: unknown): { type: ImageType; data: string } {
  const m = String(dataUrl ?? '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new HttpError(400, 'صيغة الصورة غير مقبولة.');
  const type = m[1] as ImageType;
  if (m[2].length * 0.75 > MAX_IMAGE_BYTES) throw new HttpError(413, 'الصورة كبيرة جداً.');
  return { type, data: m[2] };
}

const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);

// verbose: يضيف للمدير رمز الخطأ ورسالة الواجهة، لتشخيص أي مشكلة دون فتح سجلات كلاود فلير
export async function readCheque(env: Env, image: { type: ImageType; data: string }, verbose = false): Promise<ChequeReading> {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'القراءة الآلية غير مُعدّة بعد. اكتب البيانات بيدك.');
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    timeout: 60_000,
    maxRetries: 1,
  });

  let res;
  try {
    res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.type, data: image.data } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      console.error('anthropic auth failed');
      throw new HttpError(503, 'مفتاح واجهة كلود غير صالح. أخبر المدير، واكتب البيانات بيدك.');
    }
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(503, 'خدمة القراءة مشغولة الآن. حاول بعد دقيقة، أو اكتب البيانات بيدك.');
    if (e instanceof Anthropic.APIError) {
      console.error('anthropic error', e.status, e.message);
      const detail = verbose ? ` (${e.status ?? '—'}: ${String(e.message).slice(0, 300)})` : ` (${e.status ?? '—'})`;
      throw new HttpError(502, 'تعذّرت قراءة الصورة. اكتب البيانات بيدك.' + detail);
    }
    console.error('anthropic request failed', e instanceof Error ? e.name : e);
    throw new HttpError(504, 'خدمة القراءة لم ترد. اكتب البيانات بيدك.');
  }

  if (res.stop_reason === 'refusal') throw new HttpError(422, 'تعذّرت قراءة هذه الصورة. اكتب البيانات بيدك.');
  const text = res.content.find((b) => b.type === 'text');
  let out: Record<string, unknown> = {};
  try {
    out = JSON.parse(text && text.type === 'text' ? text.text : '{}');
  } catch {
    throw new HttpError(502, 'جاءت القراءة بصيغة غير متوقعة. اكتب البيانات بيدك.');
  }
  const amount = typeof out.amount === 'number' && Number.isFinite(out.amount) && out.amount > 0
    ? Math.round(out.amount * 100) / 100 : null;
  const num = clean(out.cheque_number)?.replace(/\D/g, '') || null;
  return { amount, cheque_number: num, note: clean(out.note), rotation: toRotation(out.rotation) };
}

const ORIENT_SCHEMA = { type: 'object', additionalProperties: false, required: ['rotation'], properties: { rotation: ROTATION } };
const ORIENT_PROMPT = `هذه صورة شيك بنكي. قد تكون مصوّرة والهاتف عمودي، فيظهر الشيك مائلاً أو مقلوباً.
كم درجة يجب تدوير الصورة باتجاه عقارب الساعة (0 أو 90 أو 180 أو 270) ليظهر الشيك أفقياً ونصه المطبوع معتدلاً ومقروءاً؟`;

// اتجاه الصورة فقط، لعرض الصور القديمة معتدلة. يعيد null إن تعذّر، فتُعرض الصورة كما هي.
export async function readOrientation(env: Env, image: { type: ImageType; data: string }): Promise<Rotation | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, timeout: 45_000, maxRetries: 1 });
  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ORIENT_SCHEMA } },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: image.type, data: image.data } },
        { type: 'text', text: ORIENT_PROMPT },
      ] }],
    });
    if (res.stop_reason === 'refusal') return null;
    const text = res.content.find((b) => b.type === 'text');
    const out = JSON.parse(text && text.type === 'text' ? text.text : '{}') as { rotation?: unknown };
    return toRotation(out.rotation);
  } catch (e) {
    console.error('orientation failed', e instanceof Error ? e.name : e);
    return null;
  }
}

export function isReadableType(t: string): t is ImageType {
  return (IMAGE_TYPES as readonly string[]).includes(t);
}

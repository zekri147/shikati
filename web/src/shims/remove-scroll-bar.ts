// بديل محلي لمكتبة react-remove-scroll-bar التي تستعملها نوافذ Radix.
// الأصلية تضيف وسم <style> إلى الصفحة لقفل التمرير، وسياسة أمان المحتوى (style-src 'self') تمنعه.
// قفل التمرير صار قاعدة ثابتة في index.css: body:has([role=dialog][data-state=open]).
// منع التمرير باللمس خارج النافذة يبقى من react-remove-scroll نفسها (بالشيفرة، لا بوسم style).
export const zeroRightClassName = 'right-scroll-bar-position';
export const fullWidthClassName = 'width-before-scroll-bar';
export const noScrollbarsClassName = 'with-scroll-bars-hidden';
export const removedBarSizeVariable = '--removed-body-scroll-bar-size';
export const getGapWidth = () => ({ left: 0, top: 0, right: 0, gap: 0 });
export const RemoveScrollBar = () => null;

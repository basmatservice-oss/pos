/**
 * Store product thumbnails at a bounded size instead of persisting full camera
 * images as multi-megabyte data URLs inside the SQLite product JSON record.
 * Existing images are left untouched; Android's native reader handles those
 * legacy oversized records without CursorWindow overflow.
 */
export async function compressProductImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('الملف المحدد ليس صورة');
  if (file.size > 25 * 1024 * 1024) throw new Error('حجم الصورة أكبر من الحد المسموح (25 ميجابايت)');

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('تعذر فتح الصورة المحددة'));
      element.src = objectUrl;
    });
    const maxEdge = 640;
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('تعذر تجهيز الصورة للحفظ');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.78);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

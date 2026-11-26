/** Standard base-unit dimensions used to keep product unit metadata consistent. */
const UNIT_DIMENSIONS = {
  piece: 'count', pair: 'count', dozen: 'count', set: 'count', pack: 'count',
  bundle: 'count', ream: 'count', box: 'count', carton: 'count', sack: 'count', roll: 'count',
  'جرام': 'weight', 'كجم': 'weight', 'كيلوجرام': 'weight', 'طن': 'weight', g: 'weight', kg: 'weight',
  'ملليلتر': 'volume', 'مل': 'volume', 'لتر': 'volume', 'متر مكعب': 'volume', ml: 'volume', liter: 'volume', m3: 'volume',
  'ملليمتر': 'length', 'سنتيمتر': 'length', 'متر': 'length', 'كيلومتر': 'length', mm: 'length', cm: 'length', m: 'length',
  'متر مربع': 'area', 'سنتيمتر مربع': 'area', m2: 'area',
  'دقيقة': 'time', 'ساعة': 'time', 'يوم': 'time',
};

export function getBaseUnitDimension(unitName) {
  const key = String(unitName || '').trim().toLocaleLowerCase();
  return UNIT_DIMENSIONS[key] || 'legacy';
}

export function getStandardBaseUnits() {
  return Object.entries(UNIT_DIMENSIONS).map(([name, dimension]) => ({ name, dimension }));
}

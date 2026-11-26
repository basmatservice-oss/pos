/** Standard base-unit dimensions used to keep product unit metadata consistent. */
const UNIT_DIMENSIONS = {
  piece: 'count', pair: 'count', dozen: 'count', set: 'count', pack: 'count',
  bundle: 'count', ream: 'count', box: 'count', carton: 'count', sack: 'count', roll: 'count',
  'جرام': 'weight', 'كجم': 'weight', 'كيلوجرام': 'weight', 'طن': 'weight',
  'ملليلتر': 'volume', 'مل': 'volume', 'لتر': 'volume', 'متر مكعب': 'volume',
  'ملليمتر': 'length', 'سنتيمتر': 'length', 'متر': 'length', 'كيلومتر': 'length',
  'متر مربع': 'area', 'سنتيمتر مربع': 'area',
  'دقيقة': 'time', 'ساعة': 'time', 'يوم': 'time',
};

export function getBaseUnitDimension(unitName) {
  const key = String(unitName || '').trim().toLocaleLowerCase();
  return UNIT_DIMENSIONS[key] || 'legacy';
}

export function getStandardBaseUnits() {
  return Object.entries(UNIT_DIMENSIONS).map(([name, dimension]) => ({ name, dimension }));
}

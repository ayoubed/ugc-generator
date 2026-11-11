/**
 * The Asset Bible: one fixed description each of the products and props, the speaker and the
 * setting. The API adds it word for word to every scene's video prompt (see
 * backend/app/pipeline.py ASSET_BIBLE_FIELDS), so things like a product's colour stay the same
 * from scene to scene. Keys must match the backend's AssetBible model. Camera, lighting and
 * visual style are not here: the sidebar guidelines set those.
 *
 * `wide` fields take the full row in the editor.
 */
export const ASSET_BIBLE_FIELDS = [
  {
    key: 'hero_props',
    label: 'Products and props',
    wide: true,
    placeholder: 'e.g. Matte black watch box with 3 watches: a gold chronograph, a silver diver with a blue dial, a white ceramic minimalist. The lid reads "NORTH & CO" in white capitals.',
  },
  {
    key: 'character',
    label: 'Speaker',
    placeholder: 'e.g. Woman in her late 20s, shoulder-length wavy brown hair, oversized cream knit sweater, small gold hoop earrings.',
  },
  {
    key: 'setting',
    label: 'Setting',
    placeholder: 'e.g. Small bedroom, light oak desk against a white wall, a monstera plant on the left.',
  },
  {
    key: 'voice',
    label: 'Voice',
    placeholder: 'e.g. Woman in her late 20s, warm mid-pitched voice, quick and upbeat, phone microphone in a slightly roomy bedroom.',
  },
];

/** Always an object with every field as a string. */
export function normalizeAssetBible(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(ASSET_BIBLE_FIELDS.map(({ key }) => [key, String(source[key] ?? '')]));
}

/** How many fields have text. */
export function assetBibleFilledCount(value) {
  const ab = normalizeAssetBible(value);
  return ASSET_BIBLE_FIELDS.filter(({ key }) => ab[key].trim()).length;
}

/** Whether two Asset Bibles would produce the same prompt (spacing differences ignored). */
export function sameAssetBible(a, b) {
  const x = normalizeAssetBible(a);
  const y = normalizeAssetBible(b);
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  return ASSET_BIBLE_FIELDS.every(({ key }) => squash(x[key]) === squash(y[key]));
}

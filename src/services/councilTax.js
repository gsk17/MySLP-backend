import { CouncilTaxProperty } from '../models/CouncilTaxProperty.js';
import { normaliseAddress, normalisePostcode } from '../utils/normalise.js';


export async function lookupCouncilTaxBand(params, options = {}) {
  const addressNorm = params.fulladdress ? normaliseAddress(params.fulladdress) : '';
  const postcodeNorm = params.postcode ? normalisePostcode(params.postcode) : '';

  // The caller may have appended the postcode to the address; strip it so the
  // address comparison still lines up with the stored value.
  const addressWithoutPostcode =
    postcodeNorm && addressNorm
      ? normaliseAddress(
          addressNorm.replace(new RegExp(normaliseAddress(params.postcode ?? ''), 'gi'), ''),
        )
      : addressNorm;
  const candidates = [addressNorm, addressWithoutPostcode].filter(Boolean);

  // 1. Address + postcode together — the most precise match.
  if (candidates.length && postcodeNorm) {
    const match = await CouncilTaxProperty.findOne({
      addressNormalised: {
        $in: candidates,
      },
      postcodeNormalised: postcodeNorm,
    });
    if (match) return match;
  }

  // 2. Address alone.
  if (candidates.length) {
    const match = await CouncilTaxProperty.findOne({
      addressNormalised: {
        $in: candidates,
      },
    });
    if (match) return match;
  }

  // 3. Postcode alone — only when it identifies exactly one property.
  if (postcodeNorm && !candidates.length) {
    const matches = await CouncilTaxProperty.find({
      postcodeNormalised: postcodeNorm,
    }).limit(2);
    if (matches.length === 1) return matches[0];
  }

  // 4. Substring fallback: the caller's address contains, or is contained by,
  //    a stored address (e.g. missing or extra "Shangri-La").
  if (candidates.length) {
    const scope = postcodeNorm
      ? {
          postcodeNormalised: postcodeNorm,
        }
      : {};
    const all = await CouncilTaxProperty.find(scope);
    for (const candidate of candidates) {
      const hit = all.find(
        (p) => p.addressNormalised.includes(candidate) || candidate.includes(p.addressNormalised),
      );
      if (hit) return hit;
    }
  }

  // 5. Last resort, and only for the app's own forms: the address did not match anything, but the postcode identifies exactly one property.
  if (options.allowPostcodeOnly && postcodeNorm) {
    const matches = await CouncilTaxProperty.find({
      postcodeNormalised: postcodeNorm,
    }).limit(2);
    if (matches.length === 1) return matches[0];
  }

  return null;
}

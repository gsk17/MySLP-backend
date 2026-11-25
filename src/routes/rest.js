import { Router } from 'express';
import { config } from '../config.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { publicApiLimiter } from '../middleware/rateLimit.js';
import { badRequest } from '../utils/errors.js';
import { lookupCouncilTaxBand } from '../services/councilTax.js';
import { averageEnergyCostPerDay } from '../services/statistics.js';
import { formatStatNumber, normaliseAddress, normalisePostcode } from '../utils/normalise.js';

const router = Router();
router.use(publicApiLimiter);

// ---------------------------------------------------------------------------
// GET /rest/council_tax_check?postcode=LE17RH&fulladdress=20 University Road, Shangri-La
// ---------------------------------------------------------------------------
router.get(
  '/council_tax_check',
  asyncHandler(async (req, res) => {
    const fulladdressRaw = firstString(req.query.fulladdress);
    const postcodeRaw = firstString(req.query.postcode);
    const hasAddress = !!normaliseAddress(fulladdressRaw);
    const hasPostcode = !!normalisePostcode(postcodeRaw);
    if (!hasAddress && !hasPostcode) {
      throw badRequest(
        'MISSING_PARAMETERS',
        'Provide at least one of `fulladdress` or `postcode`.',
      );
    }
    const property = await lookupCouncilTaxBand({
      fulladdress: fulladdressRaw,
      postcode: postcodeRaw,
    });
    if (!property) {
      res.status(404).json({
        error: 'Address not found',
      });
      return;
    }
    res.json({
      address: property.fullAddress,
      council_tax_band: property.councilTaxBand,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /rest/statistics/:band/:prefix      
// ---------------------------------------------------------------------------
router.get(
  '/statistics/:band/:prefix',
  asyncHandler(async (req, res) => {
    const band = String(req.params.band ?? '')
      .trim()
      .toUpperCase();
    const prefix = normalisePostcode(String(req.params.prefix ?? ''));
    if (!/^[A-H]$/.test(band)) {
      throw badRequest(
        'INVALID_BAND',
        'Council tax band must be a single letter from A to H.',
        'band',
      );
    }
    if (!/^[A-Z0-9]{2,4}$/.test(prefix)) {
      throw badRequest(
        'INVALID_POSTCODE_PREFIX',
        'Postcode prefix must be 2 to 4 letters or digits.',
        'prefix',
      );
    }
    const { average, propertiesMatched, billsCounted } = await averageEnergyCostPerDay(
      band,
      prefix,
    );
    res.json({
      counil_tax_band: band,
      council_tax_band: band,
      postcode_prefix: String(req.params.prefix ?? '')
        .trim()
        .toUpperCase(),
      average_electricity_gas_cost_per_day: formatStatNumber(average),
      currency: config.restCurrency,
      properties_matched: propertiesMatched,
      bills_counted: billsCounted,
    });
  }),
);

// ---------------------------------------------------------------------------
// Helpful JSON for a /rest/statistics call missing a segment, instead of a 404.
// ---------------------------------------------------------------------------
router.get('/statistics/:band?', (req, _res, next) => {
  next(
    badRequest(
      'MISSING_PARAMETERS',
      'Use /rest/statistics/{council_tax_band}/{postcode_prefix}, for example /rest/statistics/A/LE2.',
    ),
  );
});
function firstString(value) {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}
export default router;
